"""Sovereign mode — the local-only path, which had ZERO tests.

Sovereign mode IS the product's story (Arm-native, CPU-only, no cloud, no keys,
nothing leaves the box) and it was the least verified code in the repo. What is
covered here:

  * `resolve_mode` — the auto-selection that decides which pipeline a scan runs.
  * `measure_levels` / `detect_speech` — speech detection now derives its
    silence threshold from the clip's OWN loudness. The fixtures are quiet, loud,
    noisy and silent recordings, synthesised in-process (no binary blobs in the
    repo), and each test states what the OLD fixed -35 dBFS constant did with
    the same audio — `detect_speech(noise_db=-35.0)` still reproduces it, so the
    comparison is executed, not asserted from memory.
  * the degenerate outcomes — silent, unbroken, too short — each of which used
    to collapse into the same wordless fallback ("use the whole file").
  * `clean_local` and `sovereign_analyze` end to end (ffmpeg required).

Nothing here touches the network; that is the point of the mode.
"""
from __future__ import annotations

import array
import json
import math
import shutil
import unittest
import wave
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from service import ingest
from service.emotions import BASELINE
from service.errors import UserFacing

HAVE_FFMPEG = shutil.which("ffmpeg") is not None
RATE = 24000


# ── fixtures (synthesised, never committed) ──────────────────────────────────
def _write(path: Path, samples: list[float]) -> None:
    data = array.array("h", (max(-32768, min(32767, int(s * 32767))) for s in samples))
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(data.tobytes())


def _noise(n: int, amp: float, seed: int = 7) -> list[float]:
    """Deterministic pseudo-noise — no numpy RNG version dependence."""
    out, x = [], seed * 2654435761 % (2 ** 31)
    for _ in range(n):
        x = (1103515245 * x + 12345) % (2 ** 31)
        out.append((x / (2 ** 30) - 1.0) * amp)
    return out


def _speechy(n: int, amp: float, i0: int = 0) -> list[float]:
    """A voice-like burst: a 140 Hz 'pitch' with harmonics and a 4 Hz envelope,
    so it has the level structure of speech rather than a flat sine."""
    out = []
    for i in range(i0, i0 + n):
        t = i / RATE
        env = 0.55 + 0.45 * math.sin(2 * math.pi * 4.0 * t)
        s = (math.sin(2 * math.pi * 140 * t)
             + 0.5 * math.sin(2 * math.pi * 280 * t)
             + 0.25 * math.sin(2 * math.pi * 560 * t)) / 1.75
        out.append(amp * env * s)
    return out


def _clip(path: Path, pattern: list[tuple[str, float]], amp: float,
          floor_amp: float = 0.0) -> None:
    """`pattern` is [("talk"|"pause", seconds), ...]; `floor_amp` is the room
    tone mixed under EVERYTHING, including the pauses."""
    out: list[float] = []
    for kind, secs in pattern:
        n = int(secs * RATE)
        out.extend(_speechy(n, amp, len(out)) if kind == "talk" else [0.0] * n)
    if floor_amp:
        room = _noise(len(out), floor_amp)
        out = [a + b for a, b in zip(out, room)]
    _write(path, out)


#: The shape shared by every non-degenerate fixture: 4 utterances, 3 pauses.
TALK = [("talk", 2.5), ("pause", 1.0), ("talk", 3.0), ("pause", 1.0),
        ("talk", 2.0), ("pause", 1.0), ("talk", 2.5)]


def legacy_detect(wav: Path, noise_db: float = -35.0, min_silence: float = 0.5,
                  min_dur: float = 1.2, max_dur: float = 15.0) -> list[dict]:
    """The detector as it stood BEFORE this change, verbatim.

    Kept here, not in the shipped module, so every "the old code did X" claim in
    this file is executed against the same fixture rather than remembered. Note
    what it does NOT have: any look at the clip's level, and any word for its
    own failure — the fallback on the last line is the whole bug.
    """
    import re
    import subprocess

    with wave.open(str(wav), "rb") as w:
        total = w.getnframes() / w.getframerate()
    r = subprocess.run(
        ["ffmpeg", "-i", str(wav),
         "-af", f"silencedetect=noise={noise_db}dB:d={min_silence}", "-f", "null", "-"],
        capture_output=True)
    text = r.stderr.decode(errors="ignore")
    starts = [float(x) for x in re.findall(r"silence_start:\s*([0-9.]+)", text)]
    ends = [float(x) for x in re.findall(r"silence_end:\s*([0-9.]+)", text)]
    spans: list[tuple[float, float]] = []
    pos = 0.0
    for i, st in enumerate(starts):
        if st - pos >= min_dur:
            spans.append((pos, st))
        pos = ends[i] if i < len(ends) else total
    if total - pos >= min_dur:
        spans.append((pos, total))
    if not spans and total >= min_dur:      # ← the silent fallback: "the whole file"
        spans = [(0.0, total)]
    segs: list[dict] = []
    for a, b in spans:
        cur = a
        while b - cur >= min_dur:
            chunk_end = min(cur + max_dur, b)
            segs.append({"speaker": "speaker_0", "start": round(cur, 3),
                         "end": round(chunk_end, 3), "text": ""})
            cur = chunk_end
    return segs


class ResolveModeTests(unittest.TestCase):
    """Which pipeline a scan runs — the first decision ingest makes."""

    def _resolve(self, mode: str, eleven: str, gemini: str) -> str:
        with mock.patch.object(ingest, "ELEVEN_KEY", eleven), \
             mock.patch.object(ingest, "GEMINI_KEY", gemini):
            return ingest.resolve_mode(mode)

    def test_auto_picks_cloud_only_with_both_keys(self) -> None:
        self.assertEqual(self._resolve("auto", "k1", "k2"), "cloud")
        self.assertEqual(self._resolve("auto", "k1", ""), "sovereign")
        self.assertEqual(self._resolve("auto", "", "k2"), "sovereign")
        self.assertEqual(self._resolve("auto", "", ""), "sovereign")

    def test_blank_key_is_not_a_key(self) -> None:
        """`GEMINI_API_KEY= ` in a .env used to auto-select cloud, which then
        died on an assertion inside analyze()."""
        self.assertEqual(self._resolve("auto", "k1", "   "), "sovereign")
        self.assertEqual(self._resolve("auto", "\t", "k2"), "sovereign")

    def test_explicit_mode_is_always_honoured(self) -> None:
        self.assertEqual(self._resolve("sovereign", "k1", "k2"), "sovereign")
        self.assertEqual(self._resolve("cloud", "", ""), "cloud")

    def test_unknown_mode_falls_back_to_auto(self) -> None:
        self.assertEqual(self._resolve("", "k1", "k2"), "cloud")
        self.assertEqual(self._resolve("nonsense", "", ""), "sovereign")


class LevelMeasurementTests(unittest.TestCase):
    """The threshold must come from the clip, not from a constant."""

    def test_threshold_tracks_the_clip_it_measured(self) -> None:
        with TemporaryDirectory() as td:
            wd = Path(td)
            loud, quiet = wd / "loud.wav", wd / "quiet.wav"
            _clip(loud, TALK, amp=0.5, floor_amp=0.002)
            _clip(quiet, TALK, amp=0.025, floor_amp=0.0001)   # same room, 26 dB down
            lo, qu = ingest.measure_levels(loud), ingest.measure_levels(quiet)
            self.assertTrue(lo.measured and qu.measured)
            self.assertGreater(lo.speech_db, qu.speech_db + 20)
            # The whole point: the derived thresholds move WITH the clips. A
            # constant would give these two identical treatment.
            self.assertGreater(lo.threshold_db, qu.threshold_db + 18)
            # …and each sits between that clip's own floor and its own speech.
            for lv in (lo, qu):
                self.assertGreater(lv.threshold_db, lv.floor_db)
                self.assertLess(lv.threshold_db, lv.speech_db)

    def test_noisy_clip_puts_the_threshold_above_its_room_tone(self) -> None:
        with TemporaryDirectory() as td:
            p = Path(td) / "noisy.wav"
            _clip(p, TALK, amp=0.5, floor_amp=0.05)    # loud room tone (~ -29 dBFS)
            lv = ingest.measure_levels(p)
            self.assertGreater(lv.threshold_db, ingest.FALLBACK_NOISE_DB,
                               "threshold sits under the room tone — every pause "
                               "would read as speech, as the fixed constant did")
            self.assertGreater(lv.threshold_db, lv.floor_db)

    def test_unmeasurable_file_falls_back_and_says_so(self) -> None:
        with TemporaryDirectory() as td:
            p = Path(td) / "stereo.wav"
            with wave.open(str(p), "wb") as w:
                w.setnchannels(2)
                w.setsampwidth(2)
                w.setframerate(RATE)
                w.writeframes(b"\x00\x00\x00\x00" * RATE)
            lv = ingest.measure_levels(p)
            self.assertFalse(lv.measured)
            self.assertEqual(lv.threshold_db, ingest.FALLBACK_NOISE_DB)


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg not available")
class DetectSpeechTests(unittest.TestCase):
    """Quiet, loud, noisy and silent inputs must each produce sensible spans —
    and each test also runs the OLD fixed -35 dBFS threshold on the same audio,
    so the change in behaviour is demonstrated rather than claimed."""

    def test_normal_clip_finds_one_span_per_utterance(self) -> None:
        with TemporaryDirectory() as td:
            p = Path(td) / "normal.wav"
            _clip(p, TALK, amp=0.4, floor_amp=0.0005)
            sc = ingest.detect_speech(p)
            self.assertEqual(sc.outcome, "spans")
            self.assertIsNone(sc.note)
            self.assertEqual(sc.spans, 4)
            self.assertEqual(len(sc.segments), 4)
            self.assertAlmostEqual(sc.speech_seconds, 10.0, delta=1.0)
            for s in sc.segments:                       # single speaker, always
                self.assertEqual(s["speaker"], "speaker_0")
                self.assertGreaterEqual(s["end"] - s["start"], 1.2)

    def test_quiet_clip_no_longer_collapses_into_one_take(self) -> None:
        """Speech below the old constant made the WHOLE file one span."""
        with TemporaryDirectory() as td:
            p = Path(td) / "quiet.wav"
            _clip(p, TALK, amp=0.025, floor_amp=0.0001)
            old = legacy_detect(p)                       # the bug, executed
            self.assertEqual(len(old), 1)
            self.assertEqual(old[0]["start"], 0.0)       # …the entire recording

            sc = ingest.detect_speech(p)
            self.assertEqual(sc.outcome, "spans")
            self.assertEqual(sc.spans, 4)
            self.assertLess(sc.speech_seconds, sc.total_seconds - 2.0,
                            "the pauses are still being cloned as speech")

    def test_noisy_clip_no_longer_falls_through_to_the_whole_file(self) -> None:
        """Room tone above the old constant meant NO silence was ever found."""
        with TemporaryDirectory() as td:
            p = Path(td) / "noisy.wav"
            _clip(p, TALK, amp=0.5, floor_amp=0.05)
            old = legacy_detect(p)                       # the bug, executed
            self.assertEqual(len(old), 1)
            self.assertEqual(old[0]["start"], 0.0)

            sc = ingest.detect_speech(p)
            self.assertEqual(sc.outcome, "spans")
            self.assertEqual(sc.spans, 4)

    def test_silent_file_is_named_silent_not_handed_back_whole(self) -> None:
        with TemporaryDirectory() as td:
            p = Path(td) / "silent.wav"
            _write(p, [0.0] * int(12 * RATE))
            # The old fallback did not merely mishandle this — it returned the
            # 12 seconds of digital silence as a span to clone a voice from.
            self.assertEqual(legacy_detect(p),
                             [{"speaker": "speaker_0", "start": 0.0,
                               "end": 12.0, "text": ""}])

            sc = ingest.detect_speech(p)
            self.assertEqual(sc.outcome, "silent")
            self.assertEqual(sc.segments, [])
            self.assertIn("silence", sc.note)
            self.assertIn("record again", sc.note)

    def test_near_silent_hiss_is_still_silent(self) -> None:
        """A file with nothing but a whisper of noise is not a recording."""
        with TemporaryDirectory() as td:
            p = Path(td) / "hiss.wav"
            _write(p, _noise(int(12 * RATE), 0.0004))
            sc = ingest.detect_speech(p)
            self.assertEqual(sc.outcome, "silent")
            self.assertEqual(sc.segments, [])

    def test_all_background_no_speech_is_refused_not_cloned(self) -> None:
        """Audible, but nothing rises above it. The old code answered this with
        the entire file — the opposite of what it had just measured."""
        with TemporaryDirectory() as td:
            p = Path(td) / "roomtone.wav"
            _write(p, _noise(int(12 * RATE), 0.15))
            old = legacy_detect(p)
            self.assertEqual(len(old), 1)                # old: whole file, silently
            sc = ingest.detect_speech(p)
            self.assertEqual(sc.outcome, "unbroken")
            # It IS handed back whole — but it SAYS so, which is the difference.
            self.assertIsNotNone(sc.note)
            self.assertIn("no pauses", sc.note)

    def test_unbroken_monologue_is_labelled_unbroken(self) -> None:
        with TemporaryDirectory() as td:
            p = Path(td) / "monologue.wav"
            _clip(p, [("talk", 20.0)], amp=0.4, floor_amp=0.0005)
            sc = ingest.detect_speech(p)
            self.assertEqual(sc.outcome, "unbroken")
            self.assertIn("one take", sc.note)
            # still chunked at max_dur so the stem stays balanced
            self.assertEqual(len(sc.segments), 2)
            self.assertLessEqual(sc.segments[0]["end"] - sc.segments[0]["start"], 15.0)

    def test_too_short_recording_says_it_is_too_short(self) -> None:
        with TemporaryDirectory() as td:
            p = Path(td) / "blip.wav"
            _clip(p, [("talk", 0.6)], amp=0.4)
            sc = ingest.detect_speech(p)
            self.assertEqual(sc.outcome, "too_short")
            self.assertEqual(sc.segments, [])
            self.assertIn("0.6s", sc.note)

    def test_long_span_is_split_at_max_dur(self) -> None:
        with TemporaryDirectory() as td:
            p = Path(td) / "long.wav"
            _clip(p, [("talk", 34.0), ("pause", 1.0), ("talk", 3.0)],
                  amp=0.4, floor_amp=0.0005)
            sc = ingest.detect_speech(p)
            self.assertEqual(sc.outcome, "spans")
            self.assertEqual(sc.spans, 2)
            self.assertTrue(all(s["end"] - s["start"] <= 15.0 + 1e-6
                                for s in sc.segments))
            self.assertGreaterEqual(len(sc.segments), 4)


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg not available")
class CleanLocalTests(unittest.TestCase):
    """The local isolator stand-in — same conditioning as every other path."""

    def test_produces_the_pipeline_format(self) -> None:
        with TemporaryDirectory() as td:
            wd = Path(td)
            src, dst = wd / "src.wav", wd / "clean.wav"
            _clip(src, TALK, amp=0.3, floor_amp=0.002)
            ingest.clean_local(src, dst)
            with wave.open(str(dst), "rb") as w:
                self.assertEqual(w.getnchannels(), 1)
                self.assertEqual(w.getsampwidth(), 2)
                self.assertEqual(w.getframerate(), 24000)
                self.assertAlmostEqual(w.getnframes() / 24000, 13.0, delta=0.5)

    def test_uses_the_one_canonical_cleanup_chain(self) -> None:
        """A sovereign clone must not be conditioned differently from a cloud
        one — same CLEANUP_FILTER, or the two modes diverge for no stated
        reason (test_clone_path.py guards the other call sites)."""
        seen: list[list[str]] = []

        class _R:
            returncode = 0
            stderr = b""

        orig = ingest.subprocess.run
        try:
            ingest.subprocess.run = lambda cmd, **kw: (seen.append(cmd), _R())[1]  # type: ignore[assignment]
            ingest.clean_local(Path("a.wav"), Path("b.wav"))
        finally:
            ingest.subprocess.run = orig  # type: ignore[assignment]
        self.assertIn(ingest.CLEANUP_FILTER, seen[0])

    def test_is_deterministic_run_to_run(self) -> None:
        """Single-pass loudnorm is reproducible for a given input — the reason
        two-pass (≈1.6x the wall clock) was NOT adopted."""
        with TemporaryDirectory() as td:
            wd = Path(td)
            src = wd / "src.wav"
            _clip(src, TALK, amp=0.3, floor_amp=0.002)
            outs = []
            for i in range(2):
                d = wd / f"c{i}.wav"
                ingest.clean_local(src, d)
                outs.append(d.read_bytes())
            self.assertEqual(outs[0], outs[1])


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg not available")
class SovereignAnalyzeTests(unittest.TestCase):
    """End to end, with no network available to it by construction."""

    def _run(self, pattern, amp=0.4, floor_amp=0.0005):
        td = TemporaryDirectory()
        wd = Path(td.name)
        src = wd / "src.wav"
        _clip(src, pattern, amp=amp, floor_amp=floor_amp)
        steps: list[tuple[str, str]] = []
        parts: list[dict] = []
        res = ingest.sovereign_analyze(
            src, wd / "work", progress=lambda k, s: steps.append((k, s)),
            partial=parts.append)
        return td, wd / "work", res, steps, parts

    def test_end_to_end_shape_and_artifacts(self) -> None:
        td, work, res, steps, parts = self._run(TALK)
        with td:
            self.assertAlmostEqual(res["duration"], 13.0, delta=0.5)
            self.assertEqual(len(res["speakers"]), 1)
            sp = res["speakers"][0]
            self.assertEqual(sp["id"], "speaker_0")
            self.assertEqual(sp["utterances"], 4)
            self.assertGreater(sp["seconds"], 8.0)
            # the artifacts label_and_stem will read next
            self.assertTrue((work / "clean.wav").is_file())
            self.assertTrue((work / "speaker_speaker_0.wav").is_file())
            segs = json.loads((work / "segments.json").read_text("utf-8"))
            self.assertEqual(len(segs), 4)
            # both phases reported, in order
            self.assertEqual(steps, [("isolate", "active"), ("isolate", "done"),
                                     ("transcribe", "active"), ("transcribe", "done")])

    def test_it_states_its_own_limits(self) -> None:
        td, work, res, steps, parts = self._run(TALK)
        with td:
            blob = " ".join(res["limits"]).lower()
            for must in ("baseline", "diarization", "transcri"):
                self.assertIn(must, blob)
            self.assertEqual(res["detection"]["outcome"], "spans")
            self.assertTrue(res["detection"]["adaptive"])
            self.assertIsNotNone(res["detection"]["threshold_db"])
            # the line the speaker-pick screen renders
            self.assertIn("no diarization", res["speakers"][0]["sample_text"])
            # the line the loader renders while the scan runs
            self.assertTrue(parts)
            self.assertIn("stayed on this machine", parts[0]["transcript"])

    def test_result_is_json_serialisable(self) -> None:
        """It is persisted into job state and served — a NaN level would make
        that unparseable for every poller."""
        td, work, res, steps, parts = self._run(TALK)
        with td:
            json.loads(json.dumps(res))

    def test_unbroken_recording_is_reported_at_the_speaker_pick(self) -> None:
        td, work, res, steps, parts = self._run([("talk", 20.0)])
        with td:
            self.assertEqual(res["detection"]["outcome"], "unbroken")
            self.assertIn("one take", res["speakers"][0]["sample_text"])
            self.assertIn("no pauses", res["note"])

    def test_silent_recording_fails_with_an_authored_sentence(self) -> None:
        """`UserFacing` is the greppable promise that this string carries no
        internals — it reaches the client verbatim (errors.sanitize_detail)."""
        with TemporaryDirectory() as td:
            wd = Path(td)
            src = wd / "src.wav"
            _write(src, [0.0] * int(12 * RATE))
            with self.assertRaises(UserFacing) as cm:
                ingest.sovereign_analyze(src, wd / "work")
            self.assertIn("silence", str(cm.exception))
            self.assertNotIn(str(wd), str(cm.exception))     # no paths leak

    def test_too_short_recording_fails_with_its_own_sentence(self) -> None:
        with TemporaryDirectory() as td:
            wd = Path(td)
            src = wd / "src.wav"
            _clip(src, [("talk", 0.6)], amp=0.4)
            with self.assertRaises(UserFacing) as cm:
                ingest.sovereign_analyze(src, wd / "work")
            self.assertIn("minimum", str(cm.exception))

    def test_feeds_label_and_stem_a_baseline_only_result(self) -> None:
        """The whole sovereign scan, through to the stems the user reviews."""
        td, work, res, steps, parts = self._run(TALK)
        with td:
            out = ingest.label_and_stem(work, "speaker_0", mode="sovereign")
            self.assertTrue(out["segments"])
            self.assertEqual({s["emotion"] for s in out["segments"]}, {BASELINE})
            self.assertEqual({s["model"] for s in out["segments"]}, {"local"})
            self.assertEqual([s["emotion"] for s in out["stems"]], [BASELINE])
            base = out["stems"][0]
            self.assertTrue(base["eligible"])
            self.assertTrue((work / "stem_baseline.wav").is_file())
            self.assertEqual(out["spend"]["total_calls"], 0)   # nothing left the box


if __name__ == "__main__":
    unittest.main()
