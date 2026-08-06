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
  * the speaker overlay — `assign_speakers` / `diarize_segments`, which put the
    optional offline diarizer's turns on top of those spans. The diarizer is a
    ~34 MB download and is STUBBED here: no model, no sherpa-onnx, no network,
    so CI exercises the mapping and every fallback without fetching anything.
    The stub is the seam the real one plugs into (`DiarizationResult`/`Turn`
    from service/diarize.py), not a parallel invention.

Nothing here touches the network; that is the point of the mode.
"""
from __future__ import annotations

import array
import contextlib
import json
import math
import shutil
import unittest
import wave
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from service import ingest
from service.diarize import DiarizationResult, Turn
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


# ── the diarizer, stubbed ────────────────────────────────────────────────────
# The real one is sherpa-onnx plus ~34 MB of models fetched on demand — neither
# of which CI has or should acquire. What IS exercised here is every line
# ingest.py owns: the overlay, the fallbacks, and the copy each one produces.
@contextlib.contextmanager
def _stub_diarizer(result):
    """`result` None → not installed; a DiarizationResult → that answer; an
    Exception instance → the diarizer broke mid-scan."""
    from service import diarize as real

    if result is None:
        with mock.patch.object(real, "available", return_value=False):
            yield
        return

    def _run(audio, **kw):
        if isinstance(result, BaseException):
            raise result
        return result

    with mock.patch.object(real, "available", return_value=True),          mock.patch.object(real, "diarize", side_effect=_run):
        yield


def _turns(*spec: tuple[float, float, str]) -> DiarizationResult:
    return DiarizationResult(turns=[Turn(a, b, who) for a, b, who in spec],
                             diarize_s=0.01)


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

    def _run(self, pattern, amp=0.4, floor_amp=0.0005, diarizer=None):
        """`diarizer` is a stub result, or None for "not installed" — which is
        pinned rather than inherited from the machine, because a developer who
        HAS the models would otherwise get different assertions than CI."""
        td = TemporaryDirectory()
        wd = Path(td.name)
        src = wd / "src.wav"
        _clip(src, pattern, amp=amp, floor_amp=floor_amp)
        steps: list[tuple[str, str]] = []
        parts: list[dict] = []
        with _stub_diarizer(diarizer):
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
            for must in ("baseline", "diariz", "transcri"):
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


# ── the speaker overlay ──────────────────────────────────────────────────────
class AssignSpeakersTests(unittest.TestCase):
    """Turns onto spans. Pure arithmetic — no audio, no ffmpeg, no models.

    The invariant under every one of these: the spans decide what is speech and
    the overlay may only decide WHO. So the total labelled duration equals the
    span duration in every case, including the ones where the diarizer is wrong.
    """

    def _total(self, pieces) -> float:
        return round(sum(b - a for a, b, _ in pieces), 6)

    def test_span_inside_one_turn_is_left_whole(self) -> None:
        out = ingest.assign_speakers([(2.0, 5.0)], _turns((0.0, 10.0, "speaker_0")))
        self.assertEqual(out, [(2.0, 5.0, "speaker_0")])

    def test_span_straddling_a_change_is_cut_at_the_boundary(self) -> None:
        out = ingest.assign_speakers(
            [(2.0, 8.0)], _turns((0.0, 5.0, "speaker_0"), (5.0, 12.0, "speaker_1")))
        self.assertEqual(out, [(2.0, 5.0, "speaker_0"), (5.0, 8.0, "speaker_1")])
        self.assertEqual(self._total(out), 6.0)

    def test_uncovered_audio_keeps_a_neighbours_label_never_dropped(self) -> None:
        """The diarizer's VAD is stricter than the level detector's. Audio it
        skipped is still speech — the level detector measured it — so it is
        labelled from the surrounding turns rather than deleted."""
        out = ingest.assign_speakers(
            [(0.0, 10.0)], _turns((3.0, 4.0, "speaker_0"), (6.0, 7.0, "speaker_1")))
        self.assertEqual(self._total(out), 10.0)
        self.assertEqual(out[0][0], 0.0)
        self.assertEqual(out[-1][1], 10.0)
        self.assertEqual([who for _, _, who in out], ["speaker_0", "speaker_1"])

    def test_span_with_no_turn_at_all_goes_to_the_nearest_voice(self) -> None:
        out = ingest.assign_speakers(
            [(20.0, 24.0)], _turns((0.0, 5.0, "speaker_0"), (6.0, 9.0, "speaker_1")))
        self.assertEqual(out, [(20.0, 24.0, "speaker_1")])

    def test_no_turns_at_all_is_one_speaker(self) -> None:
        out = ingest.assign_speakers([(0.0, 4.0)], DiarizationResult())
        self.assertEqual(out, [(0.0, 4.0, "speaker_0")])

    def test_same_speaker_either_side_of_a_pause_does_not_fragment(self) -> None:
        """A turn boundary that lands in a pause must not split one person's
        span into two segments that later fail the min-duration test."""
        out = ingest.assign_speakers(
            [(0.0, 3.0), (4.0, 7.0)],
            _turns((0.0, 3.5, "speaker_0"), (3.5, 8.0, "speaker_0")))
        self.assertEqual(out, [(0.0, 3.0, "speaker_0"), (4.0, 7.0, "speaker_0")])


class SovereignLimitsCopyTests(unittest.TestCase):
    """Stale capability copy is the known bug class here. The limits are
    probed per machine, so BOTH answers have to be true when they are given."""

    def test_absent_diarizer_names_the_command_that_enables_speakers(self) -> None:
        blob = " ".join(ingest.sovereign_limits(False))
        self.assertIn("single speaker", blob)
        self.assertIn("service.diarize --download", blob)
        # the old copy claimed the capability did not exist; it does
        self.assertNotIn("there is no local diarization", blob)
        self.assertIn("no diarization", ingest.sovereign_note(False))

    def test_present_diarizer_states_the_caveats_not_a_promise(self) -> None:
        blob = " ".join(ingest.sovereign_limits(True))
        self.assertIn("hypothesis", blob)
        self.assertIn("skews HIGH", blob)
        self.assertIn("synthetic", blob)
        self.assertIn("DIARIZE_THRESHOLD", blob)
        # …and it must not still be telling the user to download what they have
        self.assertNotIn("--download", blob)
        self.assertIn("hypothesis", ingest.sovereign_note(True))

    def test_the_other_two_limits_are_unchanged_by_the_diarizer(self) -> None:
        for have in (True, False):
            blob = " ".join(ingest.sovereign_limits(have))
            self.assertIn("one emotion only", blob)
            self.assertIn("no transcript", blob)

    def test_an_unprobeable_diarizer_promises_less_rather_than_raising(self) -> None:
        with mock.patch("service.diarize.available", side_effect=OSError("boom")):
            self.assertFalse(ingest.diarization_available())
            self.assertIn("--download", " ".join(ingest.sovereign_limits()))


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg not available")
class SovereignDiarizationTests(unittest.TestCase):
    """Sovereign mode with the diarizer in each of its states. Borrows `_run`
    (not by subclassing, which would re-run the whole class above), and that
    helper pins the stub — nothing here reaches sherpa-onnx or the network."""

    _run = SovereignAnalyzeTests._run

    def _segments(self, work: Path) -> list[dict]:
        return json.loads((work / "segments.json").read_text("utf-8"))

    def test_two_speakers_get_segments_previews_and_the_pick_flow(self) -> None:
        td, work, res, steps, parts = self._run(
            TALK, diarizer=_turns((0.0, 6.7, "speaker_0"), (6.7, 13.0, "speaker_1")))
        with td:
            self.assertEqual(sorted(s["id"] for s in res["speakers"]),
                             ["speaker_0", "speaker_1"])
            # exactly what the cloud path produces, so the pick screen and
            # POST /{job}/speaker need to know nothing about the mode
            for sid in ("speaker_0", "speaker_1"):
                self.assertTrue((work / f"speaker_{sid}.wav").is_file())
            segs = self._segments(work)
            self.assertEqual({s["speaker"] for s in segs}, {"speaker_0", "speaker_1"})
            self.assertEqual(segs, sorted(segs, key=lambda s: s["start"]))
            d = res["detection"]["diarization"]
            self.assertTrue(d["applied"])
            self.assertEqual(d["speakers_found"], 2)
            self.assertTrue(d["speaker_count_is_a_hypothesis"])
            # the loader line and the pick line both stop claiming one speaker
            self.assertEqual(sorted(parts[0]["speakers"]), ["speaker_0", "speaker_1"])
            self.assertIn("hypothesis", res["speakers"][0]["sample_text"])

    def test_the_chosen_speaker_still_stems(self) -> None:
        """The point of separating them: one speaker's audio, alone."""
        td, work, res, steps, parts = self._run(
            TALK, diarizer=_turns((0.0, 6.7, "speaker_0"), (6.7, 13.0, "speaker_1")))
        with td:
            mine = [s for s in self._segments(work) if s["speaker"] == "speaker_1"]
            self.assertTrue(mine)
            out = ingest.label_and_stem(work, "speaker_1", mode="sovereign")
            # Only the picked speaker's spans reach the stem — that IS the
            # separation, and every one of them starts after the turn boundary.
            self.assertEqual(len(out["segments"]), len(mine))
            self.assertTrue(all(s["start"] >= 6.0 for s in mine),
                            "the other speaker's audio leaked into the stem")
            self.assertEqual([s["emotion"] for s in out["stems"]], [BASELINE])
            self.assertEqual(out["spend"]["total_calls"], 0)

    def test_one_speaker_found_is_byte_for_byte_the_undiarized_path(self) -> None:
        """No regression is not a wish here — the two runs are compared."""
        td_a, work_a, res_a, _, _ = self._run(TALK)                    # absent
        td_b, work_b, res_b, _, _ = self._run(
            TALK, diarizer=_turns((0.0, 13.0, "speaker_0")))           # 1 speaker
        with td_a, td_b:
            self.assertEqual(self._segments(work_a), self._segments(work_b))
            self.assertEqual(res_a["speakers"], res_b["speakers"])
            self.assertEqual(res_a["detection"]["outcome"],
                             res_b["detection"]["outcome"])
            self.assertEqual((work_a / "speaker_speaker_0.wav").read_bytes(),
                             (work_b / "speaker_speaker_0.wav").read_bytes())
            # …and the payload still says WHICH of the two it was
            self.assertEqual(res_b["detection"]["diarization"]["reason"],
                             "single_speaker")
            self.assertFalse(res_a["detection"]["diarization"]["attempted"])

    def test_absent_model_is_the_old_behaviour_and_says_how_to_change_it(self) -> None:
        td, work, res, steps, parts = self._run(TALK)
        with td:
            self.assertEqual([s["id"] for s in res["speakers"]], ["speaker_0"])
            d = res["detection"]["diarization"]
            self.assertFalse(d["attempted"])
            self.assertFalse(d["applied"])
            self.assertEqual(d["reason"], "unavailable")
            self.assertIn("--download", d["detail"])
            self.assertIn("service.diarize --download", " ".join(res["limits"]))

    def test_a_broken_diarizer_is_reported_not_fatal(self) -> None:
        """An enrichment that fails must not cost the user their scan."""
        td, work, res, steps, parts = self._run(
            TALK, diarizer=RuntimeError("onnxruntime fell over"))
        with td:
            self.assertEqual([s["id"] for s in res["speakers"]], ["speaker_0"])
            d = res["detection"]["diarization"]
            self.assertEqual(d["reason"], "failed")
            self.assertIn("single speaker", d["detail"])
            # the raw cause is logged, not handed to the client
            self.assertNotIn("onnxruntime", d["detail"])

    def test_a_second_speaker_too_short_to_survive_chunking_is_not_adopted(self) -> None:
        """0.4s of a second voice cannot become a segment, so adopting the
        re-cut would lose audio and separate nothing. The spans stand."""
        td_a, work_a, res_a, _, _ = self._run(TALK)
        td_b, work_b, res_b, _, _ = self._run(
            TALK, diarizer=_turns((0.0, 12.6, "speaker_0"), (12.6, 13.0, "speaker_1")))
        with td_a, td_b:
            self.assertEqual(self._segments(work_a), self._segments(work_b))
            self.assertEqual(res_b["detection"]["diarization"]["reason"],
                             "too_fragmented")
            self.assertEqual(res_b["detection"]["diarization"]["speakers_found"], 2)

    def test_result_stays_json_serialisable_with_diarization(self) -> None:
        td, work, res, steps, parts = self._run(
            TALK, diarizer=_turns((0.0, 6.7, "speaker_0"), (6.7, 13.0, "speaker_1")))
        with td:
            json.loads(json.dumps(res))


if __name__ == "__main__":
    unittest.main()
