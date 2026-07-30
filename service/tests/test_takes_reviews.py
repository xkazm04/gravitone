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
