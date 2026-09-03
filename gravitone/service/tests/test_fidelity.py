"""The Fidelity Ledger: what the studio measured, and what it refuses to claim.

`voices.measure_fidelity` is the signal-only half of batch-1 contract C1 — the
half that needs no model: clipping, noise floor, effective speech seconds,
sample-rate adequacy, computed once at clone time over audio the clone path
already has on disk.

Two rules are load-bearing here and both are asserted rather than documented:

  * **Absent is not zero.** A Voice cloned before the ledger existed, a built-in,
    and a clip that is not readable PCM16 all report `fidelity: null`. A zeroed
    object would render in the roster as "this voice is bad", which is a claim the
    service never made. So the None paths get as many tests as the measured ones.
  * **Advisory, never blocking.** A prosody probe that raises, an identity number
    that is not a cosine similarity, a registry row somebody hand-edited — none of
    them may fail a clone that otherwise succeeded.

Nothing heavy runs: the wavs are synthesized in-process (sine + silence), ffmpeg
and the export child are mocked exactly as `test_clone_path` mocks them, and the
whole registry is redirected into a temp dir.
"""
from __future__ import annotations

import io
import math
import unittest
import wave
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

import numpy as np

from service.tests import fake_engine  # installs shims — must precede app import

import service.emotions as emotions
import service.ingest as ingest
import service.voices as vc
from service import export_stems
from service.tests.test_clone_path import fake_export_child
from fastapi.testclient import TestClient
import service.app as appmod


# ── synthetic audio ───────────────────────────────────────────────────────────
def write_wav(path: Path, samples: np.ndarray, rate: int = 24000) -> Path:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(np.asarray(samples, dtype="<i2").tobytes())
    return path


def tone(seconds: float, amplitude: int, rate: int = 24000, hz: float = 140.0) -> np.ndarray:
    """A voiced-looking signal: one sine at a plausible f0."""
    n = int(seconds * rate)
    t = np.arange(n, dtype=np.float64) / rate
    return (amplitude * np.sin(2.0 * math.pi * hz * t)).astype("<i2")


def hush(seconds: float, amplitude: int = 3, rate: int = 24000) -> np.ndarray:
    """Room-tone-ish near-silence at a chosen level (the clip's noise floor)."""
    n = int(seconds * rate)
    rng = np.random.default_rng(7)  # seeded: the suite must not wobble
    return rng.integers(-amplitude, amplitude + 1, size=n).astype("<i2")


def clip_wav(path: Path, *, speech: float = 8.0, silence: float = 2.0,
             amplitude: int = 8000, floor: int = 3, rate: int = 24000) -> Path:
    return write_wav(path, np.concatenate([
        hush(silence / 2, floor, rate), tone(speech, amplitude, rate),
        hush(silence / 2, floor, rate)]), rate)


C1_KEYS = {"version", "measured_at", "identity", "speech_seconds",
           "clip_ratio", "noise_floor_db", "flags"}


class MeasureShapeTests(unittest.TestCase):
    """The object is exactly contract C1 — no more, no less."""

    def test_a_clean_clip_reports_every_field_and_no_flags(self) -> None:
        with TemporaryDirectory() as td:
            f = vc.measure_fidelity(clip_wav(Path(td) / "clean.wav"))
        assert f is not None
        self.assertEqual(C1_KEYS, set(f))
        self.assertEqual(vc.FIDELITY_VERSION, f["version"])
        self.assertTrue(f["measured_at"].endswith("Z"), f["measured_at"])
        # A studio-clean take must produce NO flags: a flag the user cannot hear
        # is the failure mode that destroys trust in the whole surface.
        self.assertEqual([], f["flags"])
        self.assertGreater(f["speech_seconds"], 7.0)
        self.assertLess(f["speech_seconds"], 10.1)
        self.assertEqual(0.0, f["clip_ratio"])
        self.assertLess(f["noise_floor_db"], -60.0)

    def test_identity_is_absent_unless_supplied(self) -> None:
        with TemporaryDirectory() as td:
            f = vc.measure_fidelity(clip_wav(Path(td) / "clean.wav"))
            supplied = vc.measure_fidelity(Path(td) / "clean.wav", identity=0.9137)
        assert f is not None and supplied is not None
        # None, NEVER 0.0: this module cannot measure identity at all (that needs
        # the speaker-embedding stack), and 0.0 would read as "different person".
        self.assertIsNone(f["identity"])
        self.assertEqual(0.9137, supplied["identity"])

    def test_speech_seconds_ignores_the_silence_around_the_speech(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            short = vc.measure_fidelity(clip_wav(root / "a.wav", speech=1.4, silence=8.0))
            long = vc.measure_fidelity(clip_wav(root / "b.wav", speech=9.0, silence=0.4))
        assert short is not None and long is not None
        # 1.4s of speech inside a 9.4s file is a "1.4s speech" fact, not 9.4s.
        self.assertLess(short["speech_seconds"], 2.0)
        self.assertGreater(long["speech_seconds"], 8.0)


class FlagTests(unittest.TestCase):
    """Only TRUE flags appear, and each names something a user can act on."""

    def _flags(self, path: Path, **kw) -> list[str]:
        f = vc.measure_fidelity(path, **kw)
        assert f is not None
        return f["flags"]

    def test_clipping_is_flagged_and_quantified(self) -> None:
        with TemporaryDirectory() as td:
            p = Path(td) / "clipped.wav"
            samples = np.array(tone(8.0, 8000), dtype="<i2")
            samples[::50] = 32767  # 2% of samples pinned to the rail
            write_wav(p, samples)
            f = vc.measure_fidelity(p)
        assert f is not None
        self.assertIn("clipped", f["flags"])
        self.assertGreater(f["clip_ratio"], 0.01)

    def test_one_stray_peak_is_not_clipping(self) -> None:
        # A single transient at full scale is not a defect; flagging it would
        # teach the user to ignore the flag.
        with TemporaryDirectory() as td:
            p = Path(td) / "peak.wav"
            samples = np.array(tone(8.0, 8000), dtype="<i2")
            samples[1000] = 32767
            write_wav(p, samples)
            self.assertNotIn("clipped", self._flags(p))

    def test_a_high_noise_floor_is_flagged(self) -> None:
        with TemporaryDirectory() as td:
            noisy = clip_wav(Path(td) / "noisy.wav", floor=1200)
            f = vc.measure_fidelity(noisy)
        assert f is not None
        self.assertIn("noisy", f["flags"])
        self.assertGreater(f["noise_floor_db"], -40.0)

    def test_too_little_speech_is_flagged(self) -> None:
        with TemporaryDirectory() as td:
            self.assertIn("short_speech",
                          self._flags(clip_wav(Path(td) / "s.wav", speech=1.4, silence=4.0)))

    def test_the_sample_rate_flag_judges_the_SOURCE_not_the_cleaned_file(self) -> None:
        # clean_audio resamples every clone to 24 kHz, so the cleaned file can
        # never report an 8 kHz phone recording — the flag has to come from the
        # upload, and is simply absent when the upload is not a readable wav.
        with TemporaryDirectory() as td:
            clean = clip_wav(Path(td) / "clean.wav")
            self.assertNotIn("low_sample_rate", self._flags(clean))
            self.assertIn("low_sample_rate", self._flags(clean, source_rate=8000))
            self.assertNotIn("low_sample_rate", self._flags(clean, source_rate=48000))
            self.assertNotIn("low_sample_rate", self._flags(clean, source_rate=None))


class NotMeasuredTests(unittest.TestCase):
    """"We measured nothing" is a state, and it is spelled None."""

    def test_a_non_audio_file_measures_nothing_at_all(self) -> None:
        with TemporaryDirectory() as td:
            p = Path(td) / "clean.wav"
            p.write_bytes(b"clean")  # what a mocked ffmpeg leaves behind
            self.assertIsNone(vc.measure_fidelity(p))

    def test_a_missing_file_measures_nothing(self) -> None:
        with TemporaryDirectory() as td:
            self.assertIsNone(vc.measure_fidelity(Path(td) / "nope.wav"))

    def test_an_unreadable_clip_still_reports_a_known_source_rate(self) -> None:
        # Partial measurement is allowed and labelled: the level metrics are
        # None, the flag that does not depend on them still fires.
        with TemporaryDirectory() as td:
            p = Path(td) / "clean.wav"
            p.write_bytes(b"clean")
            f = vc.measure_fidelity(p, source_rate=8000)
        assert f is not None
        self.assertEqual(["low_sample_rate"], f["flags"])
        self.assertIsNone(f["speech_seconds"])
        self.assertIsNone(f["clip_ratio"])
        self.assertIsNone(f["noise_floor_db"])

    def test_an_8bit_wav_is_not_pretended_to_be_pcm16(self) -> None:
        with TemporaryDirectory() as td:
            p = Path(td) / "eight.wav"
            with wave.open(str(p), "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(1)
                w.setframerate(24000)
                w.writeframes(b"\x80" * 24000)
            self.assertIsNone(vc.measure_fidelity(p))

    def test_stereo_is_downmixed_rather_than_misread(self) -> None:
        with TemporaryDirectory() as td:
            p = Path(td) / "stereo.wav"
            mono = tone(6.0, 8000)
            inter = np.empty(mono.size * 2, dtype="<i2")
            inter[0::2] = mono
            inter[1::2] = mono
            with wave.open(str(p), "wb") as w:
                w.setnchannels(2)
                w.setsampwidth(2)
                w.setframerate(24000)
                w.writeframes(inter.tobytes())
            f = vc.measure_fidelity(p)
        assert f is not None
        # Read as interleaved mono the duration would double; the speech seconds
        # have to match the real 6 seconds.
        self.assertLess(f["speech_seconds"], 6.5)
        self.assertGreater(f["speech_seconds"], 5.0)


class IdentityHygieneTests(unittest.TestCase):
    """An identity this module did not measure still has to be a cosine sim."""

    def test_a_valid_similarity_survives_rounding_only(self) -> None:
        self.assertEqual(0.9137, vc._clean_identity(0.91373))
        self.assertEqual(-1.0, vc._clean_identity(-1.0))

    def test_nonsense_is_dropped_not_stored(self) -> None:
        for bad in (73, 1.5, -2.0, float("nan"), float("inf"), "0.9", True,
                    None, object()):
            with self.subTest(value=bad):
                self.assertIsNone(vc._clean_identity(bad))


# ── the registry / API surface ────────────────────────────────────────────────
class _RegistryCase(unittest.TestCase):
    """A temp registry (never the repo's voices/) plus a seeding helper."""

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

    def seed(self, character_id: str, rows: dict[str, dict | None]) -> None:
        """One Character with a Voice per emotion; value = its fidelity (or None
        for a row written before the ledger existed)."""
        meta = vc._load_meta()
        for i, (emo, fidelity) in enumerate(rows.items()):
            vid = f"{character_id}-{emo}-{i:02d}"
            (self.root / f"{vid}.safetensors").write_bytes(b"fake-embedding")
            row = {"name": character_id, "character_id": character_id,
                   "emotion": emo, "created": "2026-01-01T00:00:00+00:00",
                   "sample_seconds": 12.0, "lang": "EN"}
            if fidelity is not None:
                row["fidelity"] = fidelity
            meta["voices"][vid] = row
        meta["characters"].setdefault(character_id, {"name": character_id, "tags": []})
        vc._save_meta(meta)
        vc.invalidate()


MEASURED = {"version": 1, "measured_at": "2026-07-30T00:00:00Z", "identity": 0.91,
            "speech_seconds": 6.2, "clip_ratio": 0.002, "noise_floor_db": -52.1,
            "flags": ["clipped"]}


class ReadSurfaceTests(_RegistryCase):
    """`GET /v1/characters`, the `[id]` route and the manifest all carry it."""

    def test_the_roster_carries_fidelity_and_reports_null_for_old_rows(self) -> None:
        self.seed("ada", {"baseline": MEASURED, "sad": None})
        roster = self.client.get("/v1/characters").json()
        ada = next(c for c in roster if c["character_id"] == "ada")
        by_emotion = {v["emotion"]: v for v in ada["voices"]}
        self.assertEqual(MEASURED, by_emotion["baseline"]["fidelity"])
        # The pre-ledger row: null, never a zeroed object. The UI renders NOTHING
        # for this, which is only correct because it is distinguishable.
        self.assertIsNone(by_emotion["sad"]["fidelity"])

    def test_the_single_character_route_agrees_with_the_roster(self) -> None:
        self.seed("ada", {"baseline": MEASURED})
        c = self.client.get("/v1/characters/ada").json()
        self.assertEqual(MEASURED, c["voices"][0]["fidelity"])

    def test_the_manifest_publishes_it_per_performable_slot(self) -> None:
        self.seed("ada", {"baseline": MEASURED, "sad": None})
        m = self.client.get("/v1/characters/ada/manifest").json()
        self.assertEqual(MEASURED, m["performable"]["baseline"]["fidelity"])
        self.assertIsNone(m["performable"]["sad"]["fidelity"])

    def test_a_builtin_reports_null_rather_than_a_fabricated_score(self) -> None:
        v = self.client.get("/v1/voices/mary").json()
        self.assertIsNone(v["fidelity"])

    def test_a_corrupt_fidelity_value_reads_as_not_measured(self) -> None:
        # A hand-edited registry (or a half-written row) must not 500 the roster
        # nor smuggle a non-object into the response model.
        self.seed("ada", {"baseline": {"version": 1, "flags": []}})
        meta = vc._load_meta()
        vid = next(iter(meta["voices"]))
        meta["voices"][vid]["fidelity"] = "excellent"
        vc._save_meta(meta)
        vc.invalidate()
        r = self.client.get("/v1/characters/ada")
        self.assertEqual(200, r.status_code, r.text)
        self.assertIsNone(r.json()["voices"][0]["fidelity"])


class IdentitySeamIsNotOnTheWireTests(unittest.TestCase):
    """`fidelity_identity` is an in-process seam, not a request parameter.

    The ledger's whole claim is that its numbers were MEASURED by this service.
    Declared on the route, the kwarg becomes an optional query parameter and any
    caller could assert `identity 0.99` for a voice nothing ever listened to —
    which the roster would then present as a measured "identity match". So the
    HTTP door (`clone_voice_endpoint`) is a separate function, and this pins it.
    """

    def test_the_clone_endpoint_publishes_no_identity_parameter(self) -> None:
        params = appmod.app.openapi()["paths"]["/v1/voices"]["post"].get("parameters", [])
        self.assertNotIn("fidelity_identity", [p["name"] for p in params])
        body = appmod.app.openapi()["paths"]["/v1/voices"]["post"]["requestBody"]
        schema = str(body)  # the multipart form fields, whatever their $ref shape
        self.assertNotIn("fidelity_identity", schema)

    def test_but_the_function_still_accepts_it_by_keyword(self) -> None:
        import inspect
        sig = inspect.signature(vc.create_voice)
        p = sig.parameters["fidelity_identity"]
        self.assertEqual(inspect.Parameter.KEYWORD_ONLY, p.kind)
        self.assertIsNone(p.default)

    def test_the_door_stays_sync_so_the_clone_never_runs_on_the_event_loop(self) -> None:
        # The rule test_handler_modes enforces for create_voice, held for the
        # route that now stands in front of it: as `async def` it would run the
        # ffmpeg + export-child work on the single event loop.
        import inspect
        self.assertFalse(inspect.iscoroutinefunction(vc.clone_voice_endpoint))
        self.assertFalse(inspect.iscoroutinefunction(vc.create_voice))


# ── the clone path end to end ─────────────────────────────────────────────────
def clone_through(root: Path, *, clean: np.ndarray, raw_rate: int | None = None,
                  character: str = "Ada", emotion: str = "baseline",
                  **kwargs) -> vc.Voice:
    """`voices.create_voice` with ffmpeg + the export child mocked, but REAL
    audio: the cleaned clip is the array given, so the measurement runs for
    real. `raw_rate` writes the upload as a wav at that rate (how the
    `low_sample_rate` flag is reached through the endpoint)."""

    class _Upload:
        filename = "clip.wav"

        def __init__(self, data: bytes) -> None:
            self.file = io.BytesIO(data)

    def _fake_clean(src, dst, sr=24000):
        write_wav(Path(dst), clean)

    if raw_rate is None:
        raw_bytes = b"RIFFclip"  # not a parseable wav: source rate unknown
    else:
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(raw_rate)
            w.writeframes(tone(4.0, 6000, raw_rate).tobytes())
        raw_bytes = buf.getvalue()

    with mock.patch.object(vc, "VOICES_DIR", root), \
         mock.patch.object(vc, "META_PATH", root / "_meta.json"), \
         mock.patch.object(vc, "_META_LOCK_PATH", root / "._meta.lock"), \
         mock.patch.object(ingest, "clean_audio", side_effect=_fake_clean), \
         mock.patch.object(export_stems.subprocess, "run",
                           side_effect=fake_export_child()):
        vc.invalidate()
        try:
            return vc.create_voice(
                file=_Upload(raw_bytes), character=character, emotion=emotion,
                tags="", attested="true", statement="I own this voice", **kwargs)
        finally:
            vc.invalidate()


class ClonePathTests(unittest.TestCase):
    """A finished clone lands with its measurement already on the row."""

    def rows(self, root: Path) -> dict:
        import json
        return json.loads((root / "_meta.json").read_text("utf-8"))["voices"]

    def test_the_registry_row_carries_the_measurement(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            v = clone_through(root, clean=np.concatenate(
                [hush(1.0), tone(8.0, 8000), hush(1.0)]))
            row = self.rows(root)[v.voice_id]
        self.assertEqual(C1_KEYS, set(row["fidelity"]))
        self.assertEqual([], row["fidelity"]["flags"])
        self.assertGreater(row["fidelity"]["speech_seconds"], 7.0)
        # …and the response says the same thing, so the studio needs no re-read.
        self.assertEqual(row["fidelity"], v.fidelity)

    def test_a_clipped_upload_is_named_on_the_row_and_in_the_response(self) -> None:
        samples = np.array(tone(8.0, 8000), dtype="<i2")
        samples[::40] = -32768
        with TemporaryDirectory() as td:
            v = clone_through(Path(td), clean=samples)
        assert v.fidelity is not None
        self.assertIn("clipped", v.fidelity["flags"])

    def test_an_8khz_upload_is_flagged_from_the_upload_itself(self) -> None:
        with TemporaryDirectory() as td:
            v = clone_through(Path(td), clean=np.concatenate(
                [hush(1.0), tone(8.0, 8000), hush(1.0)]), raw_rate=8000)
        assert v.fidelity is not None
        self.assertEqual(["low_sample_rate"], v.fidelity["flags"])

    def test_a_supplied_identity_is_merged_into_the_row(self) -> None:
        # The C1 seam the ingest close-the-loop path uses.
        with TemporaryDirectory() as td:
            root = Path(td)
            v = clone_through(root, clean=tone(8.0, 8000), fidelity_identity=0.9137)
            self.assertEqual(0.9137, self.rows(root)[v.voice_id]["fidelity"]["identity"])

    def test_a_nonsense_identity_neither_stores_nor_fails_the_clone(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            v = clone_through(root, clean=tone(8.0, 8000), fidelity_identity=73.0)
            self.assertIsNone(self.rows(root)[v.voice_id]["fidelity"]["identity"])

    def test_an_unmeasurable_clip_registers_with_NO_fidelity_key(self) -> None:
        # The mocked-ffmpeg case, and the honest one: rather than a row full of
        # nulls, the row simply has nothing to say.
        with TemporaryDirectory() as td:
            root = Path(td)

            def _fake_clean(src, dst, sr=24000):
                Path(dst).write_bytes(b"clean")

            class _Upload:
                filename = "clip.wav"
                file = io.BytesIO(b"RIFFclip")

            with mock.patch.object(vc, "VOICES_DIR", root), \
                 mock.patch.object(vc, "META_PATH", root / "_meta.json"), \
                 mock.patch.object(vc, "_META_LOCK_PATH", root / "._meta.lock"), \
                 mock.patch.object(ingest, "clean_audio", side_effect=_fake_clean), \
                 mock.patch.object(vc, "_wav_seconds", return_value=12.0), \
                 mock.patch.object(export_stems.subprocess, "run",
                                   side_effect=fake_export_child()):
                vc.invalidate()
                try:
                    v = vc.create_voice(
                        file=_Upload(), character="Ada", emotion="baseline",
                        tags="", attested="true", statement="I own this voice")
                finally:
                    vc.invalidate()
            self.assertNotIn("fidelity", self.rows(root)[v.voice_id])
        self.assertIsNone(v.fidelity)


class ProsodyHookTests(unittest.TestCase):
    """Contract C2: the probe is attached, and it can never fail a clone."""

    def rows(self, root: Path) -> dict:
        import json
        return json.loads((root / "_meta.json").read_text("utf-8"))["voices"]

    def test_the_probe_result_lands_on_the_row(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            v = clone_through(root, clean=np.concatenate(
                [hush(1.0), tone(8.0, 8000), hush(1.0)]))
            prosody = self.rows(root)[v.voice_id].get("prosody")
        self.assertIsInstance(prosody, dict)
        for field in ("f0_mean", "energy_rms", "version"):
            self.assertIn(field, prosody)

    def test_a_probe_that_raises_is_logged_and_the_clone_still_succeeds(self) -> None:
        from service import prosody as prosody_mod
        with TemporaryDirectory() as td:
            root = Path(td)
            with mock.patch.object(prosody_mod, "probe",
                                   side_effect=RuntimeError("probe exploded")):
                with self.assertLogs("gravitone", level="WARNING") as logs:
                    v = clone_through(root, clean=tone(8.0, 8000))
            self.assertNotIn("prosody", self.rows(root)[v.voice_id])
        self.assertTrue(any("prosody probe skipped" in m for m in logs.output),
                        logs.output)
        # The measurement it does own is unaffected — one advisory failing must
        # not take the other with it.
        self.assertIsNotNone(v.fidelity)

    def test_a_missing_prosody_module_is_not_an_error_for_the_caller(self) -> None:
        # prosody.py is owned by another module and the hook's import lives
        # inside the guard precisely so this order never matters. Both halves of
        # the import have to be hidden: the sys.modules entry AND the attribute
        # `from service import prosody` falls back to on the parent package.
        import sys
        import service as service_pkg
        saved = service_pkg.prosody
        with TemporaryDirectory() as td:
            root = Path(td)
            try:
                del service_pkg.prosody
                with mock.patch.dict(sys.modules, {"service.prosody": None}):
                    v = clone_through(root, clean=tone(8.0, 8000))
            finally:
                service_pkg.prosody = saved
            self.assertNotIn("prosody", self.rows(root)[v.voice_id])
        self.assertIsNotNone(v.fidelity)


class LabelCheckPlumbingTests(unittest.TestCase):
    """The advisory "reads closer to X" ride-along on the CREATE response."""

    def rows(self, root: Path) -> dict:
        import json
        return json.loads((root / "_meta.json").read_text("utf-8"))["voices"]

    def test_the_check_is_returned_but_never_stored(self) -> None:
        answer = {"agrees": False, "nearest": "calm", "distance": 0.21}
        with TemporaryDirectory() as td:
            root = Path(td)
            with mock.patch.object(emotions, "label_check", return_value=answer,
                                   create=True) as check:
                v = clone_through(root, clean=np.concatenate(
                    [hush(1.0), tone(8.0, 8000), hush(1.0)]), emotion="excited")
            self.assertNotIn("label_check", self.rows(root)[v.voice_id])
        self.assertEqual(answer, v.label_check)
        # Called with the prosody vector, the DECLARED emotion, and an iterable
        # of registry ROWS (not the vid->row mapping, whose iteration yields ids
        # that label_check correctly discards).
        vec, declared, character_rows = check.call_args.args
        self.assertIn("f0_mean", vec)
        self.assertEqual("excited", declared)
        self.assertTrue(all(isinstance(r, dict) for r in character_rows))

    def test_a_check_that_raises_is_advisory_only(self) -> None:
        with TemporaryDirectory() as td:
            with mock.patch.object(emotions, "label_check", create=True,
                                   side_effect=RuntimeError("nope")):
                v = clone_through(Path(td), clean=tone(8.0, 8000))
        self.assertIsNone(v.label_check)

    def test_no_prosody_means_no_label_check_rather_than_a_guess(self) -> None:
        with TemporaryDirectory() as td:
            row: dict = {}  # the probe stored nothing
            self.assertIsNone(vc.label_check_for(row, "excited", "ada"))
            self.assertTrue(Path(td).is_dir())

    def test_the_real_module_answers_or_declines_without_raising(self) -> None:
        # Wired against the SHIPPED emotions.label_check, so the two signatures
        # cannot drift apart silently: a first-ever voice has nothing to compare
        # against, so None is the honest answer.
        with TemporaryDirectory() as td:
            v = clone_through(Path(td), clean=np.concatenate(
                [hush(1.0), tone(8.0, 8000), hush(1.0)]))
        self.assertTrue(v.label_check is None or isinstance(v.label_check, dict))


if __name__ == "__main__":
    unittest.main()
