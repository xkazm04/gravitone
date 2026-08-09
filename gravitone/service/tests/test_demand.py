"""Fallback demand telemetry, tested on its own terms.

`service/demand.py` is the coverage loop's only input: it counts the emotions
real traffic asked a Character for and did not get, the studio renders that as
heat on empty slots, and `derive_autofill` fills the hottest of them. Until this
file it was only ever exercised INCIDENTALLY -- through handler-mode tests,
recording tests, registry-cache tests -- which is how a locking bug survives:
every one of those exercises the happy path from above, and none of them ever
holds the lock, corrupts the file, or asks what an emotion name is.

Three things are pinned here, and all three found something:

  * **The cross-process lock is real.** The service ships as N single-worker
    processes, so a `threading.Lock` serializes nothing between replicas and the
    `atomicio.file_lock` sentinel is the only thing that does. It is asserted by
    HOLDING the sentinel from outside and watching a write wait for it, not by
    reading the source.
  * **`record_fallback` never raises.** Its docstring promises telemetry cannot
    break synthesis. It could: a store containing non-UTF-8 bytes raised
    `UnicodeDecodeError` (a `ValueError`, NOT an `OSError`) straight through the
    handler, and a store whose character branch was not a dict raised
    `AttributeError` inside the lock. Both are fixed; both are pinned below.
  * **A corrupt store is REPORTED, not silently zeroed** -- the bar
    `test_direction` sets for its own store.
"""
from __future__ import annotations

import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from service import demand
from service.atomicio import file_lock


class _StoreCase(unittest.TestCase):
    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        self._orig = demand.DEMAND_PATH
        demand.DEMAND_PATH = Path(self._td.name) / "emotion_demand.json"

    def tearDown(self) -> None:
        demand.DEMAND_PATH = self._orig
        self._td.cleanup()

    def store(self) -> dict:
        return json.loads(demand.DEMAND_PATH.read_text("utf-8"))


# -- what counts as an emotion -------------------------------------------------
class EmotionFilterTests(_StoreCase):
    """`_EMOTION_RE` is `^[a-z_]{1,32}$`, and its edges are the contract.

    The filter is not decoration: this file is a public-ish surface (the roster
    renders its keys) fed by whatever string an API caller put in a metatag, so
    the boundary between "an emotion we will count" and "someone's payload" is
    exactly this regex.
    """

    def test_a_plain_emotion_is_counted(self) -> None:
        demand.record_fallback("ann", "angry")
        self.assertEqual(demand.demand_for("ann"), {"angry": 1})

    def test_case_and_surrounding_space_are_normalised_before_the_filter(self) -> None:
        demand.record_fallback("ann", "  ANGRY \n")
        self.assertEqual(demand.demand_for("ann"), {"angry": 1})

    def test_underscores_are_allowed_anywhere_including_the_edges(self) -> None:
        for emotion in ("battle_cry", "_leading", "trailing_", "_"):
            with self.subTest(emotion=emotion):
                demand.record_fallback("ann", emotion)
        self.assertEqual(sorted(demand.demand_for("ann")),
                         ["_", "_leading", "battle_cry", "trailing_"])

    def test_thirty_two_characters_is_in_and_thirty_three_is_out(self) -> None:
        demand.record_fallback("ann", "a" * 32)
        demand.record_fallback("ann", "b" * 33)
        self.assertEqual(demand.demand_for("ann"), {"a" * 32: 1})

    def test_everything_that_is_not_lowercase_letters_or_underscore_is_dropped(self) -> None:
        for emotion in ("", "   ", "angry2", "angry-ish", "angry.ish", "angry ish",
                        "angry!", "ángry", "a/b", "angry\n\nx"):
            with self.subTest(emotion=emotion):
                demand.record_fallback("ann", emotion)
        self.assertEqual(demand.demand_for("ann"), {})
        # Nothing rejected may even create the file: a store that exists but is
        # empty and a store that was never written read the same, but only one
        # of them means a write path ran.
        self.assertFalse(demand.DEMAND_PATH.exists())

    def test_baseline_is_never_demand(self) -> None:
        # baseline is what fallback falls back TO. Counting it would put heat on
        # the one slot that by definition is not missing.
        demand.record_fallback("ann", "baseline")
        self.assertEqual(demand.demand_for("ann"), {})

    def test_a_none_emotion_is_dropped_rather_than_crashing_the_caller(self) -> None:
        demand.record_fallback("ann", None)  # type: ignore[arg-type]
        self.assertEqual(demand.demand_for("ann"), {})


# -- exclusion -----------------------------------------------------------------
class LockingTests(_StoreCase):
    def test_the_write_waits_for_the_cross_process_sentinel(self) -> None:
        """Held from OUTSIDE this process's `threading.Lock`, as a replica would.

        The thread lock cannot see this: the sentinel file is the only thing
        standing between two replicas doing a read-modify-write on the same
        JSON, and a regression to "thread lock only" makes this test's write
        land immediately instead of waiting.
        """
        demand.record_fallback("ann", "angry")
        released = threading.Event()
        landed = threading.Event()

        def writer() -> None:
            demand.record_fallback("ann", "angry")
            landed.set()

        with file_lock(demand._lock_path()):
            t = threading.Thread(target=writer, daemon=True)
            t.start()
            # While the sentinel is held the second count cannot appear.
            time.sleep(0.25)
            self.assertFalse(landed.is_set())
            self.assertEqual(self.store()["ann"]["angry"], 1)
            released.set()
        t.join(timeout=10)
        self.assertTrue(released.is_set())
        self.assertTrue(landed.is_set(), "the write never completed after release")
        self.assertEqual(self.store()["ann"]["angry"], 2)

    def test_the_lock_it_takes_follows_a_redirected_store(self) -> None:
        # Deployments and tests both move DEMAND_PATH; a lock path captured at
        # import time would serialize the wrong file (or nothing at all).
        taken: list[Path] = []
        real = demand.file_lock

        def spy(path, *a, **kw):
            taken.append(Path(path))
            return real(path, *a, **kw)

        with mock.patch.object(demand, "file_lock", spy):
            demand.record_fallback("ann", "angry")
        self.assertEqual(taken, [demand.DEMAND_PATH.with_name(
            ".emotion_demand.json.lock")])

    def test_concurrent_writers_lose_no_counts(self) -> None:
        """8 threads x 25 increments must be exactly 200.

        A read-modify-write without exclusion loses whatever the loser
        accumulated between its read and its write, which is the failure this
        store used to document: not "an increment", but every count a replica
        held.
        """
        errors: list[BaseException] = []

        def bump() -> None:
            try:
                for _ in range(25):
                    demand.record_fallback("ann", "angry")
            except BaseException as exc:  # noqa: BLE001 - reported, not swallowed
                errors.append(exc)

        threads = [threading.Thread(target=bump) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=60)
        self.assertEqual(errors, [])
        self.assertEqual(demand.demand_for("ann"), {"angry": 200})

    def test_a_wedged_lock_costs_a_count_and_says_so_but_never_the_request(self) -> None:
        # TimeoutError is an OSError; the promise is that a caller mid-synthesis
        # never sees it, and that the lost count is logged rather than silent.
        with mock.patch.object(demand, "file_lock",
                               side_effect=TimeoutError("could not acquire")):
            with self.assertLogs("service.demand", level="WARNING") as logs:
                demand.record_fallback("ann", "angry")
        self.assertIn("not recorded", "\n".join(logs.output))
        self.assertEqual(demand.demand_for("ann"), {})


# -- a store that has gone wrong -----------------------------------------------
class CorruptStoreTests(_StoreCase):
    def test_malformed_json_is_reported_not_silently_zeroed(self) -> None:
        demand.DEMAND_PATH.write_text('{"ann": {"angry": 3', "utf-8")
        with self.assertLogs("service.demand", level="WARNING"):
            self.assertEqual(demand.all_demand(), {})
        # and a later write still lands, re-establishing the file
        demand.record_fallback("ann", "angry")
        self.assertEqual(demand.demand_for("ann"), {"angry": 1})

    def test_bytes_that_are_not_utf8_do_not_escape_as_a_valueerror(self) -> None:
        """The defect this file found: `read_text` raises `UnicodeDecodeError`,
        which is a `ValueError` and NOT an `OSError`, so it went straight past
        `record_fallback`'s handler and out of `all_demand()` into the roster."""
        demand.DEMAND_PATH.write_bytes(b'{"ann": {"angry": \xff\xfe}}')
        with self.assertLogs("service.demand", level="WARNING"):
            self.assertEqual(demand.all_demand(), {})
        with self.assertLogs("service.demand", level="WARNING"):
            demand.record_fallback("ann", "angry")
        self.assertEqual(demand.demand_for("ann"), {"angry": 1})

    def test_an_unreadable_store_reads_as_empty_rather_than_raising(self) -> None:
        with mock.patch.object(Path, "read_text",
                               side_effect=OSError("permission denied")):
            demand.DEMAND_PATH.write_bytes(b"{}")
            with self.assertLogs("service.demand", level="WARNING"):
                self.assertEqual(demand.all_demand(), {})

    def test_valid_json_of_the_wrong_shape_reads_as_no_demand(self) -> None:
        for payload in ("[1, 2, 3]", '"a string"', "null", "7"):
            with self.subTest(payload=payload):
                demand.DEMAND_PATH.write_text(payload, "utf-8")
                self.assertEqual(demand.all_demand(), {})
                self.assertEqual(demand.demand_for("ann"), {})

    def test_a_character_branch_that_is_not_a_dict_is_replaced_not_crashed_on(self) -> None:
        """The second defect: `data.setdefault(cid, {})` returns the EXISTING
        value, so a branch of `5` made `.get` an `AttributeError` inside the
        lock -- uncaught, mid-synthesis."""
        demand.DEMAND_PATH.write_text('{"ann": 5, "bob": {"sad": 2}}', "utf-8")
        demand.record_fallback("ann", "angry")
        self.assertEqual(demand.demand_for("ann"), {"angry": 1})
        # the healthy neighbour is untouched
        self.assertEqual(demand.demand_for("bob"), {"sad": 2})

    def test_a_count_that_is_not_a_number_restarts_from_zero_without_raising(self) -> None:
        demand.DEMAND_PATH.write_text('{"ann": {"angry": "lots", "sad": true}}', "utf-8")
        demand.record_fallback("ann", "angry")
        demand.record_fallback("ann", "sad")
        # `true` is an int in Python and would have counted as 1 -- it is not a
        # count, so it reads as none.
        self.assertEqual(demand.demand_for("ann"), {"angry": 1, "sad": 1})

    def test_demand_for_reports_only_real_counts(self) -> None:
        demand.DEMAND_PATH.write_text(
            '{"ann": {"angry": 3, "sad": 0, "odd": "x", "flag": false}}', "utf-8")
        self.assertEqual(demand.demand_for("ann"), {"angry": 3})

    def test_demand_for_accepts_a_prefetched_snapshot(self) -> None:
        # The roster reads the file ONCE and passes it down; that path must
        # behave identically to the per-call read, including its guards.
        snapshot = {"ann": {"angry": 2}, "bob": 5}
        self.assertEqual(demand.demand_for("ann", snapshot), {"angry": 2})
        self.assertEqual(demand.demand_for("bob", snapshot), {})
        self.assertEqual(demand.demand_for("nobody", snapshot), {})


class StoreShapeTests(_StoreCase):
    def test_counts_are_kept_per_character(self) -> None:
        demand.record_fallback("ann", "angry")
        demand.record_fallback("ann", "angry")
        demand.record_fallback("bob", "angry")
        self.assertEqual(demand.all_demand(),
                         {"ann": {"angry": 2}, "bob": {"angry": 1}})

    def test_the_store_is_written_atomically_and_leaves_no_temp_behind(self) -> None:
        demand.record_fallback("ann", "angry")
        strays = [p.name for p in demand.DEMAND_PATH.parent.iterdir()
                  if p.name != demand.DEMAND_PATH.name]
        self.assertEqual(strays, [], f"left behind: {strays}")

    def test_a_missing_store_is_no_demand_not_an_error(self) -> None:
        self.assertFalse(demand.DEMAND_PATH.exists())
        self.assertEqual(demand.all_demand(), {})
        self.assertEqual(demand.demand_for("ann"), {})


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
