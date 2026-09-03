"""Takes + review sets + pack import — first error-path coverage for the two
routers that had none. Store dirs are pointed at a temp dir per test, so
nothing touches the real voices/takes data."""
from __future__ import annotations

import io
import json
import os
import tempfile
import time
import unittest
import zipfile
from pathlib import Path

from service.tests import fake_engine  # installs shims — must precede app import

import service.app as appmod
import service.direction as direction
import service.takes as takes
from fastapi import HTTPException
from fastapi.testclient import TestClient

WAV = b"RIFF" + b"\x00" * 40  # enough to pass the RIFF sniff


class _TakesBase(unittest.TestCase):
    def setUp(self) -> None:
        self._td = tempfile.TemporaryDirectory()
        root = Path(self._td.name)
        self._orig = (takes.TAKES_DIR, takes.REVIEWS_DIR, direction.DIRECTION_PATH)
        takes.TAKES_DIR = root / "takes"
        takes.REVIEWS_DIR = root / "reviews"
        direction.DIRECTION_PATH = root / "direction_deltas.json"
        self.client = TestClient(appmod.app, raise_server_exceptions=False)

    def tearDown(self) -> None:
        takes.TAKES_DIR, takes.REVIEWS_DIR, direction.DIRECTION_PATH = self._orig
        self._td.cleanup()

    def _create_take(self, text: str = "Hello there.", **meta) -> str:
        payload = {"text": text, "segments": [], "character_id": "sarah"}
        payload.update(meta)
        resp = self.client.post(
            "/v1/takes",
            files={"file": ("t.wav", WAV, "audio/wav")},
            data={"meta": json.dumps(payload)},
        )
        self.assertEqual(resp.status_code, 201, resp.text)
        return resp.json()["take_id"]

    def _write_take(self, take_id: str, parent_id: str | None = None,
                    age: float = 0.0) -> str:
        """A take straight onto disk, with a controllable mtime — eviction
        order is by mtime and the API cannot mint two takes a minute apart."""
        takes.TAKES_DIR.mkdir(parents=True, exist_ok=True)
        record = {"id": take_id, "character_id": "sarah", "character_name": "Sarah",
                  "text": "line", "seconds": 1.0, "rtf": 0.1, "segments": [],
                  "created": "2026-01-01T00:00:00+00:00", "parent_id": parent_id,
                  "derived_from": None}
        (takes.TAKES_DIR / f"{take_id}.json").write_text(json.dumps(record), "utf-8")
        (takes.TAKES_DIR / f"{take_id}.wav").write_bytes(WAV)
        when = time.time() - age
        for suffix in (".json", ".wav"):
            os.utime(takes.TAKES_DIR / f"{take_id}{suffix}", (when, when))
        return take_id


class TakesErrorTests(_TakesBase):
    def test_bad_meta_json_is_400(self) -> None:
        resp = self.client.post(
            "/v1/takes", files={"file": ("t.wav", WAV, "audio/wav")},
            data={"meta": "not json"})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("JSON", resp.json()["detail"])

    def test_non_wav_audio_is_400(self) -> None:
        resp = self.client.post(
            "/v1/takes", files={"file": ("t.mp3", b"ID3\x04junk", "audio/mpeg")},
            data={"meta": '{"text": "x", "segments": []}'})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("wav", resp.json()["detail"])

    def test_unknown_take_is_404(self) -> None:
        resp = self.client.get("/v1/takes/deadbeef00")
        self.assertEqual(resp.status_code, 404)


class LineageTests(_TakesBase):
    def test_child_records_provenance_and_lineage_walks_both_ways(self) -> None:
        parent = self._create_take("Line one.")
        child = self._create_take("Line one.", parent_id=parent,
                                  derived_from={"kind": "remix", "note": "angrier"})
        grandchild = self._create_take("Line one.", parent_id=child)

        body = self.client.get(f"/v1/takes/{child}").json()
        self.assertEqual(body["parent_id"], parent)
        self.assertEqual(body["derived_from"], {"kind": "remix", "note": "angrier"})

        lineage = self.client.get(f"/v1/takes/{child}/lineage").json()
        self.assertEqual([a["id"] for a in lineage["ancestors"]], [parent])
        self.assertEqual([c["id"] for c in lineage["children"]], [grandchild])
        self.assertEqual(lineage["children_total"], 1)
        self.assertFalse(lineage["depth_capped"])

    def test_take_with_no_parent_has_an_empty_lineage(self) -> None:
        solo = self._create_take()
        lineage = self.client.get(f"/v1/takes/{solo}/lineage").json()
        self.assertEqual(lineage["ancestors"], [])
        self.assertEqual(lineage["children"], [])

    def test_lineage_of_unknown_take_is_404(self) -> None:
        self.assertEqual(self.client.get("/v1/takes/nosuch0001/lineage").status_code, 404)
        # ...and a non-id can never become a path segment
        self.assertEqual(self.client.get("/v1/takes/..%2Fetc/lineage").status_code, 404)

    def test_an_evicted_ancestor_is_reported_not_silently_dropped(self) -> None:
        parent = self._create_take()
        child = self._create_take(parent_id=parent)
        (takes.TAKES_DIR / f"{parent}.json").unlink()
        lineage = self.client.get(f"/v1/takes/{child}/lineage").json()
        self.assertEqual(lineage["ancestors"], [{"id": parent, "missing": True}])

    def test_bad_parent_id_is_rejected(self) -> None:
        resp = self.client.post(
            "/v1/takes", files={"file": ("t.wav", WAV, "audio/wav")},
            data={"meta": json.dumps({"text": "x", "segments": [],
                                      "parent_id": "../../etc/passwd"})})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("parent_id", resp.json()["detail"])

    def test_a_parent_evicted_mid_fork_still_yields_a_take(self) -> None:
        # The render is the expensive part and it already happened. A parent
        # that aged out of the bounded store between the fork and the publish
        # must not cost the user their take.
        child = self._create_take(parent_id="deadbeef00")
        self.assertEqual(self.client.get(f"/v1/takes/{child}").json()["parent_id"],
                         "deadbeef00")

    def test_deep_chains_are_bounded_and_say_so(self) -> None:
        previous = self._write_take("root000000")
        for i in range(takes.MAX_LINEAGE_DEPTH + 3):
            previous = self._write_take(f"gen{i:07d}", parent_id=previous)
        lineage = self.client.get(f"/v1/takes/{previous}/lineage").json()
        self.assertEqual(len(lineage["ancestors"]), takes.MAX_LINEAGE_DEPTH)
        self.assertTrue(lineage["depth_capped"])

    def test_a_parent_cycle_cannot_hang_the_walk(self) -> None:
        self._write_take("aaaaaaaaaa", parent_id="bbbbbbbbbb")
        self._write_take("bbbbbbbbbb", parent_id="aaaaaaaaaa")
        lineage = self.client.get("/v1/takes/aaaaaaaaaa/lineage").json()
        self.assertEqual([a["id"] for a in lineage["ancestors"]], ["bbbbbbbbbb"])


class LineageEvictionTests(_TakesBase):
    """The subtle trap: the bounded store meets a chain. Evicting a mid-chain
    link would leave a child pointing at a parent that is gone."""

    def setUp(self) -> None:
        super().setUp()
        self._max = takes.MAX_TAKES
        takes.MAX_TAKES = 3

    def tearDown(self) -> None:
        takes.MAX_TAKES = self._max
        super().tearDown()

    def _ids(self) -> set[str]:
        return {p.stem for p in takes.TAKES_DIR.glob("*.json")}

    def test_the_oldest_take_survives_when_it_is_a_parent(self) -> None:
        # Exactly the scenario: parent OLDER than child, then eviction pressure.
        parent = self._write_take("parent0000", age=100)
        child = self._write_take("child00000", parent_id=parent, age=50)
        loose = self._write_take("loose00000", age=90)  # older than the child

        fresh = self._create_take("New take.")  # pushes the store over its cap

        surviving = self._ids()
        self.assertNotIn(loose, surviving)      # the oldest EVICTABLE take went
        self.assertEqual(surviving, {parent, child, fresh})
        # and the chain is still walkable end to end
        lineage = self.client.get(f"/v1/takes/{child}/lineage").json()
        self.assertEqual([a["id"] for a in lineage["ancestors"]], [parent])
        self.assertEqual(lineage["ancestors"][0]["missing"], False)

    def test_a_whole_chain_is_stripped_from_its_leaf_inward(self) -> None:
        # Under enough pressure a chain does go — but as a chain, tip first,
        # so what remains is never a take whose parent was deleted under it.
        root = self._write_take("root000000", age=300)
        mid = self._write_take("mid0000000", parent_id=root, age=200)
        leaf = self._write_take("leaf000000", parent_id=mid, age=100)
        takes.MAX_TAKES = 1
        self._create_take("New take.")
        surviving = self._ids()
        self.assertNotIn(leaf, surviving)
        self.assertNotIn(mid, surviving)
        self.assertNotIn(root, surviving)
        for take_id in surviving:
            meta = json.loads((takes.TAKES_DIR / f"{take_id}.json").read_text("utf-8"))
            parent = meta.get("parent_id")
            self.assertTrue(parent is None or parent in surviving)

    def test_a_cycle_cannot_wedge_the_writer(self) -> None:
        self._write_take("aaaaaaaaaa", parent_id="bbbbbbbbbb", age=100)
        self._write_take("bbbbbbbbbb", parent_id="aaaaaaaaaa", age=90)
        self._write_take("cccccccccc", age=80)
        fresh = self._create_take("New take.")  # must not hang or fail
        self.assertIn(fresh, self._ids())
        self.assertEqual(len(self._ids()), 3)


class DirectionWiringTests(_TakesBase):
    def _take_with(self, emotion: str, **meta) -> str:
        resp = self.client.post(
            "/v1/takes", files={"file": ("t.wav", WAV, "audio/wav")},
            data={"meta": json.dumps({
                "text": "Line.", "character_id": meta.pop("character_id", "sarah"),
                "segments": [{"text": "Line.", "requested": emotion, "used": emotion}],
                **meta})})
        self.assertEqual(resp.status_code, 201, resp.text)
        return resp.json()["take_id"]

    def test_a_derived_take_feeds_the_direction_corpus(self) -> None:
        parent = self._take_with("baseline")
        self._take_with("angry", parent_id=parent)
        stored = json.loads(direction.DIRECTION_PATH.read_text("utf-8"))
        self.assertEqual(stored["characters"]["sarah"]["deltas"], {"baseline>angry": 1})

    def test_a_take_with_no_parent_records_nothing(self) -> None:
        self._take_with("angry")
        self.assertFalse(direction.DIRECTION_PATH.exists())

    def test_a_broken_corpus_never_costs_the_user_the_take(self) -> None:
        parent = self._take_with("baseline")
        direction.DIRECTION_PATH.parent.mkdir(parents=True, exist_ok=True)
        direction.DIRECTION_PATH.write_text("{corrupt", "utf-8")
        child = self._take_with("angry", parent_id=parent)  # 201 or the test fails
        self.assertEqual(self.client.get(f"/v1/takes/{child}").status_code, 200)


class ReperformTests(_TakesBase):
    """Public re-perform: publisher consent, the named refusals, the budget,
    and the child's lineage. The renderer is a stub — what is under test is the
    policy around the render, not the synthesis (which /v1/speak owns)."""

    def setUp(self) -> None:
        super().setUp()
        self.rendered: list[tuple[str, str]] = []
        self._orig_provider = takes._SPEAK_PROVIDER
        takes.set_speak_provider(self._render)
        takes.REPERFORM_BUDGET.limiter.reset()

    def tearDown(self) -> None:
        takes.set_speak_provider(self._orig_provider)
        takes.REPERFORM_BUDGET.limiter.reset()
        super().tearDown()

    async def _render(self, character_id: str, text: str) -> dict:
        self.rendered.append((character_id, text))
        return {"audio": WAV, "seconds": 1.5, "rtf": 0.4,
                "segments": [{"text": text, "requested": "angry", "used": "angry"}]}

    def _open_take(self, **meta) -> str:
        return self._create_take(
            allow_reperform=True,
            segments=[{"text": "Hello there.", "requested": "baseline",
                       "used": "baseline"}], **meta)

    def test_an_opted_in_take_mints_a_child_with_lineage(self) -> None:
        parent = self._open_take()
        r = self.client.post(f"/v1/takes/{parent}/reperform",
                             json={"text": "[angry]Hello there."})
        self.assertEqual(r.status_code, 201, r.text)
        child_id = r.json()["take_id"]
        self.assertEqual(r.json()["parent_id"], parent)
        self.assertEqual(self.rendered, [("sarah", "[angry]Hello there.")])

        child = self.client.get(f"/v1/takes/{child_id}").json()
        self.assertEqual(child["parent_id"], parent)
        self.assertEqual(child["derived_from"], {"kind": "public-reperform"})
        self.assertEqual(child["character_id"], "sarah")
        self.assertEqual(child["seconds"], 1.5)
        # A fork is a leaf: consent was for ONE fork, not for a public chain.
        self.assertFalse(child["allow_reperform"])
        lineage = self.client.get(f"/v1/takes/{parent}/lineage").json()
        self.assertEqual([c["id"] for c in lineage["children"]], [child_id])

    def test_the_fork_is_counted_as_a_direction_decision(self) -> None:
        parent = self._open_take()
        self.client.post(f"/v1/takes/{parent}/reperform", json={"text": "Hi."})
        stored = json.loads(direction.DIRECTION_PATH.read_text("utf-8"))
        self.assertEqual(stored["characters"]["sarah"]["deltas"],
                         {"baseline>angry": 1})

    def test_a_take_published_without_the_opt_in_refuses_by_name(self) -> None:
        take_id = self._create_take()  # allow_reperform absent = OFF
        r = self.client.post(f"/v1/takes/{take_id}/reperform", json={"text": "Hi."})
        self.assertEqual(r.status_code, 403)
        self.assertIn("not-published-for-reperform", r.json()["detail"])
        self.assertEqual(self.rendered, [])

    def test_an_unknown_take_is_404(self) -> None:
        r = self.client.post("/v1/takes/deadbeef99/reperform", json={"text": "Hi."})
        self.assertEqual(r.status_code, 404)

    def test_over_long_text_is_refused_by_name_before_any_render(self) -> None:
        parent = self._open_take()
        r = self.client.post(f"/v1/takes/{parent}/reperform",
                             json={"text": "x" * (takes.MAX_REPERFORM_TEXT + 1)})
        self.assertEqual(r.status_code, 413)
        self.assertIn("too-long", r.json()["detail"])
        self.assertEqual(self.rendered, [])

    def test_a_deployment_with_no_renderer_says_engine_absent(self) -> None:
        parent = self._open_take()
        takes.set_speak_provider(None)
        r = self.client.post(f"/v1/takes/{parent}/reperform", json={"text": "Hi."})
        self.assertEqual(r.status_code, 503)
        self.assertIn("engine-absent", r.json()["detail"])

    def test_a_refusal_from_the_render_path_reaches_the_caller_intact(self) -> None:
        parent = self._open_take()

        async def busy(character_id: str, text: str) -> dict:
            raise HTTPException(429, "all workers are busy")

        takes.set_speak_provider(busy)
        r = self.client.post(f"/v1/takes/{parent}/reperform", json={"text": "Hi."})
        self.assertEqual(r.status_code, 429)
        self.assertIn("busy", r.json()["detail"])

    def test_a_renderer_that_blows_up_is_a_named_502_not_a_crash(self) -> None:
        parent = self._open_take()

        async def boom(character_id: str, text: str) -> dict:
            raise RuntimeError("model gone")

        takes.set_speak_provider(boom)
        r = self.client.post(f"/v1/takes/{parent}/reperform", json={"text": "Hi."})
        self.assertEqual(r.status_code, 502)
        self.assertIn("render-failed", r.json()["detail"])

    def test_a_renderer_that_returns_no_wav_does_not_publish_a_take(self) -> None:
        parent = self._open_take()

        async def empty(character_id: str, text: str) -> dict:
            return {"audio": b"", "segments": []}

        takes.set_speak_provider(empty)
        r = self.client.post(f"/v1/takes/{parent}/reperform", json={"text": "Hi."})
        self.assertEqual(r.status_code, 502)
        self.assertEqual(self.client.get(f"/v1/takes/{parent}/lineage")
                         .json()["children"], [])

    def test_the_per_ip_budget_refuses_with_retry_after(self) -> None:
        # The test package disarms app-wired budgets globally; this test IS the
        # budget's proof on the reperform surface, so re-arm it for its duration.
        bypass = os.environ.pop("GRAVITONE_RATELIMIT_TEST_BYPASS", None)
        if bypass is not None:
            self.addCleanup(os.environ.__setitem__,
                            "GRAVITONE_RATELIMIT_TEST_BYPASS", bypass)
        parent = self._open_take()
        limiter = takes.REPERFORM_BUDGET.limiter
        # Freeze the limiter's clock for the duration. The refusals below come
        # from the burst sub-window (1s), and on a loaded box the eight HTTP
        # round trips this test makes can take longer than that — the burst
        # window rolls mid-assertion and the final "still refused" request is
        # honestly allowed (measured 0.413s idle; flaked under full-suite
        # load). The property under test is the limiter's arithmetic, not the
        # wall clock's mood, so every request lands at one instant.
        frozen_at = limiter._clock()
        real_clock = limiter._clock
        limiter._clock = lambda: frozen_at
        limiter.reset()

        def _restore_clock() -> None:
            limiter._clock = real_clock
            limiter.reset()

        self.addCleanup(_restore_clock)
        codes = [self.client.post(f"/v1/takes/{parent}/reperform",
                                  json={"text": "Hi."}).status_code
                 for _ in range(limiter.limit + 2)]
        self.assertEqual(codes[0], 201)
        self.assertIn(429, codes)
        r = self.client.post(f"/v1/takes/{parent}/reperform", json={"text": "Hi."})
        self.assertEqual(r.status_code, 429)
        self.assertIn("rate-limited", r.json()["detail"])
        self.assertTrue(int(r.headers["Retry-After"]) >= 1)

    def test_the_publish_flag_is_off_unless_the_publisher_asked(self) -> None:
        self.assertFalse(self.client.get(f"/v1/takes/{self._create_take()}")
                         .json()["allow_reperform"])
        self.assertTrue(self.client.get(f"/v1/takes/{self._open_take()}")
                        .json()["allow_reperform"])


class CastTests(_TakesBase):
    """A published take remembers WHO SPOKE each segment.

    Before this, an ensemble was stored under its first speaker with a flat
    segment list naming nobody — /t/{id} could only draw one rail and re-perform
    only had one voice to work with.
    """

    def test_a_segments_speaker_survives_publication(self) -> None:
        take_id = self._create_take(segments=[
            {"text": "You said you would call.", "requested": "angry",
             "used": "angry", "character_id": "sarah", "character_name": "Sarah"},
            {"text": "I know.", "requested": "sad", "used": "sad",
             "character_id": "malik", "character_name": "Malik"},
        ])
        stored = self.client.get(f"/v1/takes/{take_id}").json()["segments"]
        self.assertEqual([s.get("character_id") for s in stored], ["sarah", "malik"])
        self.assertEqual([s.get("character_name") for s in stored], ["Sarah", "Malik"])
        self.assertEqual(takes.cast_of({"segments": stored}),
                         {"sarah": "Sarah", "malik": "Malik"})

    def test_a_solo_takes_record_is_unchanged(self) -> None:
        # No cast in = no cast keys out. A reader must be able to tell "this
        # take names no cast" from "this segment was spoken by nobody".
        take_id = self._create_take(segments=[
            {"text": "Hello there.", "requested": "baseline", "used": "baseline"}])
        stored = self.client.get(f"/v1/takes/{take_id}").json()["segments"]
        self.assertNotIn("character_id", stored[0])
        self.assertNotIn("character_name", stored[0])
        self.assertEqual(takes.cast_of({"segments": stored}), {})

    def test_a_name_without_an_id_is_dropped(self) -> None:
        # A label pointing at nothing: the id is what lanes and re-perform
        # address, so a name that names no addressable Character is not kept.
        take_id = self._create_take(segments=[
            {"text": "Hi.", "requested": "baseline", "used": "baseline",
             "character_name": "Nobody"}])
        stored = self.client.get(f"/v1/takes/{take_id}").json()["segments"]
        self.assertNotIn("character_name", stored[0])

    def test_the_cast_is_first_spoken_order_and_deduplicated(self) -> None:
        meta = {"segments": [
            {"character_id": "malik", "character_name": "Malik"},
            {"character_id": "sarah", "character_name": "Sarah"},
            {"character_id": "malik", "character_name": "Malik"},
        ]}
        self.assertEqual(list(takes.cast_of(meta)), ["malik", "sarah"])

    def test_an_id_with_no_name_falls_back_to_the_id(self) -> None:
        self.assertEqual(takes.cast_of({"segments": [{"character_id": "x9"}]}),
                         {"x9": "x9"})


def _wav(seconds: float = 0.1, rate: int = 24000) -> bytes:
    """A real (silent) 24 kHz mono 16-bit WAV — concat_wavs parses its header,
    so the RIFF-sniff stub is not enough for a multi-line cast render."""
    import wave as _wave
    buf = io.BytesIO()
    with _wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * int(rate * seconds))
    return buf.getvalue()


class ReperformCastTests(_TakesBase):
    """Whose voice a public fork actually renders in — and whether the answer
    is stated.

    The bug this replaces: an ensemble take was re-performed by handing its
    WHOLE text to the first speaker's Character, in one voice, with nothing in
    the response or on the page saying the cast had been collapsed.
    """

    def setUp(self) -> None:
        super().setUp()
        self.rendered: list[tuple[str, str]] = []
        self._orig_provider = takes._SPEAK_PROVIDER
        takes.set_speak_provider(self._render)
        takes.REPERFORM_BUDGET.limiter.reset()

    def tearDown(self) -> None:
        takes.set_speak_provider(self._orig_provider)
        takes.REPERFORM_BUDGET.limiter.reset()
        super().tearDown()

    async def _render(self, character_id: str, text: str) -> dict:
        self.rendered.append((character_id, text))
        return {"audio": _wav(), "seconds": 1.0, "rtf": 0.5,
                "segments": [{"text": text, "requested": "baseline",
                              "used": "baseline", "seconds": 1.0}]}

    def _ensemble(self) -> str:
        return self._create_take(
            allow_reperform=True, character_id="sarah",
            segments=[
                {"text": "You said you would call.", "requested": "angry",
                 "used": "angry", "character_id": "sarah", "character_name": "Sarah"},
                {"text": "I know.", "requested": "baseline", "used": "baseline",
                 "character_id": "malik", "character_name": "Malik"},
            ])

    def _solo(self) -> str:
        return self._create_take(
            allow_reperform=True, character_id="sarah",
            segments=[{"text": "Hello there.", "requested": "baseline",
                       "used": "baseline"}])

    def test_a_cast_fork_renders_each_line_in_its_own_voice(self) -> None:
        parent = self._ensemble()
        r = self.client.post(f"/v1/takes/{parent}/reperform", json={"lines": [
            {"character_id": "sarah", "text": "You never called."},
            {"character_id": "malik", "text": "I meant to."},
        ]})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(self.rendered,
                         [("sarah", "You never called."), ("malik", "I meant to.")])
        body = r.json()
        self.assertEqual(body["voices"], ["sarah", "malik"])
        self.assertFalse(body["single_voice"])
        self.assertIsNone(body["notice"])

    def test_the_child_of_a_cast_fork_is_itself_an_ensemble(self) -> None:
        parent = self._ensemble()
        child_id = self.client.post(f"/v1/takes/{parent}/reperform", json={"lines": [
            {"character_id": "sarah", "text": "One."},
            {"character_id": "malik", "text": "Two."},
        ]}).json()["take_id"]
        child = self.client.get(f"/v1/takes/{child_id}").json()
        self.assertEqual(takes.cast_of(child), {"sarah": "Sarah", "malik": "Malik"})
        self.assertEqual(child["character_name"], "Ensemble - 2 voices")
        # Sequential lines: the factor is total audio over total synthesis, not
        # an average of the per-line factors.
        self.assertEqual(child["seconds"], 2.0)
        self.assertEqual(child["rtf"], 0.5)

    def test_a_take_with_no_cast_says_plainly_that_it_is_one_voice(self) -> None:
        parent = self._solo()
        body = self.client.post(f"/v1/takes/{parent}/reperform",
                                json={"text": "Hi again."}).json()
        self.assertTrue(body["single_voice"])
        self.assertIn("one voice", body["notice"])
        self.assertIn("not preserved", body["notice"])

    def test_a_cast_take_reperformed_as_one_voice_invents_no_notice(self) -> None:
        # The publisher's own take DOES name a cast; a visitor who chose the
        # single-voice form got what they asked for and needs no warning.
        parent = self._ensemble()
        body = self.client.post(f"/v1/takes/{parent}/reperform",
                                json={"text": "Just me."}).json()
        self.assertTrue(body["single_voice"])
        self.assertIsNone(body["notice"])

    def test_lines_may_only_name_the_takes_own_cast(self) -> None:
        parent = self._ensemble()
        r = self.client.post(f"/v1/takes/{parent}/reperform", json={"lines": [
            {"character_id": "someone_elses_voice", "text": "Say this."},
        ]})
        self.assertEqual(r.status_code, 403)
        self.assertIn("cast-mismatch", r.json()["detail"])
        self.assertEqual(self.rendered, [])

    def test_lines_against_a_castless_take_refuse_by_name(self) -> None:
        r = self.client.post(f"/v1/takes/{self._solo()}/reperform", json={"lines": [
            {"character_id": "sarah", "text": "Hi."},
        ]})
        self.assertEqual(r.status_code, 409)
        self.assertIn("cast-absent", r.json()["detail"])

    def test_both_forms_at_once_is_refused_rather_than_guessed(self) -> None:
        r = self.client.post(f"/v1/takes/{self._ensemble()}/reperform",
                             json={"text": "A", "lines": [
                                 {"character_id": "sarah", "text": "B"}]})
        self.assertEqual(r.status_code, 400)
        self.assertIn("ambiguous", r.json()["detail"])

    def test_neither_form_is_the_named_empty_refusal_not_a_422(self) -> None:
        r = self.client.post(f"/v1/takes/{self._ensemble()}/reperform", json={})
        self.assertEqual(r.status_code, 400)
        self.assertIn("empty", r.json()["detail"])

    def test_the_character_cap_is_the_SUM_of_the_lines(self) -> None:
        # Splitting the words across voices must not buy more of this box's CPU.
        parent = self._ensemble()
        half = "x" * (takes.MAX_REPERFORM_TEXT // 2 + 10)
        r = self.client.post(f"/v1/takes/{parent}/reperform", json={"lines": [
            {"character_id": "sarah", "text": half},
            {"character_id": "malik", "text": half},
        ]})
        self.assertEqual(r.status_code, 413)
        self.assertIn("too-long", r.json()["detail"])
        self.assertEqual(self.rendered, [])

    def test_more_lines_than_the_cap_is_refused_by_the_schema(self) -> None:
        parent = self._ensemble()
        r = self.client.post(f"/v1/takes/{parent}/reperform", json={"lines": [
            {"character_id": "sarah", "text": "a"}
            for _ in range(takes.MAX_REPERFORM_LINES + 1)
        ]})
        self.assertEqual(r.status_code, 422)
        self.assertEqual(self.rendered, [])


class ReviewsErrorTests(_TakesBase):
    def test_review_of_unknown_take_is_404(self) -> None:
        resp = self.client.post(
            "/v1/reviews", json={"take_ids": ["nosuch0001", "nosuch0002"]})
        self.assertEqual(resp.status_code, 404)

    def test_pick_flow_first_pick_wins(self) -> None:
        t1, t2 = self._create_take("A."), self._create_take("A.")
        review_id = self.client.post(
            "/v1/reviews", json={"take_ids": [t1, t2]}).json()["review_id"]

        outside = self.client.post(
            f"/v1/reviews/{review_id}/pick", json={"take_id": "intruder001"})
        self.assertEqual(outside.status_code, 400)

        first = self.client.post(
            f"/v1/reviews/{review_id}/pick", json={"take_id": t1})
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json()["take_id"], t1)

        # A decided review is final — the double-decide race lands on 409.
        second = self.client.post(
            f"/v1/reviews/{review_id}/pick", json={"take_id": t2})
        self.assertEqual(second.status_code, 409)

    def test_revise_opens_a_new_round_without_reopening_the_decision(self) -> None:
        t1, t2 = self._create_take("A."), self._create_take("A.")
        first = self.client.post(
            "/v1/reviews", json={"title": "Radio spot", "take_ids": [t1, t2]}
        ).json()["review_id"]
        self.client.post(f"/v1/reviews/{first}/pick", json={"take_id": t1})

        resp = self.client.post(f"/v1/reviews/{first}/revise", json={
            "note": "Close - make line 3 angrier.", "reviewer": "Dana",
            "direction": "line 3: baseline -> angry"})
        self.assertEqual(resp.status_code, 201, resp.text)
        second = resp.json()["review_id"]
        self.assertEqual(resp.json()["round"], 2)

        body = self.client.get(f"/v1/reviews/{second}").json()
        self.assertEqual(body["take_ids"], [t1])  # seeded from the PICKED take
        self.assertEqual(body["title"], "Radio spot - round 2")
        self.assertIsNone(body["pick"])
        self.assertEqual(body["derived_from"]["review_id"], first)
        self.assertEqual(body["derived_from"]["direction"], "line 3: baseline -> angry")

        # The first round is untouched: still decided, still final.
        original = self.client.get(f"/v1/reviews/{first}").json()
        self.assertEqual(original["pick"]["take_id"], t1)
        self.assertEqual([r["id"] for r in original["revisions"]], [second])
        self.assertEqual(
            self.client.post(f"/v1/reviews/{first}/pick", json={"take_id": t2}).status_code,
            409)

    def test_rounds_stack_without_stacking_the_title(self) -> None:
        t1, t2 = self._create_take("A."), self._create_take("A.")
        rid = self.client.post(
            "/v1/reviews", json={"title": "Radio spot", "take_ids": [t1, t2]}
        ).json()["review_id"]
        self.client.post(f"/v1/reviews/{rid}/pick", json={"take_id": t1})
        second = self.client.post(
            f"/v1/reviews/{rid}/revise", json={"note": "again"}).json()["review_id"]
        self.client.post(f"/v1/reviews/{second}/pick", json={"take_id": t1})
        third = self.client.post(
            f"/v1/reviews/{second}/revise", json={"note": "once more"}).json()
        self.assertEqual(third["round"], 3)
        self.assertEqual(
            self.client.get(f"/v1/reviews/{third['review_id']}").json()["title"],
            "Radio spot - round 3")

    def test_revising_an_undecided_review_is_409(self) -> None:
        t1, t2 = self._create_take("A."), self._create_take("A.")
        rid = self.client.post("/v1/reviews", json={"take_ids": [t1, t2]}).json()["review_id"]
        resp = self.client.post(f"/v1/reviews/{rid}/revise", json={"note": "hmm"})
        self.assertEqual(resp.status_code, 409)

    def test_revise_needs_a_note(self) -> None:
        t1, t2 = self._create_take("A."), self._create_take("A.")
        rid = self.client.post("/v1/reviews", json={"take_ids": [t1, t2]}).json()["review_id"]
        self.client.post(f"/v1/reviews/{rid}/pick", json={"take_id": t1})
        self.assertEqual(
            self.client.post(f"/v1/reviews/{rid}/revise", json={"note": ""}).status_code,
            422)

    def test_revising_an_unknown_review_is_404(self) -> None:
        self.assertEqual(
            self.client.post("/v1/reviews/nosuch0001/revise", json={"note": "x"}).status_code,
            404)

    def test_preferred_empty_store_reports_zero_picks(self) -> None:
        resp = self.client.get("/v1/reviews/preferred")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), {"character_id": None, "picks": 0,
                                       "counts": {}})


class CorruptRecordTests(_TakesBase):
    """A damaged file names itself — the takes/reviews counterpart to
    ``test_direction.test_corrupt_store_is_reported_not_silently_zeroed``.

    Two rules, and they pull in opposite directions on purpose:

      * A record a route was asked for BY NAME is reported, not disguised as a
        404 (which would tell a publisher their share was evicted and send them
        off to re-share a link that is really sitting on damaged disk).
      * A record merely WALKED PAST — eviction, lineage, listings, the picks
        histogram — is skipped and logged, because one bad file must never make
        the whole store unreadable.
    """

    def _corrupt(self, path: Path) -> None:
        path.write_text("{not json", "utf-8")

    def _corrupt_take(self, take_id: str) -> str:
        self._write_take(take_id)
        self._corrupt(takes.TAKES_DIR / f"{take_id}.json")
        return take_id

    def _assert_named_failure(self, resp, needle: str) -> None:
        self.assertEqual(resp.status_code, 500, resp.text)
        detail = resp.json()["detail"]
        # Named (it says which record and what is wrong with it), authored, and
        # carrying the operator's handle — never the decode error itself.
        self.assertIn(needle, detail)
        self.assertIn("damaged", detail)
        self.assertIn("request ", detail)
        self.assertNotIn("Expecting", detail)  # no raw JSONDecodeError text
        self.assertNotIn(str(takes.TAKES_DIR), detail)  # no server paths

    def test_a_corrupt_take_is_named_not_a_generic_500(self) -> None:
        tid = self._corrupt_take("corrupt001")
        with self.assertLogs("service.takes", level="WARNING") as logs:
            resp = self.client.get(f"/v1/takes/{tid}")
        self._assert_named_failure(resp, tid)
        self.assertTrue(any("corrupt" in line for line in logs.output))

    def test_a_corrupt_take_is_not_reported_as_evicted(self) -> None:
        tid = self._corrupt_take("corrupt002")
        with self.assertLogs("service.takes", level="WARNING"):
            resp = self.client.get(f"/v1/takes/{tid}")
        self.assertNotEqual(resp.status_code, 404)
        self.assertNotIn("evicted", resp.json()["detail"])

    def test_a_corrupt_take_is_named_on_lineage_and_reperform(self) -> None:
        tid = self._corrupt_take("corrupt003")
        for path in (f"/v1/takes/{tid}/lineage",):
            with self.subTest(path=path):
                with self.assertLogs("service.takes", level="WARNING"):
                    self._assert_named_failure(self.client.get(path), tid)
        with self.assertLogs("service.takes", level="WARNING"):
            self._assert_named_failure(
                self.client.post(f"/v1/takes/{tid}/reperform",
                                 json={"text": "New words."}), tid)

    def test_a_corrupt_review_is_named(self) -> None:
        t1, t2 = self._create_take("A."), self._create_take("A.")
        review_id = self.client.post(
            "/v1/reviews", json={"take_ids": [t1, t2]}).json()["review_id"]
        self._corrupt(takes.REVIEWS_DIR / f"{review_id}.json")
        for resp in (
            self.client.get(f"/v1/reviews/{review_id}"),
            self.client.post(f"/v1/reviews/{review_id}/pick", json={"take_id": t1}),
            self.client.post(f"/v1/reviews/{review_id}/revise", json={"note": "x"}),
        ):
            with self.subTest(status=resp.status_code):
                self._assert_named_failure(resp, review_id)

    def test_a_review_cannot_be_minted_from_a_damaged_take(self) -> None:
        # The review quotes its first take's script, so minting one over a
        # damaged member would publish a guess as the client's script.
        good = self._create_take("A.")
        bad = self._corrupt_take("corrupt004")
        with self.assertLogs("service.takes", level="WARNING"):
            resp = self.client.post("/v1/reviews", json={"take_ids": [good, bad]})
        self._assert_named_failure(resp, bad)

    def test_one_damaged_member_does_not_take_the_review_down(self) -> None:
        t1, t2 = self._create_take("A."), self._create_take("A.")
        review_id = self.client.post(
            "/v1/reviews", json={"take_ids": [t1, t2]}).json()["review_id"]
        self._corrupt(takes.TAKES_DIR / f"{t2}.json")
        with self.assertLogs("service.takes", level="WARNING"):
            body = self.client.get(f"/v1/reviews/{review_id}").json()
        self.assertEqual([t["id"] for t in body["takes"]], [t1])
        # ...and the reviewer is told the fourth take is damaged rather than
        # left believing the set was always three.
        self.assertEqual(body["unreadable_take_ids"], [t2])

    def test_one_corrupt_record_does_not_break_listing_or_eviction(self) -> None:
        parent = self._write_take("parent0001", age=100)
        child = self._write_take("child00001", parent_id=parent, age=50)
        self._corrupt_take("corrupt005")
        with self.assertLogs("service.takes", level="WARNING"):
            body = self.client.get(f"/v1/takes/{parent}/lineage").json()
        self.assertEqual([c["id"] for c in body["children"]], [child])

        # Eviction walks every record; the bad one must not wedge the store.
        orig, takes.MAX_TAKES = takes.MAX_TAKES, 3
        try:
            fresh = self._create_take("still works")
        finally:
            takes.MAX_TAKES = orig
        self.assertEqual(self.client.get(f"/v1/takes/{fresh}").status_code, 200)

    def test_a_corrupt_review_does_not_break_the_picks_histogram(self) -> None:
        t1, t2 = self._create_take("A."), self._create_take("A.")
        good = self.client.post(
            "/v1/reviews", json={"take_ids": [t1, t2]}).json()["review_id"]
        self.client.post(f"/v1/reviews/{good}/pick", json={"take_id": t1})
        broken = self.client.post(
            "/v1/reviews", json={"take_ids": [t1, t2]}).json()["review_id"]
        self._corrupt(takes.REVIEWS_DIR / f"{broken}.json")

        with self.assertLogs("service.takes", level="WARNING"):
            body = self.client.get("/v1/reviews/preferred").json()
        self.assertEqual(body["character_id"], "sarah")
        self.assertEqual(body["picks"], 1)

    def test_a_damaged_take_does_not_block_recording_a_pick(self) -> None:
        t1, t2 = self._create_take("A."), self._create_take("A.")
        review_id = self.client.post(
            "/v1/reviews", json={"take_ids": [t1, t2]}).json()["review_id"]
        self._corrupt(takes.TAKES_DIR / f"{t1}.json")
        with self.assertLogs("service.takes", level="WARNING"):
            resp = self.client.post(f"/v1/reviews/{review_id}/pick",
                                    json={"take_id": t1})
        # The decision is the reviewer's; the character was only telemetry.
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json()["take_id"], t1)
        self.assertEqual(resp.json()["character_id"], "")


class PackImportErrorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(appmod.app, raise_server_exceptions=False)

    def test_not_a_zip_is_400(self) -> None:
        resp = self.client.post(
            "/v1/characters/import",
            files={"file": ("c.gravichar", b"definitely not a zip", "application/zip")})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("zip", resp.json()["detail"])

    def test_zip_without_manifest_is_400(self) -> None:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("readme.txt", "hi")
        resp = self.client.post(
            "/v1/characters/import",
            files={"file": ("c.gravichar", buf.getvalue(), "application/zip")})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("manifest", resp.json()["detail"])

    def test_export_unknown_character_is_404(self) -> None:
        resp = self.client.get("/v1/characters/no-such-character/pack")
        self.assertEqual(resp.status_code, 404)


if __name__ == "__main__":
    unittest.main()
