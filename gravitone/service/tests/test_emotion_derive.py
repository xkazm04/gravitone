"""Derived Voices: the endpoint, its refusals, and the promises it must keep.

`POST /v1/characters/{id}/emotions/{emotion}/derive` writes a REAL embedding
computed as `baseline + alpha * direction`. Four properties are load-bearing and
all four are asserted here rather than documented:

  * **The clone path's staging discipline, verbatim.** Temp file -> load-back ->
    registry row committed under the lock with the slot re-checked -> move. A
    failure at any step leaves neither an orphan embedding (which the glob-driven
    roster would turn into a phantom Character) nor a row pointing at a file that
    is not there.
  * **Consent is inherited, never minted.** The derived row carries the
    BASELINE's receipt word for word plus a `derived_from` marker. Nobody
    attested to a performance nobody gave, and a derived slot that wrote its own
    receipt would be consent laundering.
  * **A derived slot is never a recording.** `origin` says so on every surface,
    the manifest splits recorded from derived, demand keeps accruing, and
    `resolve` keeps reporting it as a fallback.
  * **Every refusal is a sentence.** No basis, no baseline, an emotion that does
    not transfer, a box that cannot read embeddings at all -- four different
    problems with four different fixes.

No real embeddings exist here, so the tensor seam is the npz-backed pair from
`test_emotion_basis` and every vector is one this file chose.
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

import numpy as np

from service.tests import fake_engine  # installs shims -- must precede app import

import service.app as appmod
import service.emotion_basis as eb
import service.emotions as em
import service.ingest as ingest
import service.voices as vc
from fastapi import HTTPException
from fastapi.testclient import TestClient
from service.tools import emotion_residuals as res
from service.tests.test_emotion_basis import fake_load, fake_save
from service.tests.test_emotion_residuals import COHERENT, MIDDLING, _axis


def _speakers(source: dict) -> dict:
    """The residual fixtures under ids that are NOT built-in first names.

    `mary`, `paul` and `vera` are all built-in voice ids, and a cloned Character
    that shadows a built-in is a real (logged) state this suite is not about.
    """
    return {f"spk_{cid}": slots for cid, slots in source.items()}


COHERENT_SPEAKERS = _speakers(COHERENT)
MIDDLING_SPEAKERS = _speakers(MIDDLING)

CONSENT = {"consented_at": "2026-07-30T10:00:00Z", "clip_sha256": "abc123",
           "statement": "I own this recording and consent to cloning it."}


class _DeriveCase(unittest.TestCase):
    """A temp registry, a tensor seam, and a corpus that can build a basis."""

    CORPUS = COHERENT_SPEAKERS

    def setUp(self) -> None:
        self._dir = TemporaryDirectory()
        self.root = Path(self._dir.name) / "voices"
        self.root.mkdir(parents=True)
        self.client = TestClient(appmod.app, raise_server_exceptions=False)
        self._patches = [
            mock.patch.object(vc, "VOICES_DIR", self.root),
            mock.patch.object(vc, "META_PATH", self.root / "_meta.json"),
            mock.patch.object(vc, "_META_LOCK_PATH", self.root / "._meta.lock"),
            mock.patch.object(ingest, "VOICES_DIR", self.root),
            mock.patch.object(res, "save_embedding", fake_save),
            mock.patch.object(res, "load_embedding", fake_load),
        ]
        for p in self._patches:
            p.start()
        # The service-wide per-IP budgets are process-global and every test
        # client is 127.0.0.1, so a suite that derives more than the demo budget
        # allows would 429 on its own success cases -- and would do it only when
        # run after another suite, which is the worst kind of red. Reset them
        # here rather than counting requests.
        try:
            from service import ratelimit

            ratelimit.reset_all()
        except Exception:  # noqa: BLE001 - no limiter on this build, nothing to reset
            pass
        vc.invalidate()
        self.rows: dict = {}
        self.characters: dict = {}
        for cid, slots in self.CORPUS.items():
            for emotion, vec in slots.items():
                self.write_voice(cid, emotion, vec)
        # The speaker being FILLED IN: a baseline and nothing else.
        self.write_voice("sarah", "baseline", np.full(len(_axis(0)), 7.0),
                         consent=CONSENT)
        self.save()

    def tearDown(self) -> None:
        for p in self._patches:
            p.stop()
        vc.invalidate()
        self._dir.cleanup()

    # -- seeding ----------------------------------------------------------
    def write_voice(self, cid: str, emotion: str, vec, *, consent: dict | None = None,
                    origin: str | None = None) -> str:
        vid = f"{cid}-{emotion}"
        fake_save(self.root / f"{vid}.safetensors", {"e": np.asarray(vec, dtype=np.float64)})
        row = {"name": cid.title(), "character_id": cid, "emotion": emotion,
               "created": "2026-07-01T00:00:00", "sample_seconds": 12.0, "lang": "EN"}
        if consent is not None:
            row["consent"] = dict(consent)
        if origin is not None:
            row["origin"] = origin
        self.rows[vid] = row
        self.characters.setdefault(cid, {"name": cid.title(), "tags": []})
        return vid

    def save(self) -> None:
        (self.root / "_meta.json").write_text(json.dumps(
            {"voices": self.rows, "characters": self.characters}), "utf-8")
        vc.invalidate()

    def build_basis(self, **kwargs) -> dict:
        report = eb.build(self.root, **kwargs)
        vc.invalidate()
        return report

    def meta(self) -> dict:
        return json.loads((self.root / "_meta.json").read_text("utf-8"))

    def derive(self, cid: str = "sarah", emotion: str = "angry", **body):
        return self.client.post(
            f"/v1/characters/{cid}/emotions/{emotion}/derive",
            json=body or None)

    def embeddings(self) -> list[str]:
        return sorted(p.name for p in self.root.glob("*.safetensors"))


class RefusalTests(_DeriveCase):
    """Four different problems, four different sentences."""

    def test_no_basis_yet_says_what_to_run(self) -> None:
        r = self.derive()
        self.assertEqual(r.status_code, 422)
        self.assertIn("no emotion basis has been built", r.json()["detail"])

    def test_a_box_that_cannot_read_embeddings_answers_501(self) -> None:
        self.build_basis()
        with mock.patch.object(res, "load_embedding",
                               side_effect=res.TensorsUnavailable(
                                   "safetensors is not installed (dev box)")):
            r = self.derive()
        self.assertEqual(r.status_code, 501)
        # NOT a generic "unavailable": the operator learns it is a missing
        # package on THIS server, not a problem with their character.
        self.assertIn("safetensors", r.json()["detail"])

    def test_a_character_with_no_baseline_is_told_to_record_one(self) -> None:
        self.build_basis()
        self.rows.pop("sarah-baseline")
        (self.root / "sarah-baseline.safetensors").unlink()
        self.write_voice("sarah", "calm", np.full(len(_axis(0)), 7.0))
        self.save()
        r = self.derive()
        self.assertEqual(r.status_code, 422)
        self.assertIn("no baseline recording to derive from", r.json()["detail"])

    def test_baseline_itself_cannot_be_derived(self) -> None:
        self.build_basis()
        r = self.derive(emotion="baseline")
        self.assertEqual(r.status_code, 422)
        self.assertIn("origin", r.json()["detail"])

    def test_a_filled_slot_names_the_voice_that_holds_it(self) -> None:
        self.build_basis()
        self.write_voice("sarah", "angry", np.full(len(_axis(0)), 8.0))
        self.save()
        r = self.derive()
        self.assertEqual(r.status_code, 409)
        self.assertIn("sarah-angry", r.json()["detail"])

    def test_a_builtin_character_cannot_be_extended(self) -> None:
        self.build_basis()
        r = self.derive(cid="mary")  # a built-in first name
        self.assertEqual(r.status_code, 409)
        self.assertIn("built-in", r.json()["detail"])

    def test_an_unknown_character_is_a_404(self) -> None:
        self.build_basis()
        self.assertEqual(self.derive(cid="nobody").status_code, 404)

    def test_a_slot_that_is_not_in_the_palette_is_a_404(self) -> None:
        self.build_basis()
        r = self.derive(emotion="sarcastic")
        self.assertEqual(r.status_code, 404)
        self.assertIn("palette", r.json()["detail"])

    def test_an_unaddressable_emotion_name_is_a_400(self) -> None:
        self.build_basis()
        self.assertEqual(self.derive(emotion="Battle Cry!").status_code, 400)

    def test_an_alpha_knob_this_api_does_not_expose_is_refused_loudly(self) -> None:
        self.build_basis()
        r = self.derive(alpha=9.0)
        self.assertEqual(r.status_code, 422)  # extra="forbid", not a silent 201


class LowCoherenceBasisTests(_DeriveCase):
    """The read-time gate is the one that protects the user."""

    # Two speakers whose residuals agree at cosine 0.25: enough agreement to
    # average into a direction at all, nowhere near enough to derive from.
    CORPUS = MIDDLING_SPEAKERS

    def test_an_emotion_that_does_not_transfer_names_both_numbers(self) -> None:
        # Built with the bar dropped, so the file carries a direction whose own
        # coherence is below what derive requires. Even so, nothing may be
        # derived from it: the number travels with the vector precisely so a
        # basis built by a laxer run cannot license a bad voice.
        report = self.build_basis(min_coherence=-1.0)
        self.assertTrue(report["written"])
        r = self.derive()
        self.assertEqual(r.status_code, 422)
        detail = r.json()["detail"]
        self.assertIn("does not transfer", detail)
        self.assertIn("coherence", detail)


class DeriveTests(_DeriveCase):
    def setUp(self) -> None:
        super().setUp()
        self.build_basis()

    def test_a_derived_voice_is_a_real_file_and_an_honest_row(self) -> None:
        r = self.derive()
        self.assertEqual(r.status_code, 201, r.text)
        body = r.json()
        self.assertEqual(body["origin"], "derived")
        self.assertEqual(body["emotion"], "angry")
        self.assertEqual(body["character_id"], "sarah")
        # Nothing was recorded: absent, never a zero-second take.
        self.assertIsNone(body["sample_seconds"])
        vid = body["voice_id"]
        self.assertIn(f"{vid}.safetensors", self.embeddings())
        row = self.meta()["voices"][vid]
        self.assertEqual(row["origin"], "derived")
        self.assertEqual(row["basis_version"], eb.BASIS_VERSION)
        self.assertGreaterEqual(row["confidence"], eb.MIN_COHERENCE)
        self.assertEqual(row["derived_from"]["source"], "basis")
        self.assertEqual(sorted(row["derived_from"]["contributors"]),
                         ["spk_mary", "spk_paul", "spk_vera"])

    def test_the_embedding_is_baseline_plus_the_calibrated_step(self) -> None:
        vid = self.derive().json()["voice_id"]
        written = fake_load(self.root / f"{vid}.safetensors")["e"]
        baseline = fake_load(self.root / "sarah-baseline.safetensors")["e"]
        basis, _ = eb.load(self.root)
        entry = basis.emotions["angry"]
        np.testing.assert_allclose(written, baseline + entry.alpha * entry.vector,
                                   rtol=1e-6, atol=1e-6)

    def test_the_consent_receipt_is_inherited_word_for_word(self) -> None:
        vid = self.derive().json()["voice_id"]
        row = self.meta()["voices"][vid]
        self.assertEqual(row["consent"], CONSENT)
        # ...and it is a COPY, so editing one cannot rewrite the other.
        self.assertIsNot(row["consent"], self.meta()["voices"]["sarah-baseline"]["consent"])

    def test_a_derived_voice_never_attests_on_its_own(self) -> None:
        # A baseline with no receipt must not acquire one by being derived from.
        self.rows["sarah-baseline"].pop("consent")
        self.save()
        body = self.derive().json()
        self.assertFalse(body["consent"])
        self.assertNotIn("consent", self.meta()["voices"][body["voice_id"]])

    def test_the_derived_row_names_where_it_came_from(self) -> None:
        vid = self.derive().json()["voice_id"]
        origin = self.meta()["voices"][vid]["derived_from"]
        self.assertEqual(origin["from_voice_id"], "sarah-baseline")
        self.assertEqual(origin["emotion"], "angry")
        self.assertIn("alpha", origin)

    def test_deriving_twice_collides_like_any_other_slot(self) -> None:
        self.assertEqual(self.derive().status_code, 201)
        vc.invalidate()
        self.assertEqual(self.derive().status_code, 409)

    def test_a_derived_voice_is_deleted_like_any_other(self) -> None:
        vid = self.derive().json()["voice_id"]
        self.assertEqual(self.client.delete(f"/v1/voices/{vid}").status_code, 204)
        self.assertNotIn(f"{vid}.safetensors", self.embeddings())
        self.assertNotIn(vid, self.meta()["voices"])


class TransferQualityGateTests(_DeriveCase):
    """Measured badly = refused. Never measured = allowed, and SAID so."""

    def setUp(self) -> None:
        super().setUp()
        self.build_basis()

    def _measured(self, quality: float) -> None:
        reason = eb.write_transfer(self.root, {"angry": {
            "quality": quality, "speakers": 3, "in_sample": 2}})
        self.assertIsNone(reason, reason)
        vc.invalidate()

    def test_an_emotion_measured_below_the_bar_is_refused_with_both_numbers(self) -> None:
        self._measured(0.2)
        r = self.derive()
        self.assertEqual(r.status_code, 422)
        detail = r.json()["detail"]
        self.assertIn("transfer quality 0.20", detail)
        self.assertIn(f"{eb.MIN_TRANSFER_QUALITY:.2f}", detail)
        self.assertIn("3 speaker(s)", detail)
        # Refused BEFORE anything is written.
        self.assertNotIn("sarah-angry", "".join(self.embeddings()))

    def test_an_emotion_measured_above_the_bar_derives_and_records_the_number(self) -> None:
        self._measured(0.91)
        r = self.derive()
        self.assertEqual(r.status_code, 201, r.text)
        transfer = self.meta()["voices"][r.json()["voice_id"]]["derived_from"]["transfer"]
        self.assertEqual(transfer["quality"], 0.91)
        self.assertEqual(transfer["speakers"], 3)
        self.assertEqual(transfer["in_sample"], 2)

    def test_an_unmeasured_emotion_derives_and_is_flagged_unmeasured(self) -> None:
        # Absence of a measurement is not evidence of a bad voice -- but the row
        # must never look like it was measured and passed.
        r = self.derive()
        self.assertEqual(r.status_code, 201, r.text)
        transfer = self.meta()["voices"][r.json()["voice_id"]]["derived_from"]["transfer"]
        self.assertIsNone(transfer["quality"])
        self.assertEqual(transfer["state"], "unmeasured")

    def test_the_marker_reaches_the_api_response(self) -> None:
        r = self.derive()
        self.assertEqual(r.json()["derived_from"]["transfer"]["state"], "unmeasured")

    def test_a_transfer_block_this_service_cannot_read_is_absent_not_fatal(self) -> None:
        path = self.root / eb.BASIS_JSON
        raw = json.loads(path.read_text("utf-8"))
        raw[eb.TRANSFER_KEY] = {"version": eb.TRANSFER_VERSION + 9,
                                "emotions": {"angry": {"quality": 0.0,
                                                       "speakers": 3}}}
        path.write_text(json.dumps(raw), "utf-8")
        vc.invalidate()
        r = self.derive()
        # A quality of 0.0 from a version we cannot interpret must neither
        # refuse the derive nor be reported as this voice's quality.
        self.assertEqual(r.status_code, 201, r.text)
        # Asserted by MEANING rather than by exact dict: the transfer row is now
        # emotion_basis.transfer_payload(), which deliberately emits the same key
        # set in all three states so no consumer infers anything from a missing
        # key. The two keys this test has always cared about carry the same
        # values they always did; what changed is that the row is no longer a
        # different SHAPE depending on whether anything was measured.
        transfer = r.json()["derived_from"]["transfer"]
        self.assertEqual(transfer["state"], eb.TRANSFER_UNMEASURED)
        self.assertIsNone(transfer["quality"])
        self.assertIsNone(transfer["measured"])

    def test_a_donor_transplant_is_not_gated_by_a_number_about_the_basis(self) -> None:
        # The harness measures BASIS directions. A named donor is a different,
        # inspectable choice the user made -- and it records "unmeasured" rather
        # than borrowing a number that was not about it.
        self._measured(0.2)
        r = self.derive(donor_character_id="spk_mary")
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.json()["derived_from"]["transfer"]["state"], "unmeasured")


class DonorTests(_DeriveCase):
    def test_a_named_donor_transplants_that_speakers_own_delta(self) -> None:
        r = self.derive(donor_character_id="spk_mary")
        self.assertEqual(r.status_code, 201, r.text)
        vid = r.json()["voice_id"]
        origin = self.meta()["voices"][vid]["derived_from"]
        self.assertEqual(origin["source"], "donor")
        self.assertEqual(origin["donor"], "spk_mary")
        self.assertEqual(origin["donor_voice_id"], "spk_mary-angry")
        written = fake_load(self.root / f"{vid}.safetensors")["e"]
        baseline = fake_load(self.root / "sarah-baseline.safetensors")["e"]
        donor_delta = (fake_load(self.root / "spk_mary-angry.safetensors")["e"]
                       - fake_load(self.root / "spk_mary-baseline.safetensors")["e"])
        np.testing.assert_allclose(written, baseline + donor_delta, rtol=1e-6, atol=1e-6)

    def test_the_donor_path_needs_no_basis_at_all(self) -> None:
        # ...which is the point: one good take anywhere in the roster is usable
        # before the corpus is big enough to average.
        self.assertFalse((self.root / eb.BASIS_JSON).is_file())
        self.assertEqual(self.derive(donor_character_id="spk_mary").status_code, 201)

    def test_confidence_stays_absent_when_nothing_measured_it(self) -> None:
        vid = self.derive(donor_character_id="spk_mary").json()["voice_id"]
        row = self.meta()["voices"][vid]
        self.assertIsNone(row["confidence"])  # absent, never a fabricated 0
        self.assertIsNone(row["basis_version"])

    def test_a_donor_without_the_emotion_is_named(self) -> None:
        r = self.derive(donor_character_id="sarah")
        self.assertEqual(r.status_code, 422)
        self.assertIn("no 'angry' voice", r.json()["detail"])

    def test_a_donor_whose_take_is_itself_derived_is_refused(self) -> None:
        self.rows["spk_mary-angry"]["origin"] = "derived"
        self.save()
        r = self.derive(donor_character_id="spk_mary")
        self.assertEqual(r.status_code, 422)
        self.assertIn("compounds", r.json()["detail"])

    def test_an_unknown_donor_is_a_404(self) -> None:
        self.assertEqual(self.derive(donor_character_id="nobody").status_code, 404)


class StagingTests(_DeriveCase):
    """A failure must leave the registry and the voices dir exactly as they were."""

    def setUp(self) -> None:
        super().setUp()
        self.build_basis()
        self.before = self.embeddings()

    def test_a_failed_commit_leaves_no_orphan_embedding(self) -> None:
        # The glob-driven roster turns a stray .safetensors into a Character the
        # user never asked for; staging in a temp dir is what prevents it.
        with mock.patch.object(vc, "mutate_meta",
                               side_effect=HTTPException(409, "slot taken")):
            r = self.derive()
        self.assertEqual(r.status_code, 409)
        self.assertEqual(self.embeddings(), self.before)

    def test_an_embedding_that_does_not_load_back_registers_nothing(self) -> None:
        real_load = fake_load

        def broken(path):
            tensors = real_load(path)
            # The staged file lives in a temp dir, never under the voices dir --
            # so this breaks the load-BACK only, exactly the failure the
            # round-trip exists to catch.
            if Path(path).parent != self.root:
                return {"unexpected": np.zeros(3)}
            return tensors

        with mock.patch.object(res, "load_embedding", broken):
            r = self.derive()
        self.assertEqual(r.status_code, 500)
        self.assertEqual(self.embeddings(), self.before)
        self.assertEqual(sorted(self.meta()["voices"]), sorted(self.rows))

    def test_a_basis_built_for_another_model_is_refused_before_any_write(self) -> None:
        self.rows["sarah-baseline"]["emotion"] = "baseline"
        fake_save(self.root / "sarah-baseline.safetensors", {"e": np.ones(3)})
        self.save()
        r = self.derive()
        self.assertEqual(r.status_code, 422)
        self.assertIn("rebuild the basis", r.json()["detail"])
        self.assertEqual(self.embeddings(), self.before)


class SurfaceTests(_DeriveCase):
    """What the rest of the service says about a derived slot."""

    def setUp(self) -> None:
        super().setUp()
        self.build_basis()
        self.vid = self.derive().json()["voice_id"]
        vc.invalidate()

    def test_the_manifest_splits_recorded_from_derived(self) -> None:
        m = self.client.get("/v1/characters/sarah/manifest").json()
        self.assertIn("angry", m["performable"])          # it can be spoken...
        self.assertNotIn("angry", m["recorded"])          # ...but nobody performed it
        self.assertIn("angry", m["derived"])
        self.assertIn("angry", m["unrecorded"])           # so it still wants a take
        self.assertNotIn("angry", m["missing"])           # and it is not missing
        self.assertEqual(m["performable"]["angry"]["origin"], "derived")
        self.assertEqual(m["performable"]["baseline"]["origin"], "recorded")

    def test_resolve_reports_a_derived_hit_as_a_fallback(self) -> None:
        # Demand is recorded off `fell_back`; a derived slot must not silence the
        # appetite for the recording it stands in for.
        emap = vc.emotion_map("sarah")
        self.assertEqual(emap.derived, frozenset({"angry"}))
        voice_id, used, fell_back = em.resolve("angry", emap)
        self.assertEqual((voice_id, used), (self.vid, "angry"))
        self.assertTrue(fell_back)

    def test_a_recorded_hit_is_still_not_a_fallback(self) -> None:
        emap = vc.emotion_map("sarah")
        self.assertEqual(em.resolve("baseline", emap)[2], False)

    def test_the_roster_reports_the_origin_of_every_voice(self) -> None:
        c = self.client.get("/v1/characters/sarah").json()
        by_emotion = {v["emotion"]: v for v in c["voices"]}
        self.assertEqual(by_emotion["angry"]["origin"], "derived")
        self.assertEqual(by_emotion["angry"]["derived_from"]["donor"], None)
        self.assertEqual(by_emotion["baseline"]["origin"], "recorded")

    def test_untouched_voices_report_recorded_without_a_migration(self) -> None:
        # No registry row in this suite carries `origin` except the derived one.
        c = self.client.get("/v1/characters/spk_mary").json()
        self.assertTrue(all(v["origin"] == "recorded" for v in c["voices"]))
        self.assertTrue(all(v["derived_from"] is None for v in c["voices"]))

    def test_the_basis_file_is_not_a_character(self) -> None:
        # The roster is glob-driven; `_basis.safetensors` sits in the same
        # directory and must never assemble into a Character.
        ids = [c["character_id"] for c in self.client.get("/v1/characters").json()]
        self.assertNotIn("basis", ids)
        self.assertNotIn("_basis", ids)


if __name__ == "__main__":
    unittest.main()
