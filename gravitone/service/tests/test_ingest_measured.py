"""Ingested voices join the measured space.

`voices.create_voice` has stamped `prosody` on every row it writes since the
measured-emotion-space batch. `ingest.commit` — the STUDIO's flow, and the
primary way Voices are created on this box — stamped nothing, so
`voices.prosody_map(cid)` came back empty for exactly those Characters and every
`resolve(..., prosody=prosody_map(cid))` in `service/app.py` silently degraded to
the static prior chain. These tests pin the fix at the seam that matters.

WHAT IS TESTED, AND HOW IT IS NOT VACUOUS
-----------------------------------------
The proof is not "the row has a `prosody` key" — a field-presence assertion
passes on a stamp that measures the wrong file, or that nothing downstream can
read. Every claim here goes through the REAL resolution path:
``voices.emotion_map`` + ``voices.prosody_map`` + ``emotions.resolve``, the same
three calls ``app.py`` makes.

MUTATION CHECK (documented, and executed):
  * `test_commit_lands_in_the_measured_space` asserts a request for an emotion
    the Character does NOT have resolves to the acoustically-nearest slot
    (`angry`, the loud/fast/bright take). Removing the `stamp_measured` call
    from `ingest.commit` makes `prosody_map` empty, `nearest_measured` returns
    None, and the walk falls through to FALLBACK_CHAIN — which answers
    `baseline`. The assertion therefore FAILS with the stamping removed.
  * `test_without_the_stamp_the_walk_falls_back_to_the_chain` executes that
    mutation in-process (it strips `prosody` off the very rows the commit above
    wrote) and pins the pre-fix answer, so the two tests together show the
    measured answer and the unmeasured one are genuinely different.
  * `test_rederive_upgrades_a_legacy_voice` starts from a registered voice with
    NO prosody — a voice committed before this change — and proves the rebuild
    puts it in the space. Deleting the stamp leaves the row exactly as it
    started, and the assertion fails.

Everything is mocked at the same seams the rest of the ingest suite mocks: the
one-load `export_stems` child is `test_corpus._FakeExportPopen` (no torch, no
model), and no network call exists on either path under test. Real audio and a
real `prosody.probe`, because the whole point is that the measurement is of the
audio the voice was cloned from.
"""
from __future__ import annotations

import math
import unittest
import wave
from pathlib import Path

import numpy as np

from service import emotions as em
from service import ingest as ing
from service import prosody
from service import voices as vc
from service.tests.test_corpus import CorpusCase, _FakeExportPopen

from unittest import mock

RATE = 24000


def _voiced(freq: float, seconds: float, amp: float, harmonics: int = 5) -> np.ndarray:
    """A harmonic stack — closer to speech than a sine, and it exercises the
    autocorrelation peak picker the way a real voice does. Same generator
    `test_prosody` uses for its end-to-end measured-fallback proof."""
    t = np.arange(int(RATE * seconds), dtype=np.float64) / RATE
    out = np.zeros_like(t)
    for h in range(1, harmonics + 1):
        out += (1.0 / h) * np.sin(2.0 * math.pi * freq * h * t)
    return amp * out / np.max(np.abs(out))


def _modulate(signal: np.ndarray, hz: float) -> np.ndarray:
    """Amplitude modulation ~ a syllable rate, so `rate_proxy` has something
    real to count."""
    t = np.arange(signal.size, dtype=np.float64) / RATE
    return signal * (0.55 + 0.45 * np.sin(2.0 * math.pi * hz * t))


def _write(path: Path, samples: np.ndarray) -> Path:
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2")
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm.tobytes())
    return path


# One speaker, three takes. Nothing DECLARES an emotion acoustically here — the
# audio does: a middling one, a quiet slow one, and a loud fast bright one.
# 5 seconds each, comfortably over `MIN_STEM_SECONDS`.
STEM_AUDIO = {
    "baseline": lambda: _modulate(_voiced(150.0, 5.0, 0.25), 3.0),
    "sad": lambda: _modulate(_voiced(110.0, 5.0, 0.05), 1.2),
    "angry": lambda: _modulate(_voiced(230.0, 5.0, 0.7, harmonics=9), 6.0),
}


class CommitMeasuredTests(CorpusCase):
    """The commit path: a studio-created Character is measurable."""

    def _stems(self, name: str) -> Path:
        wd = self.root / f"work-{name}"
        for emo, make in STEM_AUDIO.items():
            _write(wd / f"stem_{emo}.wav", make())
        return wd

    def _commit(self, wd: Path, character: str = "Ada") -> list[dict]:
        _FakeExportPopen.spawned = 0
        with mock.patch.object(ing.subprocess, "Popen", _FakeExportPopen):
            return ing.commit(wd, character, list(STEM_AUDIO), None,
                              consent="I own this voice.", clip_sha256="a" * 64)

    def test_commit_lands_in_the_measured_space(self) -> None:
        created = self._commit(self._stems("a"))
        self.assertEqual(sorted(c["emotion"] for c in created),
                         sorted(STEM_AUDIO))

        # The stamp is real: every row carries a FULLY measured probe of the
        # stem it was cloned from (no `reason`, which is how prosody.py names a
        # measurement it could not take).
        measured = vc.prosody_map("ada")
        self.assertEqual(sorted(measured), sorted(STEM_AUDIO))
        for emo, vec in measured.items():
            self.assertNotIn("reason", vec, f"{emo} should be fully measured")
            self.assertIsNotNone(vec["f0_mean"])

        # THE assertion — through the real resolution path, the same three calls
        # app.py makes. `excited` is missing; its prior sits high on every axis,
        # so the measured walk must land on the loud/fast/bright take.
        available = vc.emotion_map("ada")
        vid, used, fell = em.resolve("excited", available, prosody=measured)
        self.assertEqual(used, "angry")
        self.assertTrue(fell)
        self.assertEqual(vid, available["angry"])
        # ...and it really is the voice this commit registered.
        self.assertIn(vid, {c["voice_id"] for c in created})

    def test_without_the_stamp_the_walk_falls_back_to_the_chain(self) -> None:
        """The mutation check, executed: strip what `commit` stamped and the
        SAME request takes the old, static-prior path."""
        self._commit(self._stems("b"))
        available = vc.emotion_map("ada")
        self.assertEqual(em.resolve("excited", available,
                                    prosody=vc.prosody_map("ada"))[1], "angry")

        def _strip(meta: dict) -> None:
            for row in meta["voices"].values():
                row.pop("prosody", None)

        vc.mutate_meta(_strip)
        self.assertEqual(vc.prosody_map("ada"), {})
        self.assertEqual(em.resolve("excited", available,
                                    prosody=vc.prosody_map("ada"))[1], "baseline")

    def test_label_check_is_reported_not_stored(self) -> None:
        """The same split `create_voice` makes: the probe is a durable fact
        about the audio, the check is a comparison against the roster at this
        moment — reported on the created row, never written to the registry."""
        created = self._commit(self._stems("c"))
        checks = [c["label_check"] for c in created if "label_check" in c]
        self.assertTrue(checks, "no emotion got a label check at all")
        for chk in checks:
            self.assertIn("agrees", chk)
            self.assertIn("nearest", chk)
            self.assertIsInstance(chk["distance"], float)
        import json
        meta = json.loads((self.voices / "_meta.json").read_text("utf-8"))
        for row in meta["voices"].values():
            self.assertNotIn("label_check", row)
            self.assertIn("prosody", row)

    def test_an_unreadable_stem_does_not_fail_the_clone(self) -> None:
        """Advisory, all the way down: a probe that cannot read its audio costs
        the row its measurement and nothing else."""
        wd = self._stems("d")
        with mock.patch.object(prosody, "probe",
                               side_effect=prosody.ProbeError("unreadable wav")):
            created = self._commit(wd)
        self.assertEqual(len(created), len(STEM_AUDIO))   # the clone survived
        self.assertEqual(vc.prosody_map("ada"), {})       # ...unmeasured, named
        for c in created:
            self.assertNotIn("label_check", c)


class RederiveUpgradeTests(CorpusCase):
    """The upgrade path for voices committed before any of this existed."""

    def test_rederive_upgrades_a_legacy_voice(self) -> None:
        # A corpus-backed character whose registered voice predates the stamp.
        self.capture("ada", "a", "1" * 64,
                     segments=[("baseline", 3.0, 0.9), ("baseline", 3.0, 0.9)])
        (self.voices / "ada-baseline-legacy.safetensors").write_bytes(b"tensors")

        def _seed(meta: dict) -> None:
            meta["voices"]["ada-baseline-legacy"] = {
                "name": "Ada", "character_id": "ada", "emotion": "baseline",
                "created": "2026-01-01T00:00:00+00:00", "sample_seconds": 6.0,
                "lang": "EN", "source": "ingest"}
            meta["characters"].setdefault("ada", {"name": "Ada", "tags": []})

        vc.mutate_meta(_seed)
        # The legacy state this feature exists to fix: registered, speakable,
        # and invisible to the measured space.
        self.assertEqual(vc.prosody_map("ada"), {})

        wd = self.root / "rederive-1"
        _FakeExportPopen.spawned = 0
        with mock.patch.object(ing.subprocess, "Popen", _FakeExportPopen):
            res = ing.rederive("ada", wd)
        self.assertEqual([c["emotion"] for c in res["created"]], ["baseline"])

        # Rebuilt in place (replace=True), and now IN the space: the rebuild
        # re-exports the stems, so the measurement rides along for free.
        import json
        meta = json.loads((self.voices / "_meta.json").read_text("utf-8"))
        self.assertNotIn("ada-baseline-legacy", meta["voices"])
        new_id = res["created"][0]["voice_id"]
        self.assertIn("prosody", meta["voices"][new_id])
        self.assertEqual(meta["voices"][new_id]["prosody"]["version"],
                         prosody.VERSION)
        self.assertIn("baseline", vc.prosody_map("ada"))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
