"""Character-from-recording pipeline (scan → review → commit).

Two ingest modes:

CLOUD ("quality" — richest results, audio leaves the machine):
  1. INGEST   ffmpeg extracts audio.
  2. MAP      ElevenLabs Scribe → diarized words + timestamps → pick target speaker.
  3. ISOLATE  ElevenLabs Voice Isolator → clean studio track (timing preserved).
  4. LABEL    Gemini 3.5-flash classifies each segment into our emotion scale;
              low-confidence segments escalate to gemini-3.1-pro-preview.
  5. STEM     group segments by emotion → splice (level-matched, crossfaded) →
              one clean sample/emotion. The baseline (neutral) stem is built from
              baseline-labelled audio ONLY; see plan_baseline for the stated
              fallback when a recording has too little neutral speech.

SOVEREIGN (audio NEVER leaves the machine — ffmpeg only, no API keys):
  1. CLEAN    ffmpeg highpass + afftdn denoise + loudnorm → clean.wav.
  2. DETECT   ffmpeg silencedetect → speech spans (single-speaker assumption —
              the normal case when cloning your own recording; no diarization).
  3. LABEL    everything is baseline (no cloud classifier); emotions are added
              afterwards via the studio's guided per-emotion recorder.
  4. STEM     one baseline stem, same review/commit flow as cloud mode.

  --- user reviews the proposed stems here (assign / descope / extend) ---
  6. COMMIT   pocket-tts export-voice on each accepted stem → the Character's
              emotion Voices (into the shared voices/ + _meta.json store).

`scan()` does the pre-commit steps and leaves stem wavs in a work dir;
`commit()` clones the chosen stems. Cloud keys from env: ELEVEN_LABS_API_KEY,
GEMINI_API_KEY (absent keys auto-select sovereign mode).
CLI (one-shot): python -m service.ingest <audio> --character NAME [--dry-run]
"""
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import subprocess
import sys
import threading
import uuid
import wave
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, NamedTuple

import numpy as np

from service.config import SETTINGS
from service.emotions import BASELINE, EMOTION_SCALE
from service.voices import VOICES_DIR, _load_meta, _slug, mutate_meta

ELEVEN_KEY = os.environ.get("ELEVEN_LABS_API_KEY", "")
GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "")
FLASH_MODEL = os.environ.get("INGEST_FLASH_MODEL", "gemini-3.5-flash")
PRO_MODEL = os.environ.get("INGEST_PRO_MODEL", "gemini-3.1-pro-preview")
EMOTIONS = list(EMOTION_SCALE)

# Bounded pool for per-segment labeling. Cloud labeling does an ffmpeg extract +
# a blocking Gemini urlopen per segment; running a handful concurrently overlaps
# the network waits without stampeding the API. Order stays stable (results are
# mapped back by segment index), and one segment's failure never kills the batch.
LABEL_WORKERS = 4

# THE one canonical clip-cleanup filter chain, shared by EVERY clone path so a
# voice cloned via ingest (sovereign or cloud), the direct /v1/voices upload, or
# clone_test.sh all get identical conditioning: highpass drops sub-80Hz rumble,
# afftdn does spectral denoise, loudnorm normalizes loudness. Keep this the single
# source of truth — do not inline a divergent filter string anywhere else.
CLEANUP_FILTER = "highpass=f=80,afftdn=nf=-25,loudnorm"

# A stem (or upload) shorter than this clones poorly; the pipeline flags stems
# below it ineligible and commit refuses to clone them (unless allow_short).
MIN_STEM_SECONDS = 4.0

import urllib.request  # noqa: E402


def _log(m: str) -> None:
    print(m, flush=True)


# ── ffmpeg ────────────────────────────────────────────────────────────────────
def clean_audio(src: Path, dst: Path, sr: int = 24000) -> None:
    """Canonical clip cleanup → mono `sr`Hz wav using CLEANUP_FILTER. This is the
    ONE cleanup entry point for every clone path (see CLEANUP_FILTER)."""
    r = subprocess.run(
        ["ffmpeg", "-y", "-i", str(src), "-af", CLEANUP_FILTER,
         "-ac", "1", "-ar", str(sr), str(dst)],
        capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f"audio cleanup failed: {r.stderr.decode(errors='ignore')[-200:]}")


# Segment extracts seek on the INPUT (`-ss` BEFORE `-i`). With `-ss` after `-i`
# ffmpeg demuxes and DECODES everything from byte zero up to the start point and
# throws it away, so every one of the up-to-40 labelling extracts (plus every
# per-speaker preview) paid for a full decode of the recording — the largest
# avoidable CPU cost in ingest, on a CPU-only Arm product. Input seeking makes an
# extract cost the same wherever it lands.
#
# Accuracy is the trap: a bare input seek can land on the nearest seek point and
# silently shift a labelled span. So the cut is made in TWO STAGES — a coarse
# input seek to `start - _SEEK_PREROLL` (cheap, container granularity) and a fine
# output-side `-ss _SEEK_PREROLL` that decodes only the preroll and lands
# sample-accurately on `start`. The span is given as `-t` (a duration, relative
# to the seeked timeline) instead of `-to`, whose meaning after a timestamp-
# shifting input seek is easy to get wrong. See test_ingest_audio.py, which
# proves the cut boundaries by frequency on both wav and mp3 sources.
_SEEK_PREROLL = 0.5


def to_wav(src: Path, dst: Path, start: float | None = None, end: float | None = None) -> None:
    """Extract [start, end) of `src` as mono 24 kHz wav (both bounds optional)."""
    cmd = ["ffmpeg", "-y"]
    fine = 0.0
    if start is not None and start > 0:
        fine = min(start, _SEEK_PREROLL)
        cmd += ["-ss", f"{start - fine:.3f}"]  # coarse: before -i, skips the decode
    cmd += ["-i", str(src)]
    if fine > 0:
        cmd += ["-ss", f"{fine:.3f}"]          # fine: after -i, sample-accurate
    if end is not None:
        span = end - (start or 0.0)
        if span <= 0:
            raise RuntimeError(f"empty span requested: {start} → {end}")
        cmd += ["-t", f"{span:.3f}"]
    cmd += ["-ac", "1", "-ar", "24000", str(dst)]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {r.stderr.decode(errors='ignore')[-200:]}")


# ── stem splicing ─────────────────────────────────────────────────────────────
# Segments cut from different places in a recording do not join cleanly. Hard-
# splicing raw frames puts a waveform discontinuity — an audible click — at every
# boundary, and utterances recorded minutes apart routinely sit several dB apart.
# That is not cosmetic here: the stem IS the reference audio the speaker
# embedding is built from, so the clicks and the level jumps get learned. Every
# splice therefore gets:
#   * LEVEL MATCHING — each segment is scaled towards the group's MEDIAN RMS,
#     with the gain clamped to _GAIN_RANGE so one near-silent or already-hot
#     outlier is not dragged the whole way (which would pump), and then held
#     under _PEAK_CEILING so matching can never create clipping.
#   * A CROSSFADE THROUGH SILENCE — a raised-cosine fade-out, a short silent gap,
#     a fade-in. Overlapping two unrelated utterances would smear them into each
#     other; fading each edge to zero removes the discontinuity, and the gap
#     restores the natural pause between utterances that hard-splicing destroyed.
# Non-16-bit or multichannel input skips the DSP and is concatenated raw (the
# pipeline only ever produces 24 kHz mono 16-bit, via to_wav).
_FADE_SECONDS = 0.010
_GAP_SECONDS = 0.080
_GAIN_RANGE = (0.5, 2.0)
_PEAK_CEILING = 0.97
_SILENT_RMS = 1e-4


class Splice(NamedTuple):
    """What was actually WRITTEN — not what was requested. `seconds` always
    measures the file on disk, so callers can judge eligibility against the same
    number `commit` will re-measure there."""
    seconds: float
    segments: int


def _level_match(arrs: list["np.ndarray"]) -> list["np.ndarray"]:
    rms = [float(np.sqrt(np.mean(np.square(a)))) if a.size else 0.0 for a in arrs]
    voiced = [r for r in rms if r > _SILENT_RMS]
    if not voiced:
        return arrs
    target = float(np.median(voiced))
    out: list[np.ndarray] = []
    for a, r in zip(arrs, rms):
        if r <= _SILENT_RMS:
            out.append(a)
            continue
        gain = min(max(target / r, _GAIN_RANGE[0]), _GAIN_RANGE[1])
        peak = float(np.max(np.abs(a)))
        if peak * gain > _PEAK_CEILING:
            gain = _PEAK_CEILING / peak
        out.append(a * gain)
    return out


def _fade_edges(a: "np.ndarray", rate: int) -> None:
    """Raised-cosine fade in/out, in place — the click killer at each splice."""
    n = min(int(_FADE_SECONDS * rate), a.size // 2)
    if n <= 0:
        return
    ramp = (0.5 - 0.5 * np.cos(np.linspace(0.0, np.pi, n))).astype(np.float32)
    a[:n] *= ramp
    a[-n:] *= ramp[::-1]


def concat_wavs(paths: list[Path], dst: Path, cap_seconds: float = 30.0) -> Splice:
    """Splice segment wavs into one stem; returns what was written.

    CAP SEMANTICS: `cap_seconds` is a HARD CEILING on the written file, at
    whole-segment granularity — the first segment that would overflow it ends the
    stem instead of being appended (the old code appended and *then* broke, so
    the file could run past the cap while the reported length was clamped to it:
    two different numbers for one stem). A single segment longer than the whole
    cap is truncated to it rather than dropped, so an unbroken monologue still
    yields a stem. The returned `seconds` is measured from the frames written,
    silent gaps included, and therefore always matches the file.
    """
    if not paths:
        raise RuntimeError("no speech detected in the clip")
    raw: list[bytes] = []
    params = None
    for p in paths:
        with wave.open(str(p), "rb") as w:
            if params is None:
                params = w.getparams()
            raw.append(w.readframes(w.getnframes()))
    assert params is not None
    rate = params.framerate
    width = params.sampwidth * params.nchannels
    spliceable = params.sampwidth == 2 and params.nchannels == 1
    gap_frames = int(_GAP_SECONDS * rate) if spliceable else 0

    # Select under the cap BEFORE any DSP, counting the gaps that will be added.
    cap_frames = max(1, int(cap_seconds * rate))
    kept: list[bytes] = []
    frames = 0
    for b in raw:
        n = len(b) // width
        add = n + (gap_frames if kept else 0)
        if frames + add > cap_frames:
            if kept:
                break                          # whole-segment granularity
            b = b[:cap_frames * width]         # lone oversize segment → truncate
            add = len(b) // width
        kept.append(b)
        frames += add

    if spliceable:
        arrs = [np.frombuffer(b, dtype="<i2").astype(np.float32) / 32768.0 for b in kept]
        arrs = _level_match(arrs)
        for a in arrs:
            _fade_edges(a, rate)
        silence = np.zeros(gap_frames, dtype=np.float32)
        pieces = [x for a in arrs for x in (silence, a)][1:]  # no leading gap
        joined = np.concatenate(pieces) if pieces else np.zeros(0, dtype=np.float32)
        peak = float(np.max(np.abs(joined))) if joined.size else 0.0
        if peak > _PEAK_CEILING:
            joined = joined * (_PEAK_CEILING / peak)
        out = np.clip(np.round(joined * 32767.0), -32768, 32767).astype("<i2").tobytes()
    else:
        out = b"".join(kept)

    with wave.open(str(dst), "wb") as w:
        w.setparams(params)
        w.writeframes(out)
    return Splice(round((len(out) // width) / rate, 2), len(kept))


def _wav_seconds(path: Path) -> float:
    with wave.open(str(path), "rb") as w:
        return w.getnframes() / w.getframerate()


# ── ElevenLabs ────────────────────────────────────────────────────────────────
def _multipart(fields: dict[str, str], file_field: str, path: Path) -> tuple[bytes, str]:
    boundary = "----gvt" + uuid.uuid4().hex
    body = b""
    for k, v in fields.items():
        body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
    ctype = mimetypes.guess_type(str(path))[0] or "audio/mpeg"
    body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{file_field}\"; "
             f"filename=\"{path.name}\"\r\nContent-Type: {ctype}\r\n\r\n").encode()
    body += path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    return body, boundary


def scribe(path: Path) -> dict:
    body, boundary = _multipart(
        {"model_id": "scribe_v1", "diarize": "true", "timestamps_granularity": "word",
         "tag_audio_events": "true"}, "file", path)
    req = urllib.request.Request(
        "https://api.elevenlabs.io/v1/speech-to-text", data=body,
        headers={"xi-api-key": ELEVEN_KEY, "Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r)


def voice_isolate(path: Path, dst_mp3: Path) -> None:
    body, boundary = _multipart({}, "audio", path)
    req = urllib.request.Request(
        "https://api.elevenlabs.io/v1/audio-isolation", data=body,
        headers={"xi-api-key": ELEVEN_KEY, "Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=300) as r:
        dst_mp3.write_bytes(r.read())


# ── Gemini emotion ────────────────────────────────────────────────────────────
def _gemini(model: str, wav: Path) -> dict:
    audio = base64.b64encode(wav.read_bytes()).decode()
    prompt = (
        "Listen to the audio. Classify the speaker's EMOTIONAL DELIVERY (vocal tone/prosody, "
        f"not the words) into EXACTLY one of: {', '.join(EMOTIONS)}. "
        "Reply ONLY as compact JSON: {\"emotion\":\"...\",\"confidence\":0-1,\"cue\":\"<=8 words\"}.")
    body = json.dumps({
        "contents": [{"parts": [{"text": prompt}, {"inline_data": {"mime_type": "audio/wav", "data": audio}}]}],
        "generationConfig": {"responseMimeType": "application/json", "temperature": 0},
    }).encode()
    req = urllib.request.Request(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={GEMINI_KEY}",
        data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        out = json.load(r)
    d = json.loads(out["candidates"][0]["content"]["parts"][0]["text"])
    emo = str(d.get("emotion", "")).lower().strip()
    return {"emotion": emo if emo in EMOTIONS else BASELINE,
            "confidence": float(d.get("confidence", 0)), "cue": d.get("cue", "")}


def label_emotion(wav: Path, escalate_below: float = 0.7) -> dict:
    res = _gemini(FLASH_MODEL, wav)
    res["model"] = FLASH_MODEL
    if res["confidence"] < escalate_below:
        try:
            pro = _gemini(PRO_MODEL, wav)
            pro["model"] = PRO_MODEL
            return pro
        except Exception:  # noqa: BLE001
            pass
    return res


# ── sovereign mode (local-only, ffmpeg — audio never leaves the machine) ─────
def clean_local(src: Path, dst: Path) -> None:
    """Local stand-in for the Voice Isolator: rumble filter + spectral denoise
    + loudness normalization (the canonical CLEANUP_FILTER). Not studio
    isolation, but honest local cleanup — audio never leaves the machine."""
    clean_audio(src, dst)


def detect_speech(wav: Path, noise_db: float = -35.0, min_silence: float = 0.5,
                  min_dur: float = 1.2, max_dur: float = 15.0) -> list[dict]:
    """Speech spans via ffmpeg silencedetect (inverted), single speaker.
    Long spans are split at max_dur so stem concatenation stays balanced."""
    import re

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
    if not spans and total >= min_dur:  # no silence found at all — one big span
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


def sovereign_analyze(audio: Path, work_dir: Path,
                      progress: Callable[[str, str], None] | None = None,
                      partial: Callable[[dict], None] | None = None) -> dict:
    """Local-only analyze: same outputs/shape as analyze(), no network I/O."""
    work_dir.mkdir(parents=True, exist_ok=True)

    def prog(k: str, s: str) -> None:
        if progress:
            progress(k, s)

    prog("isolate", "active")
    clean = work_dir / "clean.wav"
    clean_local(audio, clean)
    prog("isolate", "done")

    prog("transcribe", "active")
    segs = detect_speech(clean)
    with wave.open(str(clean), "rb") as w:
        duration = round(w.getnframes() / w.getframerate(), 2)
    if partial:
        partial({"words": 0, "speakers": ["speaker_0"],
                 "transcript": "(sovereign mode — no transcription, audio stayed on this machine)"})
    prog("transcribe", "done")

    (work_dir / "segments.json").write_text(json.dumps(segs), "utf-8")
    speakers: list[dict] = []
    if segs:
        secs = round(sum(s["end"] - s["start"] for s in segs), 1)
        longest = max(segs, key=lambda s: s["end"] - s["start"])
        pv = work_dir / "speaker_speaker_0.wav"
        to_wav(clean, pv, longest["start"], min(longest["end"], longest["start"] + 6))
        speakers.append({"id": "speaker_0", "utterances": len(segs), "seconds": secs,
                         "sample_text": "(local mode — no transcript)"})
    return {"duration": duration, "transcript": "", "speakers": speakers}


# ── segmentation ──────────────────────────────────────────────────────────────
def build_segments(words: list[dict], min_gap: float = 0.6, min_dur: float = 1.2) -> list[dict]:
    segs: list[dict] = []
    cur = None
    for w in words:
        if w.get("type") != "word":
            continue
        spk = w.get("speaker_id", "speaker_0")
        st, en = float(w["start"]), float(w["end"])
        if cur and cur["speaker"] == spk and st - cur["end"] <= min_gap:
            cur["end"] = en
            cur["text"] += " " + w["text"]
        else:
            if cur and cur["end"] - cur["start"] >= min_dur:
                segs.append(cur)
            cur = {"speaker": spk, "start": st, "end": en, "text": w["text"]}
    if cur and cur["end"] - cur["start"] >= min_dur:
        segs.append(cur)
    return segs


# ── ANALYZE (transcribe + isolate; stop for speaker pick) ─────────────────────
def analyze(audio: Path, work_dir: Path,
            progress: Callable[[str, str], None] | None = None,
            partial: Callable[[dict], None] | None = None) -> dict:
    """Steps 1-2 + per-speaker stats. Saves clean.wav, segments.json, and a
    preview clip per speaker. Returns { duration, transcript, speakers:[...] }."""
    assert ELEVEN_KEY and GEMINI_KEY, "ELEVEN_LABS_API_KEY / GEMINI_API_KEY missing"
    work_dir.mkdir(parents=True, exist_ok=True)

    def prog(k: str, s: str) -> None:
        if progress:
            progress(k, s)

    prog("transcribe", "active")
    tr = scribe(audio)
    words = tr.get("words", [])
    duration = tr.get("audio_duration_secs", 0)
    transcript = (tr.get("text") or "")[:600]
    all_segs = build_segments(words)
    if partial:
        partial({"words": sum(1 for w in words if w.get("type") == "word"),
                 "speakers": sorted({s["speaker"] for s in all_segs}),
                 "transcript": transcript})
    prog("transcribe", "done")

    prog("isolate", "active")
    iso = work_dir / "iso.mp3"
    voice_isolate(audio, iso)
    clean = work_dir / "clean.wav"
    clean_audio(iso, clean)  # canonical cleanup (adds loudnorm) after isolation
    prog("isolate", "done")

    # per-speaker stats + a preview clip (their longest utterance, capped)
    (work_dir / "segments.json").write_text(json.dumps(all_segs), "utf-8")
    speakers: list[dict] = []
    for sid in sorted({s["speaker"] for s in all_segs}):
        ss = [s for s in all_segs if s["speaker"] == sid]
        secs = round(sum(s["end"] - s["start"] for s in ss), 1)
        longest = max(ss, key=lambda s: s["end"] - s["start"])
        pv = work_dir / f"speaker_{sid}.wav"
        to_wav(clean, pv, longest["start"], min(longest["end"], longest["start"] + 6))
        speakers.append({"id": sid, "utterances": len(ss), "seconds": secs,
                         "sample_text": longest["text"][:80]})
    speakers.sort(key=lambda s: -s["seconds"])
    return {"duration": duration, "transcript": transcript, "speakers": speakers}


# ── baseline (neutral) stem composition ───────────────────────────────────────
# Order in which non-neutral emotions may be borrowed when there is not enough
# baseline-labelled audio: nearest-to-neutral delivery first. `whisper` is last
# despite being low-arousal — it lacks full phonation, so it is the worst thing
# to teach a neutral speaker embedding. Custom emotions (not on this list) come
# after everything listed, alphabetically. This is a borrow ORDER, not a change
# to the emotion scale.
BASELINE_BORROW_ORDER = ["calm", "confused", "sad", "happy", "excited", "angry", "whisper"]


class BaselinePlan(NamedTuple):
    labs: list[dict]              # segments to splice, in the order to splice them
    borrowed: list[dict]          # [{emotion, segments}] non-neutral top-up, if any
    neutral_seconds: float        # how much genuinely baseline-labelled audio existed
    neutral_segments: int


def plan_baseline(by_emotion: dict[str, list[dict]], min_stem: float) -> BaselinePlan:
    """Choose the segments for the NEUTRAL reference stem.

    The baseline Voice is what every untagged line of speech is cloned from, so
    what goes in here decides how the character sounds by default. The pipeline
    used to concatenate EVERY usable segment — the angry, sad and excited takes
    included — which made the "neutral" embedding an average of every emotion in
    the recording. It is now built from baseline-labelled audio ONLY.

    When there is not enough of that to clear `min_stem` the stem would be
    ineligible and the Character would ship with no neutral Voice at all, so we
    top it up — but only just enough to clear the bar, nearest-neutral emotion
    first (BASELINE_BORROW_ORDER), and the borrow is reported so the UI states
    it. The thing we refuse is silence: an emotionally blended baseline must
    never be presented as a clean one.

    Segments are measured by their extracted wav (the same measurement the stem
    file will have), not by the labelled span, and stay in recording order.
    """
    def _dur(l: dict) -> float:
        try:
            return _wav_seconds(Path(l["wav"]))
        except Exception:  # noqa: BLE001 - a missing wav simply contributes nothing
            return 0.0

    labs = sorted(by_emotion.get(BASELINE, []), key=lambda l: l["i"])
    neutral = sum(_dur(l) for l in labs)
    have = neutral
    plan = list(labs)
    borrowed: list[dict] = []
    if have < min_stem:
        rank = {e: i for i, e in enumerate(BASELINE_BORROW_ORDER)}
        others = sorted((e for e in by_emotion if e != BASELINE),
                        key=lambda e: (rank.get(e, len(rank)), e))
        for emo in others:
            if have >= min_stem:
                break
            taken = 0
            for l in sorted(by_emotion[emo], key=lambda l: l["i"]):
                if have >= min_stem:
                    break
                plan.append(l)
                have += _dur(l)
                taken += 1
            if taken:
                borrowed.append({"emotion": emo, "segments": taken})
    return BaselinePlan(plan, borrowed, round(neutral, 2), len(labs))


def baseline_note(plan: BaselinePlan, seconds: float, min_stem: float) -> str | None:
    """The user-visible sentence explaining a non-pure baseline stem. None when
    the stem is genuinely all-neutral — the fallback is never silent."""
    if not plan.borrowed:
        return None
    what = ", ".join(f"{b['segments']}× {b['emotion']}" for b in plan.borrowed)
    head = (f"only {plan.neutral_seconds:.1f}s of neutral speech in this recording "
            f"({plan.neutral_segments} segment(s))")
    if seconds >= min_stem:
        return (f"{head} — topped up with {what} to reach the {min_stem:.0f}s minimum, "
                f"so this voice is not purely neutral. Record more neutral speech for "
                f"a cleaner default voice.")
    return (f"{head} — still under the {min_stem:.0f}s minimum even after borrowing "
            f"{what}. Record more neutral speech.")


# ── LABEL + STEM for a chosen speaker ─────────────────────────────────────────
def label_and_stem(work_dir: Path, target: str, min_stem: float = MIN_STEM_SECONDS, limit: int = 40,
                   progress: Callable[[str, str], None] | None = None,
                   partial: Callable[[dict], None] | None = None,
                   mode: str = "cloud") -> dict:
    def prog(k: str, s: str) -> None:
        if progress:
            progress(k, s)

    all_segs = json.loads((work_dir / "segments.json").read_text("utf-8"))
    tsegs = [s for s in all_segs if s["speaker"] == target]
    clean = work_dir / "clean.wav"

    prog("label", "active")
    todo = tsegs[:limit]
    # Each segment is extracted + classified on a bounded pool; results are
    # written back BY INDEX so the final order is identical to serial labeling.
    results: list[dict | None] = [None] * len(todo)
    counts: dict[str, int] = {}
    state = {"done": 0, "errors": 0}
    prog_lock = threading.Lock()

    def _label_seg(i: int, s: dict) -> None:
        """Extract + classify one segment. A failure (ffmpeg extract OR the
        classifier) degrades THIS segment to baseline and is counted, without
        killing the batch."""
        seg_wav = work_dir / f"seg_{i:03d}.wav"
        failed = False
        try:
            to_wav(clean, seg_wav, s["start"], s["end"])
            if mode == "sovereign":
                # No cloud classifier: everything is baseline. Emotions get added
                # afterwards via the studio's guided per-emotion recorder.
                lab = {"emotion": BASELINE, "confidence": 1.0, "cue": "", "model": "local"}
            else:
                lab = label_emotion(seg_wav)
        except Exception:  # noqa: BLE001 - one segment must not fail the batch
            failed = True
            lab = {"emotion": BASELINE, "confidence": 0.0, "cue": "", "model": "error"}
        lab.update({"i": i, "dur": round(s["end"] - s["start"], 2),
                    "text": s["text"][:60], "wav": str(seg_wav),
                    "ok": (not failed) and seg_wav.is_file()})
        with prog_lock:
            results[i] = lab
            counts[lab["emotion"]] = counts.get(lab["emotion"], 0) + 1
            state["done"] += 1
            if failed:
                state["errors"] += 1
            if partial:
                partial({"segments_total": len(todo), "segments_done": state["done"],
                         "emotion_counts": dict(counts), "label_errors": state["errors"]})

    if todo:
        with ThreadPoolExecutor(max_workers=min(LABEL_WORKERS, len(todo))) as pool:
            for fut in [pool.submit(_label_seg, i, s) for i, s in enumerate(todo)]:
                fut.result()  # re-raise only truly unexpected errors (not per-seg)
    labelled = [r for r in results if r is not None]
    prog("label", "done")

    prog("stem", "active")
    # Only segments whose wav was actually written can feed a stem; a segment
    # that failed extraction is still labelled/counted but contributes no audio.
    usable = [l for l in labelled if l.get("ok")]
    by_emotion: dict[str, list[dict]] = {}
    for lab in usable:
        by_emotion.setdefault(lab["emotion"], []).append(lab)
    stems: list[dict] = []

    plan = plan_baseline(by_emotion, min_stem)
    base_wav = work_dir / "stem_baseline.wav"
    base = concat_wavs([Path(l["wav"]) for l in plan.labs], base_wav)
    stems.append({"emotion": BASELINE, "seconds": base.seconds, "segments": base.segments,
                  "eligible": base.seconds >= min_stem, "cues": [],
                  "note": baseline_note(plan, base.seconds, min_stem)})
    for emo, labs in by_emotion.items():
        if emo == BASELINE:
            continue
        labs = sorted(labs, key=lambda l: l["i"])      # recording order, always
        sw = work_dir / f"stem_{emo}.wav"
        d = concat_wavs([Path(l["wav"]) for l in labs], sw)
        # Eligibility is judged on the WRITTEN file — the exact measurement
        # commit() re-takes — so the UI can never promise a stem that then gets
        # skipped at commit with no user-visible reason.
        stems.append({"emotion": emo, "seconds": d.seconds, "segments": d.segments,
                      "eligible": d.seconds >= min_stem,
                      "cues": [l["cue"] for l in labs[:3]], "note": None})
    order = {e: i for i, e in enumerate(EMOTION_SCALE)}
    stems.sort(key=lambda s: order.get(s["emotion"], 99))
    prog("stem", "done")

    return {"target": target, "utterances": len(tsegs), "min_stem": min_stem, "stems": stems,
            "segments": [{"emotion": l["emotion"], "confidence": l["confidence"], "cue": l["cue"],
                          "dur": l["dur"], "text": l["text"], "model": l["model"]} for l in labelled]}


def resolve_mode(mode: str = "auto") -> str:
    """auto → cloud when both API keys exist, else sovereign (local-only)."""
    if mode in ("cloud", "sovereign"):
        return mode
    return "cloud" if (ELEVEN_KEY and GEMINI_KEY) else "sovereign"


# ── one-shot scan (CLI convenience: analyze → auto speaker → label) ────────────
def scan(audio: Path, work_dir: Path, speaker: str = "auto", min_stem: float = MIN_STEM_SECONDS,
         limit: int = 40, progress: Callable[[str, str], None] | None = None,
         mode: str = "auto") -> dict:
    mode = resolve_mode(mode)
    a = (sovereign_analyze if mode == "sovereign" else analyze)(audio, work_dir, progress)
    if not a["speakers"]:
        raise RuntimeError("no speech detected in the clip")
    target = a["speakers"][0]["id"] if speaker == "auto" else speaker
    r = label_and_stem(work_dir, target, min_stem, limit, progress, mode=mode)
    return {"duration": a["duration"], "speakers": [s["id"] for s in a["speakers"]],
            "mode": mode, **r}


# ── COMMIT (clone selected stems) ─────────────────────────────────────────────
def commit(work_dir: Path, character: str, emotions: list[str], existing_cid: str | None = None,
           *, consent: str | None = None, clip_sha256: str | None = None,
           progress: Callable[[int, str | None], None] | None = None,
           should_cancel: Callable[[], bool] | None = None,
           allow_short: bool = False) -> list[dict]:
    """Clone each accepted stem into a Voice.

    Cloning runs in ONE child process (`python -m service.export_stems`) that
    loads the Pocket TTS model a single time and exports every stem in a loop —
    instead of one `pocket_tts export-voice` subprocess (one cold ~15s CPU model
    load) per emotion. The child streams a JSON status line per finished stem on
    stdout; we parse them to drive `progress(done, current)` and to poll
    `should_cancel()` between emotions (a cancel terminates the child after the
    current line). When `consent` (the attestation statement) is given, a consent
    receipt is stamped into each created Voice's metadata.

    Eligibility: a stem shorter than MIN_STEM_SECONDS clones poorly, so it is
    SKIPPED (never cloned) and reported — the whole commit does not fail. Pass
    `allow_short=True` (internal callers only; never exposed over HTTP) to clone
    short stems anyway. The returned list contains only the Voices actually
    created; skipped emotions are simply absent from it (and logged)."""
    cid = existing_cid or _slug(character)
    meta = _load_meta()
    name = meta["characters"].get(cid, {}).get("name", character) if existing_cid else character

    created: list[dict] = []
    if should_cancel and should_cancel():
        return created

    # Build the export plan: one entry per ELIGIBLE stem present on disk. Stems
    # under the minimum are skipped (reported) instead of cloned into a bad Voice.
    plan: list[dict] = []  # {emotion, src, dst, voice_id, seconds}
    skipped: list[dict] = []
    for emo in emotions:
        sw = work_dir / f"stem_{emo}.wav"
        if not sw.is_file():
            continue
        with wave.open(str(sw), "rb") as w:
            seconds = round(w.getnframes() / w.getframerate(), 2)
        if not allow_short and seconds < MIN_STEM_SECONDS:
            skipped.append({"emotion": emo, "seconds": seconds})
            _log(f"commit: skipping '{emo}' — {seconds:.2f}s < {MIN_STEM_SECONDS:.0f}s minimum")
            continue
        voice_id = f"{cid}-{emo}-{uuid.uuid4().hex[:6]}"
        plan.append({"emotion": emo, "src": str(sw), "seconds": seconds,
                     "voice_id": voice_id,
                     "dst": str(VOICES_DIR / f"{voice_id}.safetensors")})

    if not plan:
        if progress:
            progress(len(emotions), None)
        return created

    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    spec_path = work_dir / "export_spec.json"
    spec_path.write_text(json.dumps({
        "language": SETTINGS.language, "quantize": SETTINGS.quantize,
        "stems": [{"emotion": p["emotion"], "src": p["src"], "dst": p["dst"]} for p in plan],
    }), "utf-8")

    by_emotion = {p["emotion"]: p for p in plan}
    proc = subprocess.Popen(
        [sys.executable, "-m", "service.export_stems", str(spec_path)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    # Drain stderr on a separate thread. The child imports torch + pocket_tts
    # and can emit far more than the OS pipe buffer (~64 KB) to stderr while we
    # are blocked reading stdout — with no concurrent stderr reader, both sides
    # wedge (classic two-pipe deadlock). Collect it for the failure message.
    _stderr_chunks: list[str] = []

    def _drain_stderr() -> None:
        if proc.stderr is not None:
            for chunk in proc.stderr:
                _stderr_chunks.append(chunk)

    _stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
    _stderr_thread.start()

    def _terminate() -> None:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:  # noqa: BLE001
            proc.kill()

    done = 0
    cancelled = False
    if progress:
        progress(0, plan[0]["emotion"])
    assert proc.stdout is not None
    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            evt = json.loads(line)
        except json.JSONDecodeError:
            continue
        emo = evt.get("emotion")
        p = by_emotion.get(emo)
        if p is None:
            continue
        if not evt.get("ok") or not Path(p["dst"]).is_file():
            _terminate()
            raise RuntimeError(f"clone {emo} failed: {evt.get('error') or 'export error'}")
        entry = {
            "name": name, "character_id": cid, "emotion": emo,
            "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "sample_seconds": p["seconds"], "lang": "EN", "source": "ingest"}
        if consent is not None:
            entry["consent"] = {
                "consented_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "clip_sha256": clip_sha256, "statement": consent}

        def _add(meta, entry=entry, vid=p["voice_id"]):
            meta["voices"][vid] = entry
            meta["characters"].setdefault(cid, {"name": name, "tags": ["ingested"]})
        mutate_meta(_add)
        created.append({"voice_id": p["voice_id"], "emotion": emo, "seconds": p["seconds"]})
        done += 1
        if progress:
            progress(done, None)
        if should_cancel and should_cancel():  # cancel between emotions
            cancelled = True
            _terminate()
            break
        if progress and done < len(plan):
            progress(done, plan[done]["emotion"])
    ret = proc.wait()
    _stderr_thread.join(timeout=5)
    if not cancelled and ret != 0 and len(created) < len(plan):
        err = "".join(_stderr_chunks)[-200:]
        raise RuntimeError(f"clone failed: {err or 'export_stems exited nonzero'}")
    return created


# ── CLI (one-shot) ────────────────────────────────────────────────────────────
def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--character", required=True)
    ap.add_argument("--speaker", default="auto")
    ap.add_argument("--min-stem", type=float, default=MIN_STEM_SECONDS)
    ap.add_argument("--limit", type=int, default=40)
    ap.add_argument("--mode", default="auto", choices=["auto", "cloud", "sovereign"],
                    help="sovereign = local-only (ffmpeg), audio never leaves the machine")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    import tempfile
    with tempfile.TemporaryDirectory(prefix="gvt-ingest-") as td:
        wd = Path(td)
        res = scan(Path(a.audio), wd, a.speaker, a.min_stem, a.limit,
                   progress=lambda k, s: _log(f"  {k}: {s}"), mode=a.mode)
        _log(json.dumps({k: v for k, v in res.items() if k != "segments"}, indent=2))
        if a.dry_run:
            return
        elig = [s["emotion"] for s in res["stems"] if s["eligible"]]
        created = commit(wd, a.character, elig)
        _log(f"created: {created}")


if __name__ == "__main__":
    main()
