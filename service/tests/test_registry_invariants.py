"""The registry's WRITE routes must obey the registry's own invariants.

`(character_id, emotion)` is the registry's real primary key: `emotion_map`
(the synthesis lookup) and the manifest both reduce a Character's voices to one
per emotion, so a second row for a slot is a Voice the roster shows and
synthesis can never reach. And an emotion that isn't `normalize_emotion`-shaped
cannot be addressed by the metatag grammar at all.

`PATCH /v1/voices/{id}` enforced NEITHER — it lower-cased a string into the row
— and `PATCH /v1/characters/{id}` would rename a built-in and mint a row for an
id with no voices, while three sibling routes refuse built-ins. None of these
routes (nor DELETE /v1/voices, DELETE /v1/characters, GET /v1/emotions, the
custom-emotion routes, or the manifest) had a single test.

Nothing heavy runs here: voices are seeded straight into a temp registry as
`.safetensors` files + `_meta.json` rows, exactly what a finished clone leaves
behind. The whole registry (VOICES_DIR / META_PATH / the import-bound
_META_LOCK_PATH) is redirected into that temp dir — no test here may touch the
repo's voices/ directory.
"""
from __future__ import annotations

import json
import unittest
import wave
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from service.tests import fake_engine  # installs shims — must precede app import

import service.app as appmod
import service.ingest as ingest
import service.voices as vc
from fastapi import HTTPException
from fastapi.testclient import TestClient

# One concrete built-in, chosen rather than pulled out of the (unordered)
# BUILTIN_IDS set: `_slug` maps a user's typed name onto an id, and the
# underscore-bearing built-ins ("bill_boerst") slug to a DIFFERENT id, so an
# arbitrary pick made the ingest-collision test depend on hash order.
BUILTIN_ID = "mary"


class _RegistryTestCase(unittest.TestCase):
    """A temp registry plus helpers to seed Voices without cloning anything."""

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
        ]
        for p in self._patches:
            p.start()
        vc.invalidate()

    def tearDown(self) -> None:
        for p in self._patches:
            p.stop()
        vc.invalidate()
        self._dir.cleanup()

    # ── seeding ───────────────────────────────────────────────────────────────
    def seed(self, character_id: str, emotions: list[str], *, name: str | None = None,
             custom: list[str] | None = None) -> dict[str, str]:
        """Register one Character with a Voice per emotion. Returns emotion->voice_id."""
        meta = vc._load_meta()
        ids: dict[str, str] = {}
        for i, emo in enumerate(emotions):
            vid = f"{character_id}-{emo}-{i:02d}"
            (self.root / f"{vid}.safetensors").write_bytes(b"fake-embedding")
            meta["voices"][vid] = {
                "name": name or character_id, "character_id": character_id,
                "emotion": emo, "created": "2026-01-01T00:00:00+00:00",
                "sample_seconds": 12.0, "lang": "EN"}
            ids[emo] = vid
        cm = meta["characters"].setdefault(
            character_id, {"name": name or character_id, "tags": []})
        if custom:
            cm["custom_emotions"] = list(custom)
        vc._save_meta(meta)
        vc.invalidate()
        return ids

    def seed_duplicate(self, character_id: str, emotion: str) -> tuple[str, str]:
        """Two rows for ONE slot — what a pre-uniqueness install can hold."""
        first = self.seed(character_id, [emotion])[emotion]
        meta = vc._load_meta()
        second = f"{character_id}-{emotion}-99"
        (self.root / f"{second}.safetensors").write_bytes(b"fake-embedding")
        meta["voices"][second] = {**meta["voices"][first]}
        vc._save_meta(meta)
        vc.invalidate()
        return first, second

    def registry_bytes(self) -> bytes:
        return (self.root / "_meta.json").read_bytes()

    def rows(self) -> dict:
        return json.loads(self.registry_bytes())


# ── PATCH /v1/voices ──────────────────────────────────────────────────────────
class PatchVoiceEmotionTests(_RegistryTestCase):
    def test_emotion_is_normalized_not_merely_lowercased(self) -> None:
        # "Battle Cry" used to land in the registry verbatim-but-lowercased
        # ("battle cry"), which the metatag grammar can never address.
        ids = self.seed("ada", ["baseline"])
        r = self.client.patch(f"/v1/voices/{ids['baseline']}",
                              json={"emotion": "Battle Cry"})
        self.assertEqual(200, r.status_code, r.text)
        self.assertEqual("battle_cry", r.json()["emotion"])
        self.assertEqual("battle_cry",
                         self.rows()["voices"][ids["baseline"]]["emotion"])

    def test_a_novel_emotion_registers_as_a_custom_slot(self) -> None:
        ids = self.seed("ada", ["baseline"])
        self.client.patch(f"/v1/voices/{ids['baseline']}", json={"emotion": "battle_cry"})
        self.assertIn("battle_cry",
                      self.rows()["characters"]["ada"].get("custom_emotions", []))
        scale = self.client.get("/v1/emotions", params={"character_id": "ada"}).json()
        self.assertIn("battle_cry", scale)

    def test_ungrammatical_emotions_are_rejected_and_change_nothing(self) -> None:
        ids = self.seed("ada", ["baseline"])
        before = self.registry_bytes()
        for hostile in ("../../evil", "a.b", "/tmp/evil", "..%2fevil", "x", ""):
            with self.subTest(emotion=hostile):
                r = self.client.patch(f"/v1/voices/{ids['baseline']}",
                                      json={"emotion": hostile})
                self.assertEqual(400, r.status_code, r.text)
                self.assertEqual(before, self.registry_bytes(),
                                 "a rejected patch rewrote the registry")

    def test_duplicate_slot_is_refused_and_names_the_holder(self) -> None:
        # Both voices claiming 'sad' is the silent-drop bug: emotion_map keeps
        # one, coverage counts two.
        ids = self.seed("ada", ["baseline", "sad"])
        before = self.registry_bytes()
        r = self.client.patch(f"/v1/voices/{ids['baseline']}", json={"emotion": "sad"})
        self.assertEqual(409, r.status_code, r.text)
        # There is no merge/rename flow, so the error must identify the Voice
        # holding the slot or the user cannot act on it.
        self.assertIn(ids["sad"], r.json()["detail"])
        self.assertEqual(before, self.registry_bytes())

    def test_reslotting_a_voice_onto_its_own_emotion_is_not_a_collision(self) -> None:
        ids = self.seed("ada", ["baseline", "sad"])
        r = self.client.patch(f"/v1/voices/{ids['sad']}", json={"emotion": "sad"})
        self.assertEqual(200, r.status_code, r.text)
        self.assertEqual("sad", r.json()["emotion"])

    def test_a_free_slot_still_accepts_the_move(self) -> None:
        ids = self.seed("ada", ["baseline"])
        r = self.client.patch(f"/v1/voices/{ids['baseline']}", json={"emotion": "happy"})
        self.assertEqual(200, r.status_code, r.text)
        self.assertEqual({"happy": ids["baseline"]}, vc.emotion_map("ada"))

    def test_unknown_voice_is_404(self) -> None:
        self.seed("ada", ["baseline"])
        r = self.client.patch("/v1/voices/nope", json={"emotion": "happy"})
        self.assertEqual(404, r.status_code)

    def test_the_removed_name_field_is_rejected_not_silently_ignored(self) -> None:
        # It used to be accepted, written to a row nothing reads, and echoed
        # back as the CHARACTER's name — the API reported a change it never made.
        ids = self.seed("ada", ["baseline"], name="Ada")
        r = self.client.patch(f"/v1/voices/{ids['baseline']}", json={"name": "Zed"})
        self.assertEqual(422, r.status_code, r.text)
        self.assertEqual("Ada", self.rows()["characters"]["ada"]["name"])


# ── PATCH /v1/characters ──────────────────────────────────────────────────────
class PatchCharacterTests(_RegistryTestCase):
    def test_builtin_cannot_be_renamed(self) -> None:
        builtin = BUILTIN_ID
        r = self.client.patch(f"/v1/characters/{builtin}", json={"name": "Hijacked"})
        self.assertEqual(409, r.status_code, r.text)
        self.assertEqual("premade", self.client.get(
            f"/v1/characters/{builtin}").json()["category"])
        self.assertFalse((self.root / "_meta.json").is_file(),
                         "a refused patch created a registry")

    def test_unknown_character_is_404_and_mints_no_ghost_row(self) -> None:
        self.seed("ada", ["baseline"])
        r = self.client.patch("/v1/characters/typo", json={"name": "Typo"})
        self.assertEqual(404, r.status_code, r.text)
        self.assertNotIn("typo", self.rows()["characters"])

    def test_cloned_character_renames_and_retags(self) -> None:
        self.seed("ada", ["baseline"], name="Ada")
        r = self.client.patch("/v1/characters/ada",
                              json={"name": "Ada Lovelace", "tags": [" Narrator "]})
        self.assertEqual(200, r.status_code, r.text)
        self.assertEqual("Ada Lovelace", r.json()["name"])
        self.assertEqual(["narrator"], r.json()["tags"])


# ── DELETE routes ─────────────────────────────────────────────────────────────
class DeleteRouteTests(_RegistryTestCase):
    def test_delete_voice_removes_file_and_row(self) -> None:
        ids = self.seed("ada", ["baseline", "sad"])
        r = self.client.delete(f"/v1/voices/{ids['sad']}")
        self.assertEqual(204, r.status_code, r.text)
        self.assertFalse((self.root / f"{ids['sad']}.safetensors").exists())
        self.assertNotIn(ids["sad"], self.rows()["voices"])
        self.assertIn(ids["baseline"], self.rows()["voices"])

    def test_delete_unknown_voice_is_404(self) -> None:
        self.seed("ada", ["baseline"])
        self.assertEqual(404, self.client.delete("/v1/voices/nope").status_code)

    def test_builtin_voice_cannot_be_deleted(self) -> None:
        builtin = BUILTIN_ID
        self.assertEqual(404, self.client.delete(f"/v1/voices/{builtin}").status_code)

    def test_delete_character_takes_every_voice_with_it(self) -> None:
        ids = self.seed("ada", ["baseline", "sad"])
        r = self.client.delete("/v1/characters/ada")
        self.assertEqual(204, r.status_code, r.text)
        self.assertEqual({}, self.rows()["voices"])
        self.assertNotIn("ada", self.rows()["characters"])
        for vid in ids.values():
            self.assertFalse((self.root / f"{vid}.safetensors").exists())

    def test_builtin_character_cannot_be_deleted(self) -> None:
        builtin = BUILTIN_ID
        self.assertEqual(404, self.client.delete(f"/v1/characters/{builtin}").status_code)


# ── /v1/emotions and the custom-slot routes ───────────────────────────────────
class EmotionScaleRouteTests(_RegistryTestCase):
    def test_base_scale_and_per_character_scale(self) -> None:
        self.seed("ada", ["baseline"], custom=["battle_cry"])
        self.assertEqual(vc.EMOTION_SCALE, self.client.get("/v1/emotions").json())
        scale = self.client.get("/v1/emotions", params={"character_id": "ada"}).json()
        self.assertEqual(vc.EMOTION_SCALE + ["battle_cry"], scale)

    def test_unknown_character_scale_is_404(self) -> None:
        self.assertEqual(404, self.client.get(
            "/v1/emotions", params={"character_id": "nobody"}).status_code)

    def test_custom_emotion_is_normalized_on_the_way_in(self) -> None:
        self.seed("ada", ["baseline"])
        r = self.client.post("/v1/characters/ada/emotions", json={"name": "Battle Cry"})
        self.assertEqual(201, r.status_code, r.text)
        self.assertIn("battle_cry", r.json()["custom_emotions"])

    def test_hostile_custom_emotion_is_rejected(self) -> None:
        self.seed("ada", ["baseline"])
        before = self.registry_bytes()
        r = self.client.post("/v1/characters/ada/emotions", json={"name": "../../evil"})
        self.assertEqual(400, r.status_code, r.text)
        self.assertEqual(before, self.registry_bytes())

    def test_builtin_cannot_be_extended(self) -> None:
        builtin = BUILTIN_ID
        r = self.client.post(f"/v1/characters/{builtin}/emotions", json={"name": "sarcastic"})
        self.assertEqual(404, r.status_code, r.text)

    def test_removing_a_slot_a_voice_occupies_is_refused(self) -> None:
        self.seed("ada", ["baseline", "battle_cry"], custom=["battle_cry"])
        r = self.client.delete("/v1/characters/ada/emotions/battle_cry")
        self.assertEqual(409, r.status_code, r.text)
        self.assertIn("battle_cry", self.rows()["characters"]["ada"]["custom_emotions"])

    def test_removing_an_empty_slot_normalizes_the_path_param(self) -> None:
        # 'battle-cry' addresses the slot 'battle_cry' the POST created.
        self.seed("ada", ["baseline"], custom=["battle_cry"])
        r = self.client.delete("/v1/characters/ada/emotions/battle-cry")
        self.assertEqual(204, r.status_code, r.text)
        self.assertEqual([], self.rows()["characters"]["ada"]["custom_emotions"])

    def test_base_scale_slots_cannot_be_removed(self) -> None:
        self.seed("ada", ["baseline"])
        self.assertEqual(400, self.client.delete(
            "/v1/characters/ada/emotions/happy").status_code)


# ── pre-existing duplicate rows (tolerated, never crashed on) ─────────────────
class PreExistingDuplicateSlotTests(_RegistryTestCase):
    """A live install written before uniqueness was enforced everywhere can
    hold two rows for one slot. The read path TOLERATES that: both Voices stay
    visible (an invisible Voice is an undeletable one), coverage counts distinct
    emotions, and every reader agrees on which one actually speaks."""

    def test_roster_keeps_both_voices_and_counts_the_slot_once(self) -> None:
        first, second = self.seed_duplicate("ada", "sad")
        c = self.client.get("/v1/characters/ada").json()
        self.assertEqual({first, second}, {v["voice_id"] for v in c["voices"]})
        self.assertEqual(1, c["coverage"])

    def test_manifest_and_emotion_map_pick_the_same_voice(self) -> None:
        first, _second = self.seed_duplicate("ada", "sad")
        manifest = self.client.get("/v1/characters/ada/manifest").json()
        self.assertEqual(first, manifest["performable"]["sad"]["voice_id"])
        self.assertEqual(first, vc.emotion_map("ada")["sad"])

    def test_the_duplicate_can_be_deleted_to_resolve_it(self) -> None:
        _first, second = self.seed_duplicate("ada", "sad")
        self.assertEqual(204, self.client.delete(f"/v1/voices/{second}").status_code)
        self.assertNotIn(second, self.rows()["voices"])


# ── the manifest ──────────────────────────────────────────────────────────────
class ManifestTests(_RegistryTestCase):
    def test_manifest_reports_performable_missing_and_fallback(self) -> None:
        ids = self.seed("ada", ["baseline", "sad"])
        m = self.client.get("/v1/characters/ada/manifest").json()
        self.assertEqual({"baseline", "sad"}, set(m["performable"]))
        self.assertEqual(ids["sad"], m["performable"]["sad"]["voice_id"])
        self.assertNotIn("baseline", m["missing"])
        self.assertIn("happy", m["missing"])
        self.assertEqual(f"{2}/{len(m['emotion_scale'])}", m["coverage"])

    def test_unknown_character_manifest_is_404(self) -> None:
        self.assertEqual(404, self.client.get("/v1/characters/nobody/manifest").status_code)


# ── the ingest commit boundary ────────────────────────────────────────────────
class IngestCommitInvariantTests(_RegistryTestCase):
    """`ingest.commit` is the third creation path and enforced neither rule."""

    def _stem(self, work: Path, emotion: str, seconds: float = 8.0) -> None:
        with wave.open(str(work / f"stem_{emotion}.wav"), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(24000)
            w.writeframes(b"\x00\x00" * int(24000 * seconds))

    def test_a_name_colliding_with_a_builtin_is_refused_before_any_work(self) -> None:
        builtin = BUILTIN_ID
        with TemporaryDirectory() as td:
            work = Path(td)
            self._stem(work, "baseline")
            with mock.patch.object(ingest.subprocess, "Popen") as popen:
                with self.assertRaises(HTTPException) as ctx:
                    ingest.commit(work, builtin, ["baseline"])
            self.assertEqual(409, ctx.exception.status_code)
            popen.assert_not_called()
            self.assertFalse(list(self.root.glob("*.safetensors")))

    def test_an_extend_skips_an_emotion_the_character_already_has(self) -> None:
        # Cloning a second voice for a filled slot used to succeed silently;
        # only one of the two would ever be reachable through emotion_map.
        self.seed("ada", ["baseline"])
        before = self.registry_bytes()
        with TemporaryDirectory() as td:
            work = Path(td)
            self._stem(work, "baseline")
            with mock.patch.object(ingest.subprocess, "Popen") as popen:
                created = ingest.commit(work, "Ada", ["baseline"], existing_cid="ada")
            popen.assert_not_called()  # nothing left to export
        self.assertEqual([], created)
        self.assertEqual(before, self.registry_bytes())
