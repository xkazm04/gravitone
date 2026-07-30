"""The appliance manifest — the artifact's own answer to "what are you?".

Everything here runs against FIXTURE model trees (temp dirs holding a few tiny
files), never a real bake: the point of the module is the reporting contract,
and a test that needed 1 GB of weights would never run.

Two behaviours are load-bearing and both are asserted:
  * a sealed tree produces per-file sha256 + provenance, and the same
    canonicalization/HMAC pattern service/packs.py already ships;
  * an UNSEALED tree (a dev box, or a slim image) still answers 200 and NAMES
    what is missing with the command that fixes it. Silence there is how an
    operator finds out at first call that the box wanted the internet.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import tempfile
import unittest
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service import appliance


def _write(path: Path, data: bytes = b"weights") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


class _TreeCase(unittest.TestCase):
    """A temp model tree, with the env restored afterwards."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self._env = {k: os.environ.get(k) for k in
                     ("GRAVITONE_MODELS_DIR", "TTS_APPLIANCE_SECRET",
                      "TTS_PACK_SECRET", "HF_HUB_OFFLINE", "HF_HOME",
                      "STT_DOWNLOAD_ROOT", "DIARIZE_MODELS_DIR",
                      "PIPER_VOICES_DIR", "GRAVITONE_IMAGE_DIGEST")}
        for key in self._env:
            os.environ.pop(key, None)
        os.environ["GRAVITONE_MODELS_DIR"] = str(self.root)
        appliance._CACHE.clear()

    def tearDown(self) -> None:
        for key, value in self._env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        appliance._CACHE.clear()
        self._tmp.cleanup()

    def bake(self, *, piper: bool = True) -> None:
        """A miniature of the real bake layout."""
        _write(self.root / "hf" / "models--pocket-tts" / "blobs" / "model.safetensors")
        _write(self.root / "whisper" / "model.bin", b"ct2")
        _write(self.root / "diarization" / "wespeaker_en_voxceleb_CAM++.onnx", b"emb")
        _write(self.root / "diarization"
               / "sherpa-onnx-pyannote-segmentation-3-0" / "model.onnx", b"seg")
        if piper:
            _write(self.root / "piper_voices" / "cs_CZ-jirka-medium.onnx", b"onnx")
            _write(self.root / "piper_voices" / "cs_CZ-jirka-medium.onnx.json", b"{}")


class UnsealedTests(_TreeCase):
    def test_empty_tree_is_unsealed_and_names_every_missing_component(self) -> None:
        manifest = appliance.build_manifest()
        self.assertEqual(manifest["seal"], "unsealed")
        self.assertEqual(manifest["models"], [])
        named = {m["component"] for m in manifest["missing"]}
        self.assertEqual(named, {c.name for c in appliance.COMPONENTS})

    def test_every_missing_entry_carries_a_remedy_and_a_real_path(self) -> None:
        for entry in appliance.build_manifest()["missing"]:
            with self.subTest(component=entry["component"]):
                self.assertTrue(entry["remedy"])
                # A remedy that still says "<root>" is a template, not an answer.
                self.assertNotIn("<root>", entry["remedy"])
                self.assertTrue(entry["expected_dir"].startswith(str(self.root)))
                self.assertTrue(entry["why"])

    def test_a_directory_with_no_model_files_is_missing_not_present(self) -> None:
        (self.root / "whisper").mkdir(parents=True)
        entry = next(m for m in appliance.build_manifest()["missing"]
                     if m["component"] == "whisper")
        self.assertIn("no model files", entry["why"])

    def test_piper_is_optional_for_the_seal(self) -> None:
        # An image without extra languages is still a sealed appliance; one
        # without ears is not. Piper is the only component that may be absent.
        self.bake(piper=False)
        manifest = appliance.build_manifest()
        self.assertEqual(manifest["seal"], "sealed")
        self.assertEqual([m["component"] for m in manifest["missing"]],
                         ["piper-voices"])

    def test_capabilities_are_false_when_nothing_is_baked(self) -> None:
        caps = appliance.build_manifest()["capabilities"]
        self.assertFalse(any(caps.values()), caps)


class SealedTreeTests(_TreeCase):
    def setUp(self) -> None:
        super().setUp()
        self.bake()

    def test_sealed_tree_reports_sealed(self) -> None:
        self.assertEqual(appliance.build_manifest()["seal"], "sealed")
        self.assertEqual(appliance.build_manifest()["missing"], [])

    def test_every_file_carries_the_real_sha256(self) -> None:
        whisper = next(m for m in appliance.build_manifest()["models"]
                       if m["component"] == "whisper")
        entry = next(f for f in whisper["files"] if f["path"] == "model.bin")
        self.assertEqual(entry["sha256"], hashlib.sha256(b"ct2").hexdigest())
        self.assertEqual(entry["bytes"], 3)

    def test_nested_files_are_relative_posix_paths(self) -> None:
        diar = next(m for m in appliance.build_manifest()["models"]
                    if m["component"] == "diarization")
        paths = {f["path"] for f in diar["files"]}
        self.assertIn("sherpa-onnx-pyannote-segmentation-3-0/model.onnx", paths)

    def test_every_component_declares_provenance(self) -> None:
        for model in appliance.build_manifest()["models"]:
            with self.subTest(component=model["component"]):
                self.assertTrue(model["provenance"])
                self.assertTrue(model["license"])

    def test_locales_come_from_the_voice_filenames(self) -> None:
        manifest = appliance.build_manifest()
        self.assertEqual(manifest["locales"]["piper_voices"], ["cs_CZ"])
        self.assertIn("cs", manifest["locales"]["speak"])
        # Pocket TTS's own two languages, reported only because it is baked.
        self.assertIn("en", manifest["locales"]["speak"])
        self.assertIn("fr", manifest["locales"]["speak"])

    def test_env_pointing_is_reported_not_assumed(self) -> None:
        # A baked tree the process does not look at is not a sealed box.
        model = next(m for m in appliance.build_manifest()["models"]
                     if m["component"] == "whisper")
        self.assertFalse(model["env_points_here"])
        os.environ["STT_DOWNLOAD_ROOT"] = str(self.root / "whisper")
        model = next(m for m in appliance.build_manifest()["models"]
                     if m["component"] == "whisper")
        self.assertTrue(model["env_points_here"])

    def test_offline_enforcement_is_reported_from_the_environment(self) -> None:
        self.assertFalse(appliance.build_manifest()["offline_enforced"])
        os.environ["HF_HUB_OFFLINE"] = "1"
        self.assertTrue(appliance.build_manifest()["offline_enforced"])

    def test_model_bytes_sums_only_hashed_files(self) -> None:
        self.assertEqual(appliance.build_manifest()["model_bytes"],
                         len(b"weights") + len(b"ct2") + len(b"emb")
                         + len(b"seg") + len(b"onnx") + len(b"{}"))

    def test_license_review_is_declared_unresolved(self) -> None:
        # A legal review step, deliberately not resolved in code.
        self.assertIn("UNRESOLVED", appliance.build_manifest()["license_review"])


class SignatureTests(_TreeCase):
    def setUp(self) -> None:
        super().setUp()
        self.bake()

    def test_unsigned_when_no_secret_is_configured(self) -> None:
        self.assertNotIn("signature", appliance.build_manifest())

    def test_signature_matches_the_packs_canonicalization(self) -> None:
        os.environ["TTS_APPLIANCE_SECRET"] = "s3cret"
        manifest = appliance.build_manifest()
        unsigned = {k: v for k, v in manifest.items() if k != "signature"}
        want = hmac.new(b"s3cret",
                        json.dumps(unsigned, sort_keys=True,
                                   separators=(",", ":")).encode(),
                        hashlib.sha256).hexdigest()
        self.assertEqual(manifest["signature"]["alg"], "HMAC-SHA256")
        self.assertEqual(manifest["signature"]["value"], want)
        self.assertTrue(appliance.verify_signature(manifest))

    def test_a_tampered_manifest_fails_verification(self) -> None:
        os.environ["TTS_PACK_SECRET"] = "fallback"   # secondary source, as documented
        manifest = appliance.build_manifest()
        self.assertTrue(appliance.verify_signature(manifest))
        manifest["models"][0]["files"][0]["sha256"] = "0" * 64
        self.assertFalse(appliance.verify_signature(manifest))

    def test_stripping_the_signature_does_not_pass(self) -> None:
        os.environ["TTS_APPLIANCE_SECRET"] = "s3cret"
        manifest = appliance.build_manifest()
        manifest.pop("signature")
        self.assertFalse(appliance.verify_signature(manifest))


class SealFileTests(_TreeCase):
    def test_write_seal_records_the_bake_and_is_read_back(self) -> None:
        self.bake()
        os.environ["GRAVITONE_IMAGE_REF"] = "gravitone:test"
        try:
            path = appliance.write_seal()
        finally:
            os.environ.pop("GRAVITONE_IMAGE_REF", None)
        self.assertTrue(path.is_file())
        seal = appliance.read_seal()
        self.assertEqual(seal["image_ref"], "gravitone:test")
        self.assertEqual(seal["piper_voices"], ["cs_CZ"])
        self.assertIn("whisper", seal["components"])
        self.assertEqual(appliance.build_manifest()["baked"]["image_ref"],
                         "gravitone:test")

    def test_an_unreadable_seal_is_ignored_not_fatal(self) -> None:
        self.bake()
        (self.root / appliance.SEAL_FILE).write_text("{not json", "utf-8")
        self.assertIsNone(appliance.read_seal())
        self.assertEqual(appliance.build_manifest()["seal"], "sealed")

    def test_the_seal_file_itself_is_not_a_model(self) -> None:
        # SEAL.json lives at the tree root, outside every component dir, so it
        # can never end up hashed into the manifest that describes it.
        self.bake()
        appliance.write_seal()
        paths = [f["path"] for m in appliance.build_manifest()["models"]
                 for f in m["files"]]
        self.assertNotIn(appliance.SEAL_FILE, paths)


class RouteTests(_TreeCase):
    """The router is standalone by design — service/app.py is not touched here;
    the orchestrator wires it with the include line stated in the report."""

    def setUp(self) -> None:
        super().setUp()
        app = FastAPI()
        app.include_router(appliance.router)
        self.client = TestClient(app)

    def test_unsealed_box_answers_200_not_500(self) -> None:
        resp = self.client.get("/v1/appliance")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["seal"], "unsealed")
        self.assertTrue(body["missing"])

    def test_sealed_box_reports_its_models(self) -> None:
        self.bake()
        body = self.client.get("/v1/appliance", params={"refresh": "true"}).json()
        self.assertEqual(body["seal"], "sealed")
        self.assertEqual(body["format"], appliance.FORMAT)
        self.assertEqual({m["component"] for m in body["models"]},
                         {c.name for c in appliance.COMPONENTS})

    def test_the_manifest_is_cached_until_refresh(self) -> None:
        first = self.client.get("/v1/appliance").json()
        self.bake()
        self.assertEqual(self.client.get("/v1/appliance").json()["generated_at"],
                         first["generated_at"])
        self.assertEqual(
            self.client.get("/v1/appliance", params={"refresh": "true"}).json()["seal"],
            "sealed")

    def test_verify_without_a_secret_is_a_400_not_a_false_ok(self) -> None:
        resp = self.client.get("/v1/appliance", params={"verify": "true"})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("TTS_APPLIANCE_SECRET", resp.json()["detail"])

    def test_verify_passes_on_a_signed_manifest(self) -> None:
        os.environ["TTS_APPLIANCE_SECRET"] = "s3cret"
        resp = self.client.get("/v1/appliance",
                               params={"verify": "true", "refresh": "true"})
        self.assertEqual(resp.status_code, 200)
        self.assertIn("signature", resp.json())

    def test_the_response_is_json_serializable_as_handed_over(self) -> None:
        # The manifest is a file customers diff; it must survive a round trip
        # byte-for-byte through the canonical form.
        self.bake()
        body = self.client.get("/v1/appliance", params={"refresh": "true"}).json()
        self.assertEqual(json.loads(appliance._canonical(body).decode())["seal"],
                         "sealed")


class ProvenanceDriftTests(unittest.TestCase):
    """The provenance strings name upstreams that live in other modules. If one
    of those moves, the manifest would keep asserting the old source — which is
    the one lie an attestation must not tell."""

    def test_diarization_provenance_still_matches_service_diarize(self) -> None:
        from service import diarize
        comp = next(c for c in appliance.COMPONENTS if c.name == "diarization")
        self.assertIn("sherpa-onnx", comp.provenance)
        self.assertIn("sherpa-onnx", diarize.SEGMENTATION_URL)
        self.assertIn("pyannote-segmentation-3-0", diarize.SEGMENTATION_URL)
        self.assertIn("CAM", diarize.EMBEDDING_FILE)

    def test_every_component_maps_to_a_distinct_directory(self) -> None:
        dirs = [c.dirname for c in appliance.COMPONENTS]
        self.assertEqual(len(dirs), len(set(dirs)))

    def test_component_env_vars_are_the_ones_config_reads(self) -> None:
        # These names are the contract between the Dockerfile's ENV block and
        # service/config.py. A rename on either side breaks the seal silently.
        envs = {c.env for c in appliance.COMPONENTS}
        self.assertEqual(envs, {"HF_HOME", "STT_DOWNLOAD_ROOT",
                                "DIARIZE_MODELS_DIR", "PIPER_VOICES_DIR"})
        source = Path(appliance.__file__).with_name("config.py").read_text("utf-8")
        for env in ("STT_DOWNLOAD_ROOT", "DIARIZE_MODELS_DIR", "PIPER_VOICES_DIR"):
            with self.subTest(env=env):
                self.assertIn(env, source)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
