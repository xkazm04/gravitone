"""Character-from-recording pipeline (scan → review → commit).

Two ingest modes:

CLOUD ("quality" — richest results, audio leaves the machine):
  1. INGEST   ffmpeg extracts audio.
  2. MAP      ElevenLabs Scribe → diarized words + timestamps → pick target speaker.
  3. ISOLATE  ElevenLabs Voice Isolator → clean studio track (timing preserved).
  4. LABEL    Gemini 3.5-flash classifies segments into our emotion scale, a
              BATCH of clips per request; low-confidence clips escalate to
              gemini-3.1-pro-preview within a per-job budget.

Every call to either provider goes through `_call`: retries on transient
failures only (429/5xx/timeouts), bounded backoff, and a per-JOB retry budget so
a provider that is genuinely down fails fast instead of expensively. `Spend` is
the ledger — attempts per provider, retries, escalations — and it rides on the
job so the studio can show what a scan actually cost.
  5. STEM     group segments by emotion → splice (level-matched, crossfaded) →
              one clean sample/emotion. The baseline (neutral) stem is built from
              baseline-labelled audio ONLY; see plan_baseline for the stated
              fallback when a recording has too little neutral speech.

SOVEREIGN (audio NEVER leaves the machine — ffmpeg only, no API keys):
  1. CLEAN    ffmpeg highpass + afftdn denoise + loudnorm → clean.wav.
  2. DETECT   the clip's own noise floor is MEASURED (20 ms frame RMS) and the
              silence threshold derived from it, then ffmpeg silencedetect
              (inverted) → speech spans. Single-speaker assumption; no
              diarization. Every degenerate outcome — silent, unbroken, too
              short — is named and explained rather than falling through to
              "use the whole file". See `SpeechScan` / `SOVEREIGN_LIMITS`.
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
import shutil
import subprocess
import sys
import threading
import time
import uuid
import wave
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, NamedTuple

import numpy as np

from service import voiceprint
from service.atomicio import atomic_write_text, file_lock
from service.config import SETTINGS
from service.emotions import BASELINE, EMOTION_SCALE
from service.errors import UserFacing
from service.voices import (
    VOICES_DIR, _load_meta, _slug, mutate_meta, reject_builtin_collision,
    slot_holder, stamp_measured, voice_file_path,
)

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

import urllib.error  # noqa: E402
import urllib.request  # noqa: E402


def _log(m: str) -> None:
    print(m, flush=True)


class Cancelled(Exception):
    """The job was torn down (DELETE or GC) while this phase was running.

    Distinct from a failure: nothing went wrong, the work simply must stop and
    the phase must write NOTHING further — the workdir it was using has already
    been rmtree'd. Every phase that accepts `should_cancel` raises this rather
    than returning a half-built result, so a caller can never mistake an
    abandoned phase for a finished one.
    """


def _check(should_cancel: Callable[[], bool] | None) -> None:
    """Cancellation checkpoint. Placed before each EXPENSIVE step (a paid cloud
    call, a batch of ffmpeg extracts) — cancel latency is therefore one step,
    not one phase."""
    if should_cancel and should_cancel():
        raise Cancelled()


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


# ── external calls: retries, budget, accounting ───────────────────────────────
# A cloud clone is 2 ElevenLabs calls plus one classifier call per batch of
# segments, and NONE of it used to be retried, counted or capped:
#   * one transient 500 from the Isolator failed the whole scan AFTER Scribe had
#     already been paid for;
#   * one transient 429 from Gemini silently degraded that segment to baseline —
#     the user got a worse voice and was never told why;
#   * the pro-model escalation fired on every segment under the confidence
#     threshold, uncapped and uncounted.
# The policy below is deliberately small and boring: retry only what is
# transient, back off, and STOP — per call and, more importantly, per JOB.
RETRY_ATTEMPTS = SETTINGS.ingest_retry_attempts
RETRY_BASE_S = 1.0
RETRY_MAX_S = 20.0
# Transient by definition: rate limiting, request timeout, and every 5xx. Any
# other 4xx is the request itself being wrong (bad key, bad file, too long) —
# retrying it burns money to get the identical answer, so it stays permanent.
RETRYABLE_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})


class ExternalError(RuntimeError):
    """A cloud call that failed for good (after any retries it was allowed).

    Carries the provider and HTTP status so callers can be specific; the
    message may quote the provider's response, so it is operator-facing and
    reaches clients only through `errors.sanitize_detail`.
    """

    def __init__(self, provider: str, status: int | None, detail: str) -> None:
        super().__init__(f"{provider} call failed"
                         + (f" (HTTP {status})" if status else "")
                         + (f": {detail}" if detail else ""))
        self.provider = provider
        self.status = status


class Spend:
    """One job's external-call ledger AND its budgets.

    Everything expensive in ingest goes through here, for two reasons that are
    really one: cost was invisible (nobody could say what a scan cost without
    reading an invoice) and unbounded (retries and escalations multiplied it
    with no ceiling). Counting and capping are the same act.

    The budgets are per JOB, not per call: `take_retry` is what stops a
    genuinely-down provider from being retried `RETRY_ATTEMPTS` times on every
    one of 40 segments. Thread-safe — labelling runs on a pool.
    """

    def __init__(self, retry_budget: int | None = None,
                 escalation_budget: int | None = None) -> None:
        self._lock = threading.Lock()
        self.calls: dict[str, int] = {}
        self.retries = 0
        self.retry_budget = (SETTINGS.ingest_job_retry_budget
                             if retry_budget is None else retry_budget)
        self.escalated = 0
        self.escalation_budget = (SETTINGS.ingest_escalation_budget
                                  if escalation_budget is None else escalation_budget)
        self.escalations_failed = 0
        self.escalations_skipped = 0

    def charge(self, provider: str) -> None:
        """One HTTP attempt made against `provider` — retries included, because
        a retry costs the same as the call it repeats."""
        with self._lock:
            self.calls[provider] = self.calls.get(provider, 0) + 1

    def take_retry(self) -> bool:
        with self._lock:
            if self.retries >= self.retry_budget:
                return False
            self.retries += 1
            return True

    def take_escalations(self, want: int) -> int:
        """Grant up to `want` escalations; the shortfall is recorded as skipped
        so the job can SAY it hit the cap instead of quietly labelling worse."""
        with self._lock:
            granted = max(0, min(want, self.escalation_budget - self.escalated))
            self.escalated += granted
            self.escalations_skipped += want - granted
            return granted

    def note_escalation_failure(self, n: int) -> None:
        with self._lock:
            self.escalations_failed += n

    def restore(self, snap: dict) -> None:
        """Re-seat a ledger from its own `snapshot()`, read back off disk.

        A budget that only lives in memory is not a budget: a job whose state
        was rehydrated — by a restart, or by another replica adopting it — used
        to get a brand-new `Spend`, so the retry and escalation caps this class
        exists to enforce reset themselves every time the process did. The
        BUDGETS are deliberately NOT restored: they come from settings, so an
        operator lowering a cap applies it to jobs already in flight.
        """
        with self._lock:
            calls = snap.get("calls")
            if isinstance(calls, dict):
                self.calls = {str(k): int(v) for k, v in calls.items()
                              if isinstance(v, (int, float)) and not isinstance(v, bool)}
            for field in ("retries", "escalated", "escalations_failed",
                          "escalations_skipped"):
                value = snap.get(field)
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    setattr(self, field, max(0, int(value)))

    def snapshot(self) -> dict:
        """JSON-safe view for the job's `partial`/`result` — what this job has
        actually spent, so cost is read rather than inferred."""
        with self._lock:
            return {"calls": dict(self.calls),
                    "total_calls": sum(self.calls.values()),
                    "retries": self.retries, "retry_budget": self.retry_budget,
                    "escalated": self.escalated,
                    "escalation_budget": self.escalation_budget,
                    "escalations_failed": self.escalations_failed,
                    "escalations_skipped": self.escalations_skipped}


def _retry_after(headers, cap: float = RETRY_MAX_S) -> float | None:
    """Honour a provider's own Retry-After (seconds form), capped — an
    unbounded server-chosen sleep would wedge the phase thread."""
    try:
        raw = headers.get("Retry-After") if headers else None
        return min(float(raw), cap) if raw else None
    except (TypeError, ValueError):
        return None


def _backoff(attempt: int, retry_after: float | None) -> float:
    if retry_after is not None:
        return retry_after
    return min(RETRY_MAX_S, RETRY_BASE_S * (2 ** (attempt - 1)))


def _call(req: "urllib.request.Request", timeout: float, provider: str,
          spend: "Spend | None") -> bytes:
    """Make one external request, retrying ONLY transient failures.

    Deterministic backoff (no jitter): the fan-out is at most LABEL_WORKERS
    wide, so there is no thundering herd to spread, and a predictable schedule
    is a testable one. Every attempt is charged to `spend`, and a retry must
    also win a token from the job-wide budget — so a provider that is simply
    down costs a bounded number of calls per job, not per segment.
    """
    ledger = spend or Spend()
    last: BaseException | None = None
    status: int | None = None
    for attempt in range(1, max(1, RETRY_ATTEMPTS) + 1):
        ledger.charge(provider)
        wait: float | None = None
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as exc:      # subclass of URLError: first
            last, status = exc, exc.code
            if exc.code not in RETRYABLE_STATUS:
                raise ExternalError(provider, exc.code,
                                    _body_tail(exc)) from exc
            wait = _retry_after(getattr(exc, "headers", None))
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last, status = exc, None               # connect/read timeout, DNS…
        if attempt >= max(1, RETRY_ATTEMPTS) or not ledger.take_retry():
            break
        time.sleep(_backoff(attempt, wait))
    raise ExternalError(provider, status, str(last)) from last


def _body_tail(exc: "urllib.error.HTTPError", limit: int = 200) -> str:
    try:
        return exc.read().decode(errors="ignore")[-limit:]
    except Exception:  # noqa: BLE001 - the body is a nicety, never a failure
        return ""


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


ELEVEN = "elevenlabs"


def scribe(path: Path, spend: "Spend | None" = None) -> dict:
    body, boundary = _multipart(
        {"model_id": "scribe_v1", "diarize": "true", "timestamps_granularity": "word",
         "tag_audio_events": "true"}, "file", path)
    req = urllib.request.Request(
        "https://api.elevenlabs.io/v1/speech-to-text", data=body,
        headers={"xi-api-key": ELEVEN_KEY, "Content-Type": f"multipart/form-data; boundary={boundary}"})
    return json.loads(_call(req, 300, ELEVEN, spend))


def voice_isolate(path: Path, dst_mp3: Path, spend: "Spend | None" = None) -> None:
    body, boundary = _multipart({}, "audio", path)
    req = urllib.request.Request(
        "https://api.elevenlabs.io/v1/audio-isolation", data=body,
        headers={"xi-api-key": ELEVEN_KEY, "Content-Type": f"multipart/form-data; boundary={boundary}"})
    dst_mp3.write_bytes(_call(req, 300, ELEVEN, spend))


# ── Gemini emotion ────────────────────────────────────────────────────────────
GEMINI = "gemini"
# How many clips ride in one request. Labelling used to be ONE request per
# segment — 40 per job, each re-handshaking TLS and re-sending the same
# instructions. See `_batches` for why the effective size can be smaller.
LABEL_BATCH = SETTINGS.ingest_label_batch


def _batches(n: int, size: int | None = None, workers: int = LABEL_WORKERS) -> list[list[int]]:
    """Split `n` segment indices into request-sized groups.

    The size shrinks so a SMALL job still fills the pool: batching 8 segments
    into one request would turn an 8-segment job into a single serial call and
    make it slower than before. Never fewer groups than workers while `n`
    allows, never more than `size` clips in a request.
    """
    if n <= 0:
        return []
    size = LABEL_BATCH if size is None else size
    size = max(1, min(size, -(-n // max(1, workers))))
    return [list(range(i, min(i + size, n))) for i in range(0, n, size)]


def _gemini(model: str, wavs: list[Path], spend: "Spend | None" = None) -> list[dict | None]:
    """Classify a BATCH of clips in one request; one result slot per input.

    A slot is None when the model returned nothing usable for that clip — the
    caller degrades exactly that segment rather than the batch. Clips are
    numbered in the prompt AND matched back by the index the model echoes, so a
    reordered or short reply cannot silently shift labels onto the wrong audio.
    """
    if not wavs:
        return []
    prompt = (
        f"You will hear {len(wavs)} audio clips, numbered 0 to {len(wavs) - 1} in the order "
        "given. For EACH clip, classify the speaker's EMOTIONAL DELIVERY (vocal tone/prosody, "
        f"not the words) into EXACTLY one of: {', '.join(EMOTIONS)}. Judge each clip on its "
        "own — they are unrelated excerpts, not a conversation. Reply ONLY as compact JSON: "
        "{\"labels\":[{\"index\":0,\"emotion\":\"...\",\"confidence\":0-1,\"cue\":\"<=8 words\"}]} "
        "with exactly one entry per clip.")
    parts: list[dict] = [{"text": prompt}]
    for i, wav in enumerate(wavs):
        parts.append({"text": f"Clip {i}:"})
        parts.append({"inline_data": {"mime_type": "audio/wav",
                                      "data": base64.b64encode(wav.read_bytes()).decode()}})
    body = json.dumps({
        "contents": [{"parts": parts}],
        "generationConfig": {"responseMimeType": "application/json", "temperature": 0},
    }).encode()
    req = urllib.request.Request(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={GEMINI_KEY}",
        data=body, headers={"Content-Type": "application/json"})
    raw = _call(req, 120 + 30 * len(wavs), GEMINI, spend)
    out = json.loads(raw)
    parsed = json.loads(out["candidates"][0]["content"]["parts"][0]["text"])
    rows = parsed.get("labels", parsed) if isinstance(parsed, dict) else parsed
    if isinstance(rows, dict):        # a lone object for a lone clip
        rows = [rows]
    if not isinstance(rows, list):
        raise ExternalError(GEMINI, None, "classifier reply was not a list of labels")

    res: list[dict | None] = [None] * len(wavs)
    for pos, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        try:
            idx = int(row.get("index", pos))
        except (TypeError, ValueError):
            idx = pos
        if not 0 <= idx < len(wavs) or res[idx] is not None:
            continue
        emo = str(row.get("emotion", "")).lower().strip()
        try:
            conf = float(row.get("confidence", 0))
        except (TypeError, ValueError):
            conf = 0.0
        res[idx] = {"emotion": emo if emo in EMOTIONS else BASELINE,
                    "confidence": conf, "cue": str(row.get("cue", ""))[:60]}
    return res


def label_emotions(wavs: list[Path], spend: "Spend | None" = None,
                   escalate_below: float = 0.7) -> list[dict | None]:
    """Label a batch: one flash request, then at most ONE pro request for the
    low-confidence clips inside it.

    Escalation is budgeted (`Spend.take_escalations`) — it used to fire on every
    unsure segment, uncapped, doubling that segment's bill silently. What the
    result now always tells the truth about is its SOURCE: an escalation that
    was skipped for budget or that FAILED leaves the flash label in place and
    says so (`escalation: "skipped" | "failed"`), where the old code swallowed
    the exception and returned a label indistinguishable from a confident one.
    """
    ledger = spend or Spend()
    flash = _gemini(FLASH_MODEL, wavs, ledger)
    for r in flash:
        if r is not None:
            r["model"] = FLASH_MODEL

    low = [i for i, r in enumerate(flash)
           if r is not None and r["confidence"] < escalate_below]
    if not low:
        return flash
    granted = ledger.take_escalations(len(low))
    for i in low[granted:]:
        flash[i]["escalation"] = "skipped"      # budget exhausted — say so
    pick = low[:granted]
    if not pick:
        return flash
    try:
        pro = _gemini(PRO_MODEL, [wavs[i] for i in pick], ledger)
    except Exception as exc:  # noqa: BLE001 - a failed escalation is not a failed batch
        ledger.note_escalation_failure(len(pick))
        _log(f"label: escalation to {PRO_MODEL} failed for {len(pick)} clip(s): {exc}")
        for i in pick:
            flash[i]["escalation"] = "failed"
        return flash
    for j, i in enumerate(pick):
        if pro[j] is None:
            ledger.note_escalation_failure(1)
            flash[i]["escalation"] = "failed"
            continue
        pro[j]["model"] = PRO_MODEL
        pro[j]["escalation"] = "escalated"
        flash[i] = pro[j]
    return flash


# ── sovereign mode (local-only, ffmpeg — audio never leaves the machine) ─────
# What sovereign mode CANNOT do. These are not caveats to bury: the mode is
# offered next to the cloud path as an equal choice, and a user who picks it
# gets a materially different result. Stated wherever the mode speaks.
SOVEREIGN_LIMITS = (
    "one emotion only — there is no local emotion classifier, so every segment "
    "becomes the baseline (neutral) voice; the other emotions are recorded "
    "afterwards with the guided per-emotion capture",
    "single speaker — there is no local diarization, so every detected span is "
    "treated as the same person; anyone else audible in the recording is cloned "
    "into the same voice",
    "no transcript — speech is found by level, not by words, so nothing is "
    "transcribed and no text ever leaves (or is written on) this machine",
)


def sovereign_note() -> str:
    """The one-line honest summary of the above, for a progress/partial slot."""
    return ("sovereign mode — audio stayed on this machine. No transcription, "
            "no diarization (single speaker assumed) and no emotion classifier: "
            "this scan produces the baseline voice only.")


def clean_local(src: Path, dst: Path) -> None:
    """Local stand-in for the Voice Isolator: rumble filter + spectral denoise
    + loudness normalization (the canonical CLEANUP_FILTER). Not studio
    isolation, but honest local cleanup — audio never leaves the machine.

    Deliberately the SAME filter chain as every other clone path — a sovereign
    clone must not be conditioned differently from a cloud one, or the two modes
    would produce voices that differ for a reason nobody could name. Note that
    single-pass `loudnorm` is byte-reproducible for a given input (measured:
    three runs of the same 60 s clip, identical sha256), so the two-pass form
    buys determinism we already have at ~1.6x the wall clock.
    """
    clean_audio(src, dst)


# ── speech detection: measure the clip, then threshold it ────────────────────
# The old detector asked ffmpeg for "anything under -35 dBFS is silence" — a
# constant, on a recording whose level it had never looked at. That constant is
# wrong in both directions and fails SILENTLY in both:
#   * a QUIET recording (speech below -35) is entirely "silence", so no spans
#     survive and the fallback hands back the whole file as one take;
#   * a NOISY recording (room tone above -35) has no silence anywhere, so
#     silencedetect reports nothing and the fallback hands back the whole file
#     as one take.
# Two opposite failures, one indistinguishable outcome, and no way for the user
# to know either happened. So: measure the clip's own level distribution first
# (20 ms frame RMS), put the threshold a margin above ITS noise floor, and give
# every degenerate case a name and a sentence instead of a shared fallback.
_FRAME_SECONDS = 0.02
_FLOOR_PCT = 10.0          # the quiet tenth of the clip ≈ its background
_SPEECH_PCT = 95.0         # the loud twentieth ≈ its speech, robust to clicks
_NOISE_MARGIN_DB = 8.0     # threshold sits this far ABOVE the measured floor…
_SPEECH_HEADROOM_DB = 6.0  # …and never closer than this to the speech level
_MIN_RANGE_DB = 8.0        # floor and speech this close = nothing to gate on
_SILENT_DBFS = -55.0       # louder than this is audio; quieter is silence
_DB_FLOOR = -90.0          # log floor for digital silence
# Sanity rails on the derived threshold. The low end still leaves ~15 dB above
# 16-bit dither, so a genuinely quiet (far-mic) recording is gated on its own
# floor rather than crushed back towards the old constant.
_THRESHOLD_CLAMP = (-75.0, -12.0)
# Used only when the level distribution cannot be measured (a wav that is not
# the 24 kHz mono 16-bit this pipeline produces): the old fixed constant, now
# an explicit fallback rather than the policy.
FALLBACK_NOISE_DB = -35.0


def _num(v: float) -> float | None:
    """JSON-safe: NaN/inf (an unmeasurable level) becomes None, not `NaN`."""
    return None if v != v or v in (float("inf"), float("-inf")) else v


class Levels(NamedTuple):
    """A clip's own loudness, in dBFS. `measured` is False when the file was not
    in a form we can read, in which case `threshold_db` is the fixed fallback."""
    floor_db: float
    speech_db: float
    threshold_db: float
    measured: bool


class SpeechScan(NamedTuple):
    """What detection FOUND, not merely what it returns.

    `outcome` is the honest name of the result:
      "spans"     — pauses were found and speech was cut at them (the good case)
      "unbroken"  — no pause anywhere above the threshold; the whole recording is
                    one take, which is a fact about the recording, not a success
      "silent"    — nothing above the silence level; there is no speech here
      "too_short" — real audio, but shorter than one usable span
    `note` is a sentence for the user (empty only for "spans").
    """
    segments: list[dict]
    outcome: str
    note: str | None
    levels: Levels
    spans: int
    speech_seconds: float
    total_seconds: float


def _frame_levels(wav: Path) -> "np.ndarray":
    """Per-frame RMS in dBFS. Empty when the file is not 16-bit mono (the only
    shape this pipeline produces — see to_wav/clean_audio)."""
    out: list[np.ndarray] = []
    with wave.open(str(wav), "rb") as w:
        if w.getsampwidth() != 2 or w.getnchannels() != 1:
            return np.zeros(0, dtype=np.float32)
        n = max(1, int(_FRAME_SECONDS * w.getframerate()))
        while True:  # streamed: a 15 min clip must not become 170 MB of float32
            raw = w.readframes(n * 3000)
            if not raw:
                break
            a = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
            usable = (a.size // n) * n
            if usable == 0:
                break
            out.append(np.sqrt(np.mean(np.square(a[:usable].reshape(-1, n)), axis=1)))
    if not out:
        return np.zeros(0, dtype=np.float32)
    rms = np.concatenate(out)
    return 20.0 * np.log10(np.maximum(rms, 10.0 ** (_DB_FLOOR / 20.0)))


def measure_levels(wav: Path) -> Levels:
    """Derive this clip's silence threshold from this clip."""
    frames = _frame_levels(wav)
    if frames.size < 4:
        return Levels(float("nan"), float("nan"), FALLBACK_NOISE_DB, False)
    floor = float(np.percentile(frames, _FLOOR_PCT))
    speech = float(np.percentile(frames, _SPEECH_PCT))
    thr = min(floor + _NOISE_MARGIN_DB, speech - _SPEECH_HEADROOM_DB)
    thr = min(max(thr, _THRESHOLD_CLAMP[0]), _THRESHOLD_CLAMP[1])
    return Levels(round(floor, 1), round(speech, 1), round(thr, 1), True)


def _chunk_spans(spans: list[tuple[float, float]], min_dur: float,
                 max_dur: float) -> list[dict]:
    """Cut speech spans into segments no longer than max_dur, so stem
    concatenation stays balanced. Single speaker by construction."""
    segs: list[dict] = []
    for a, b in spans:
        cur = a
        while b - cur >= min_dur:
            chunk_end = min(cur + max_dur, b)
            segs.append({"speaker": "speaker_0", "start": round(cur, 3),
                         "end": round(chunk_end, 3), "text": ""})
            cur = chunk_end
    return segs


def detect_speech(wav: Path, noise_db: float | None = None, min_silence: float = 0.5,
                  min_dur: float = 1.2, max_dur: float = 15.0) -> SpeechScan:
    """Find speech spans by level, adapting the threshold to THIS clip.

    `noise_db` overrides the derived threshold (the escape hatch, and how the
    tests pin the old fixed-constant behaviour for comparison); None — the
    default and the shipped path — measures the clip and derives it.
    """
    import re

    with wave.open(str(wav), "rb") as w:
        total = w.getnframes() / w.getframerate()
    lv = measure_levels(wav)
    threshold = lv.threshold_db if noise_db is None else float(noise_db)

    def scan(outcome: str, note: str | None, spans: list[tuple[float, float]]) -> SpeechScan:
        segs = _chunk_spans(spans, min_dur, max_dur)
        return SpeechScan(segs, outcome, note, lv, len(spans),
                          round(sum(b - a for a, b in spans), 2), round(total, 2))

    if lv.measured and lv.speech_db <= _SILENT_DBFS:
        return scan("silent", (
            f"this recording is silence — its loudest moment is {lv.speech_db:.0f} dBFS. "
            "Nothing can be cloned from it; check the microphone input and record again."
        ), [])
    if total < min_dur:
        return scan("too_short", (
            f"this recording is {total:.1f}s long, under the {min_dur:.1f}s minimum for "
            "a usable speech span. Record at least a few seconds of continuous speech."
        ), [])

    whole = [(0.0, total)]
    unbroken = (
        "no pauses were found in this recording, so the whole of it is used as one "
        "take. If it contains background noise, music or another voice, that is "
        "cloned too — record with pauses between sentences for a cleaner result.")
    if lv.measured and (lv.speech_db - lv.floor_db) < _MIN_RANGE_DB:
        # Level is flat end to end: there is no floor to separate speech from.
        return scan("unbroken", unbroken, whole)

    r = subprocess.run(
        ["ffmpeg", "-i", str(wav),
         "-af", f"silencedetect=noise={threshold}dB:d={min_silence}", "-f", "null", "-"],
        capture_output=True)
    text = r.stderr.decode(errors="ignore")
    starts = [float(x) for x in re.findall(r"silence_start:\s*([0-9.]+)", text)]
    ends = [float(x) for x in re.findall(r"silence_end:\s*([0-9.]+)", text)]

    spans: list[tuple[float, float]] = []
    silent_seconds = 0.0
    pos = 0.0
    for i, st in enumerate(starts):
        if st - pos >= min_dur:
            spans.append((pos, st))
        end = ends[i] if i < len(ends) else total
        silent_seconds += max(0.0, min(end, total) - min(st, total))
        pos = end
    if total - pos >= min_dur:
        spans.append((pos, total))

    if silent_seconds >= 0.95 * total:
        # The threshold gated the entire recording away. The old code answered
        # this with the whole file — the exact opposite of what it just measured.
        return scan("silent", (
            "no speech could be separated from the background in this recording: "
            "every part of it sits at the background level. Record closer to the "
            "microphone, or in a quieter room."
        ), [])
    if not spans:
        return scan("unbroken", unbroken, whole)
    if len(spans) == 1 and (spans[0][1] - spans[0][0]) >= 0.95 * total:
        return scan("unbroken", unbroken, spans)
    return scan("spans", None, spans)


def sovereign_analyze(audio: Path, work_dir: Path,
                      progress: Callable[[str, str], None] | None = None,
                      partial: Callable[[dict], None] | None = None) -> dict:
    """Local-only analyze: same outputs/shape as analyze(), no network I/O.

    Raises `errors.UserFacing` when detection found nothing to clone. That used
    to be silent — a silent or unusable recording produced zero speakers and the
    caller said "no speech detected in the clip" for every cause alike; the
    scan now says WHICH thing went wrong and what to do about it.
    """
    work_dir.mkdir(parents=True, exist_ok=True)

    def prog(k: str, s: str) -> None:
        if progress:
            progress(k, s)

    prog("isolate", "active")
    clean = work_dir / "clean.wav"
    clean_local(audio, clean)
    prog("isolate", "done")

    prog("transcribe", "active")
    scan = detect_speech(clean)
    with wave.open(str(clean), "rb") as w:
        duration = round(w.getnframes() / w.getframerate(), 2)
    if partial:
        partial({"words": 0, "speakers": ["speaker_0"], "transcript": sovereign_note()})
    prog("transcribe", "done")

    if not scan.segments:
        raise UserFacing(scan.note or "no speech detected in the clip")

    (work_dir / "segments.json").write_text(json.dumps(scan.segments), "utf-8")
    segs = scan.segments
    secs = round(sum(s["end"] - s["start"] for s in segs), 1)
    longest = max(segs, key=lambda s: s["end"] - s["start"])
    pv = work_dir / "speaker_speaker_0.wav"
    to_wav(clean, pv, longest["start"], min(longest["end"], longest["start"] + 6))
    # `sample_text` is the one line the speaker-pick screen renders per speaker.
    # In sovereign mode there is no transcript to put there, so it carries the
    # thing the user actually needs to know at that moment instead of a shrug.
    sample = (f"sovereign mode — {len(segs)} speech segment(s), single speaker assumed "
              "(no diarization); baseline voice only")
    if scan.outcome == "unbroken":
        sample = "sovereign mode — no pauses found, the whole recording is one take"
    speakers = [{"id": "speaker_0", "utterances": len(segs), "seconds": secs,
                 "sample_text": sample}]
    return {"duration": duration, "transcript": "", "speakers": speakers,
            "note": scan.note, "limits": list(SOVEREIGN_LIMITS),
            "detection": {"outcome": scan.outcome, "spans": scan.spans,
                          "speech_seconds": scan.speech_seconds,
                          # NaN is not JSON — an unmeasured level is None, and
                          # this dict is persisted to job state and served.
                          "noise_floor_db": _num(scan.levels.floor_db),
                          "speech_db": _num(scan.levels.speech_db),
                          "threshold_db": _num(scan.levels.threshold_db),
                          "adaptive": scan.levels.measured}}


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
            partial: Callable[[dict], None] | None = None,
            should_cancel: Callable[[], bool] | None = None,
            spend: "Spend | None" = None) -> dict:
    """Steps 1-2 + per-speaker stats. Saves clean.wav, segments.json, and a
    preview clip per speaker. Returns { duration, transcript, speakers:[...] }.

    THE TWO PAID CALLS RUN CONCURRENTLY. Scribe and the Isolator are the two
    largest wall-clock items in a scan (minutes each, 300s timeout each), they
    are independent HTTP requests against the same file, and neither consumes
    the other's output — the transcript's word timings are applied to
    `clean.wav` only after both have landed. Running them back to back doubled
    the wait for nothing. They are two `_call`s on one `urllib` module with no
    shared session or client object, and both charge the SAME `Spend`, whose
    counters are already under its own lock because labelling fans out over a
    pool — so the ledger stays honest even when one of them fails.

    What overlapping costs, stated rather than hidden:

    * A cancel can no longer PREVENT the second call. `should_cancel` is polled
      once, before both start; after that both are in flight and a cancel
      abandons their results instead of saving their price. That is inherent to
      overlapping and it is the trade this makes for halving the wall clock.
    * A scribe failure is reported after the isolator's request returns
      (bounded by its own 300s timeout) rather than immediately, because the
      alternative is leaving a thread writing into a workdir the job is about to
      abandon — the drain doctrine this module's shutdown path is built on.
    * Peak memory holds both multipart bodies at once (`_multipart` reads the
      file), so ~2x the upload rather than 1x. `MAX_UPLOAD_BYTES` is 50 MB.

    `should_cancel` is polled before the paid calls and before the local preview
    pass; a cancel raises `Cancelled`. Before this the only cancellable phase
    was commit, so pressing cancel during a scan stopped nothing — the isolator
    call still ran, and still billed."""
    assert ELEVEN_KEY and GEMINI_KEY, "ELEVEN_LABS_API_KEY / GEMINI_API_KEY missing"
    work_dir.mkdir(parents=True, exist_ok=True)

    def prog(k: str, s: str) -> None:
        if progress:
            progress(k, s)

    ledger = spend or Spend()
    _check(should_cancel)

    # Both steps go active together because both really are: the reporting has
    # to describe the overlap rather than invent a sequence that no longer
    # happens. Each is marked done by whichever side finishes it.
    iso = work_dir / "iso.mp3"
    clean = work_dir / "clean.wav"
    prog("transcribe", "active")
    prog("isolate", "active")

    isolation: dict[str, BaseException | None] = {"error": None}

    def _isolate() -> None:
        try:
            voice_isolate(audio, iso, ledger)
            # Canonical cleanup (adds loudnorm) after isolation. It rides in
            # this thread too: it is the rest of the isolate STEP, and doing it
            # here overlaps the ffmpeg pass with the transcription as well.
            clean_audio(iso, clean)
        except BaseException as exc:  # noqa: BLE001 - carried out, never swallowed
            isolation["error"] = exc

    worker = threading.Thread(target=_isolate, name="ingest-isolate", daemon=True)
    worker.start()

    transcription: BaseException | None = None
    tr: dict = {}
    try:
        tr = scribe(audio, ledger)
    except BaseException as exc:  # noqa: BLE001 - re-raised below, after the join
        transcription = exc

    all_segs: list[dict] = []
    duration = 0
    transcript = ""
    if transcription is None:
        # Published the moment the transcript lands, BEFORE waiting on the
        # isolator: the word count and speaker list are what the loader shows
        # while the other call is still out.
        words = tr.get("words", [])
        duration = tr.get("audio_duration_secs", 0)
        transcript = (tr.get("text") or "")[:600]
        all_segs = build_segments(words)
        if partial:
            partial({"words": sum(1 for w in words if w.get("type") == "word"),
                     "speakers": sorted({s["speaker"] for s in all_segs}),
                     "transcript": transcript, "spend": ledger.snapshot()})
        prog("transcribe", "done")

    worker.join()
    # ABANDONMENT BEATS BOTH RESULTS. A cancel that lands while the two calls
    # are out cannot un-bill them, but it does mean nobody is waiting for what
    # they returned — including for the reason either of them failed. Same
    # user-visible outcome as before (the job is torn down either way), said as
    # the abandonment it is.
    _check(should_cancel)
    # Scribe first when BOTH failed: that is the error this phase raised before
    # the two calls overlapped (the isolator never ran), and a user-visible
    # message must not change because of an internal scheduling decision.
    if transcription is not None:
        raise transcription
    if isolation["error"] is not None:
        raise isolation["error"]
    prog("isolate", "done")

    # per-speaker stats + a preview clip (their longest utterance, capped)
    _check(should_cancel)          # one ffmpeg extract per speaker follows
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
    return {"duration": duration, "transcript": transcript, "speakers": speakers,
            "spend": ledger.snapshot()}


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
    file will have), not by the labelled span. The neutral segments stay in
    recording order; any borrowed ones are APPENDED after them (borrow order,
    then recording order within an emotion), so the stem is not one continuous
    timeline — deliberate, because it keeps the genuinely-neutral audio first
    and contiguous.
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


# ── measured fidelity: the pipeline hears its own audio ───────────────────────
# Until now this pipeline was BLIND. It cut a recording into segments, trusted a
# classifier's emotion labels and a diarizer's (or, in sovereign mode, an
# assumption's) speaker attribution, spliced the result, cloned it, and verified
# exactly one thing: that the embedding file parsed. Whether the stems were even
# the same person — let alone whether the clone resembled them — was unmeasured,
# and therefore unmentioned.
#
# `service/voiceprint.py` closes that. Every segment gets a speaker embedding,
# the speaker's own centre of mass is the reference, and a segment sitting far
# from it is a diarization error or a bystander voice. That is REPORTED always
# and acted on rarely, for a reason worth writing down: the numbers below are NOT
# calibrated against a fixture set (that is a later step in the proposal), so the
# statistical rule does the deciding and the absolute constants only guard the
# one case a rule cannot see — a segment that is not this person at all.
#
#   * OUTLIER_MAD_K — flag at K median-absolute-deviations below the median
#     similarity. Self-calibrating per recording: there is no fixed "good"
#     similarity to be wrong about, only "unlike the rest of this speaker".
#   * FOREIGN_SIMILARITY — an absolute floor, and the ONLY thing that removes
#     audio. Deliberately far below anything a real speaker's own clip reaches.
#   * MAX_DROP_FRACTION — a recording is never mostly-foreign; if the rule says
#     it is, the rule is wrong, so the surplus is flagged rather than dropped.
# Nothing here can empty a stem: the last audio for an emotion is always kept
# (flagged), and a drop set that would leave no usable segments at all is
# abandoned wholesale. Every one of those outcomes is named in the payload.
FIDELITY_VERSION = 1
OUTLIER_MAD_K = 3.0
OUTLIER_MIN_SEGMENTS = 4      # below this, "unlike the rest" has no rest to mean
FOREIGN_SIMILARITY = 0.25
MAX_DROP_FRACTION = 0.34
# One fixed line, so a clone's identity number is comparable with the next
# clone's. Phonetically broad, short enough that synthesizing it costs seconds.
CALIBRATION_TEXT = ("The quick brown fox jumps over the lazy dog, and she "
                    "reads the whole page out loud before breakfast.")
CALIBRATION_TIMEOUT_S = 120.0

_IDENTITY_CAVEAT = ("speaker identity (embedding cosine similarity), "
                    "not perceptual quality")


class SegmentFidelity(NamedTuple):
    """What embedding the segments taught us. `payload` is JSON-safe and rides
    in the job's partial/result; `dropped` is the set of segment indices whose
    audio must not reach a stem; `centre` is the speaker's centroid (None when
    nothing could be measured)."""
    payload: dict
    dropped: set
    centre: object | None


def _unmeasured(reason: str) -> dict:
    """A fidelity payload for "we did not measure this, and here is why".

    Never an empty dict and never zeros: absent has to be distinguishable from
    measured-badly, on the wire and in the UI.
    """
    return {"version": FIDELITY_VERSION, "available": False, "reason": reason,
            "reference_similarity": None, "segments_measured": 0,
            "segments_failed": [], "per_segment_outliers": [],
            "dropped": 0, "flagged": 0, "stems": {},
            "measures": _IDENTITY_CAVEAT}


def measure_segments(labels: list[dict], *,
                     embed: Callable[[Path], object] | None = None) -> SegmentFidelity:
    """Embed every usable segment and judge it against the speaker's centroid.

    Pure measurement plus a decision about which indices to exclude — no I/O
    beyond reading the segment wavs, so it is testable with synthetic embeddings.
    `embed` defaults to `voiceprint.embed`; when the embedder is unavailable this
    returns a payload that SAYS so and drops nothing.
    """
    if embed is None:
        reason = voiceprint.unavailable_reason()
        if reason:
            return SegmentFidelity(_unmeasured(reason), set(), None)
        embed = voiceprint.embed

    vectors: dict[int, object] = {}
    failed: list[dict] = []
    for lab in labels:
        try:
            vectors[lab["i"]] = embed(Path(lab["wav"]))
        except Exception as exc:  # noqa: BLE001 - one unmeasurable clip is not a failure
            failed.append({"i": lab["i"], "error": f"{type(exc).__name__}: {exc}"[:160]})

    if len(vectors) < 2:
        pay = _unmeasured(
            f"only {len(vectors)} of {len(labels)} segment(s) could be embedded, "
            "which is too few to locate this speaker")
        pay["segments_failed"] = failed
        return SegmentFidelity(pay, set(), None)

    try:
        centre = voiceprint.centroid(list(vectors.values()))
        sims = {i: voiceprint.similarity(v, centre) for i, v in vectors.items()}
    except Exception as exc:  # noqa: BLE001 - measurement must never fail a scan
        pay = _unmeasured(f"the speaker centroid could not be computed ({exc})")
        pay["segments_failed"] = failed
        return SegmentFidelity(pay, set(), None)

    ordered = sorted(sims.values())
    median = float(np.median(ordered))
    mad = float(np.median([abs(s - median) for s in ordered]))
    by_index = {lab["i"]: lab for lab in labels}

    # Candidates: statistically unlike the rest of this speaker, or below the
    # absolute floor regardless of how spread out the recording is.
    cut = median - OUTLIER_MAD_K * mad
    candidates = []
    for i, sim in sims.items():
        stat = (len(sims) >= OUTLIER_MIN_SEGMENTS and mad > 0.0 and sim < cut)
        if stat or sim < FOREIGN_SIMILARITY:
            candidates.append(i)
    candidates.sort(key=lambda i: sims[i])       # least like the speaker first

    drop_budget = int(len(sims) * MAX_DROP_FRACTION)
    per_emotion: dict[str, int] = {}
    for lab in labels:
        per_emotion[lab["emotion"]] = per_emotion.get(lab["emotion"], 0) + 1

    dropped: set = set()
    outliers: list[dict] = []
    for i in candidates:
        lab = by_index.get(i, {})
        emo = lab.get("emotion", BASELINE)
        sim = round(sims[i], 3)
        why: str | None = None
        action = "flagged"
        if sims[i] < FOREIGN_SIMILARITY:
            if len(dropped) >= drop_budget:
                why = ("kept: more segments look foreign than a recording of one "
                       "person plausibly can, so the measurement is not trusted")
            elif per_emotion.get(emo, 0) - _dropped_for(dropped, by_index, emo) <= 1:
                why = f"kept: the only remaining audio labelled '{emo}'"
            else:
                action = "dropped"
                why = ("removed from the stems: this does not sound like the same "
                       "speaker (another voice, or a mis-attributed span)")
                dropped.add(i)
        else:
            why = ("unlike the rest of this speaker's audio — reported only, still "
                   "used in the stems")
        outliers.append({"i": i, "emotion": emo, "similarity": sim,
                         "action": action, "why": why})

    if dropped and len(dropped) >= len(sims):     # belt: never strip everything
        for o in outliers:
            if o["action"] == "dropped":
                o["action"] = "flagged"
                o["why"] = ("kept: dropping these would leave no usable audio at "
                            "all")
        dropped = set()

    payload = {
        "version": FIDELITY_VERSION, "available": True, "reason": None,
        # Contract name (cloning-ingest.md M1 step 1). What it actually is: the
        # MEDIAN similarity of this recording's segments to the speaker's own
        # centroid — how much this audio agrees with itself about who is talking.
        "reference_similarity": round(median, 3),
        "cohesion_mad": round(mad, 3),
        "segments_measured": len(sims),
        "segments_failed": failed,
        "per_segment_outliers": outliers,
        "dropped": len(dropped),
        "flagged": sum(1 for o in outliers if o["action"] == "flagged"),
        "stems": {},
        "measures": _IDENTITY_CAVEAT,
    }
    return SegmentFidelity(payload, dropped, centre)


def _dropped_for(dropped: set, by_index: dict, emotion: str) -> int:
    return sum(1 for i in dropped if by_index.get(i, {}).get("emotion") == emotion)


def score_stems(payload: dict, centre: object | None, stem_paths: dict[str, Path],
                *, embed: Callable[[Path], object] | None = None) -> None:
    """Fill `payload["stems"][emotion] = {"identity": …}` — how much each spliced
    stem sounds like the speaker it was cut from. Mutates `payload`; failures are
    named per stem instead of removing the key (a missing number and an
    unmeasurable one are different facts)."""
    if centre is None or not payload.get("available"):
        return
    fn = embed or voiceprint.embed
    for emo, path in stem_paths.items():
        try:
            payload["stems"][emo] = {
                "identity": round(voiceprint.similarity(fn(Path(path)), centre), 3)}
        except Exception as exc:  # noqa: BLE001
            payload["stems"][emo] = {
                "identity": None,
                "reason": f"{type(exc).__name__}: {exc}"[:160]}


# ── closing the loop: score the CLONE, not just its inputs ────────────────────
def _engine_synthesize(voice_id: str, text: str) -> bytes:
    """Synthesize one line through an already-running engine, if there is one.

    Deliberately NOT an import of `service.app`: ingest is imported BY the app
    (via ingest_api), so importing it back would be a cycle, and a CLI ingest run
    has no engine at all. Looking the module up in `sys.modules` asks exactly the
    right question — "is a loaded engine already in this process?" — and answers
    "no" cheaply everywhere else. A caller with its own synthesizer passes
    `synthesize=` to `commit` instead.
    """
    app = sys.modules.get("service.app")
    engine = getattr(app, "ENGINE", None) if app is not None else None
    if engine is None or not getattr(engine, "ready", lambda: False)():
        raise RuntimeError("no synthesis engine is running in this process")
    job = engine.submit(voice_id, text)
    return job.future.result(timeout=CALIBRATION_TIMEOUT_S).wav_bytes


def calibrate_clone(voice_id: str, reference_wav: Path, work_dir: Path,
                    synthesize: Callable[[str, str], bytes] | None = None,
                    *, embed: Callable[[Path], object] | None = None
                    ) -> tuple[float | None, str | None]:
    """Score a freshly exported clone against the audio it was cloned from.

    Synthesizes ONE fixed calibration line through the new embedding and compares
    its speaker embedding with the reference stem's: the first time this pipeline
    ever hears its own output. Returns `(identity, reason)` — exactly one of the
    two is None, so a caller can always say either the number or why there isn't
    one. Never raises: a clone is not failed over a measurement (and see
    voiceprint.py on why synthetic speech makes this advisory evidence).
    """
    if embed is None:
        reason = voiceprint.unavailable_reason()
        if reason:
            return None, reason
        embed = voiceprint.embed
    try:
        wav = (synthesize or _engine_synthesize)(voice_id, CALIBRATION_TEXT)
    except Exception as exc:  # noqa: BLE001
        return None, f"calibration line was not synthesized: {exc}"[:200]
    try:
        out = work_dir / f"calib_{voice_id}.wav"
        out.write_bytes(wav)
        return round(voiceprint.similarity(embed(out), embed(Path(reference_wav))), 3), None
    except Exception as exc:  # noqa: BLE001
        return None, f"calibration line was not scored: {type(exc).__name__}: {exc}"[:200]


def _stamp_fidelity(entry: dict, reference_wav: Path, identity: float) -> None:
    """Put a measured identity on a registry row, in the C1 fidelity shape.

    `service/voices.py` OWNS that schema (batch-1 design C1): `measure_fidelity`
    computes the signal-only half — speech seconds, clip ratio, noise floor,
    flags — from the audio and merges an identity the caller supplies. It is
    reached through the loaded module rather than imported, so a rename there
    degrades this to "identity only" instead of breaking ingest's import; the
    identity is never lost either way. What this will NOT write is a row of
    Nones, because `fidelity: null` has to keep meaning "not measured".
    """
    module = sys.modules.get("service.voices")
    builder = next((fn for fn in (getattr(module, "measure_fidelity", None),
                                  getattr(module, "build_fidelity", None))
                    if callable(fn)), None)
    if builder is not None:
        try:
            try:
                obj = builder(Path(reference_wav), identity=identity)
            except TypeError:      # the seam exists but not (yet) that keyword
                obj = builder(Path(reference_wav))
                if isinstance(obj, dict):
                    obj["identity"] = identity
            if isinstance(obj, dict) and obj:
                entry["fidelity"] = obj
                return
        except Exception as exc:  # noqa: BLE001 - advisory, never fail a clone
            _log(f"commit: voices fidelity measurement failed, storing identity "
                 f"only: {exc}")
    entry["fidelity"] = {
        "version": FIDELITY_VERSION,
        "measured_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "identity": identity, "speech_seconds": None, "clip_ratio": None,
        "noise_floor_db": None, "flags": [], "measures": _IDENTITY_CAVEAT}


# ── LABEL + STEM for a chosen speaker ─────────────────────────────────────────
def label_and_stem(work_dir: Path, target: str, min_stem: float = MIN_STEM_SECONDS, limit: int = 40,
                   progress: Callable[[str, str], None] | None = None,
                   partial: Callable[[dict], None] | None = None,
                   mode: str = "cloud",
                   should_cancel: Callable[[], bool] | None = None,
                   spend: "Spend | None" = None) -> dict:
    """Classify each segment of `target`, then splice one stem per emotion.

    `should_cancel` is polled on entry, by every pooled task before it does any
    work, and once the pool drains — so a cancel stops the labelling fan-out
    (up to `limit` ffmpeg extracts and paid classifier calls) within one
    in-flight segment per worker instead of running the batch to completion
    against a workdir that has already been torn down."""
    def prog(k: str, s: str) -> None:
        if progress:
            progress(k, s)

    _check(should_cancel)
    all_segs = json.loads((work_dir / "segments.json").read_text("utf-8"))
    tsegs = [s for s in all_segs if s["speaker"] == target]
    clean = work_dir / "clean.wav"

    prog("label", "active")
    todo = tsegs[:limit]
    ledger = spend or Spend()
    # Segments are extracted and classified in BATCHES on a bounded pool: each
    # task extracts its own clips (ffmpeg, local, one process per clip) and then
    # classifies them in ONE request. Results are written back BY INDEX so the
    # order is identical to serial labelling.
    results: list[dict | None] = [None] * len(todo)
    counts: dict[str, int] = {}
    state = {"done": 0, "errors": 0, "extract_errors": 0, "classify_errors": 0}
    prog_lock = threading.Lock()

    def _settle(i: int, s: dict, lab: dict | None, failure: str | None) -> None:
        """Record ONE segment's outcome. `failure` names WHY it degraded —
        "extract" (ffmpeg could not decode this span) and "classify" (the
        classifier failed or said nothing about this clip) used to be collapsed
        into the same silent fallback to baseline, which is how a provider
        outage looked exactly like a quiet recording."""
        if lab is None:
            lab = {"emotion": BASELINE, "confidence": 0.0, "cue": "", "model": "error"}
        seg_wav = work_dir / f"seg_{i:03d}.wav"
        lab.update({"i": i, "dur": round(s["end"] - s["start"], 2),
                    "text": s["text"][:60], "wav": str(seg_wav),
                    "failure": failure,
                    # An unlabelled segment is UNUSED, not baseline audio: we do
                    # not know its emotion, and guessing "neutral" would quietly
                    # pollute the one stem that must stay pure.
                    "ok": failure is None and seg_wav.is_file()})
        with prog_lock:
            results[i] = lab
            counts[lab["emotion"]] = counts.get(lab["emotion"], 0) + 1
            state["done"] += 1
            if failure:
                state["errors"] += 1
                state[f"{failure}_errors"] += 1
            if partial:
                partial({"segments_total": len(todo), "segments_done": state["done"],
                         "emotion_counts": dict(counts), "label_errors": state["errors"],
                         "extract_errors": state["extract_errors"],
                         "classify_errors": state["classify_errors"],
                         "spend": ledger.snapshot()})

    def _label_batch(idxs: list[int]) -> None:
        """Extract then classify one batch. A cancelled job skips it entirely —
        queued tasks drain instantly instead of spending on a job nobody is
        waiting for, and none of them writes into the deleted workdir."""
        if should_cancel and should_cancel():
            return
        ready: list[int] = []
        for i in idxs:
            s = todo[i]
            try:
                to_wav(clean, work_dir / f"seg_{i:03d}.wav", s["start"], s["end"])
            except Exception:  # noqa: BLE001 - one clip must not fail the batch
                _settle(i, s, None, "extract")
                continue
            ready.append(i)
        if not ready:
            return
        if mode == "sovereign":
            # No cloud classifier: everything is baseline. Emotions get added
            # afterwards via the studio's guided per-emotion recorder.
            for i in ready:
                _settle(i, todo[i], {"emotion": BASELINE, "confidence": 1.0,
                                     "cue": "", "model": "local"}, None)
            return
        if should_cancel and should_cancel():
            return
        try:
            labs = label_emotions([work_dir / f"seg_{i:03d}.wav" for i in ready], ledger)
        except Exception as exc:  # noqa: BLE001 - one batch must not fail the job
            _log(f"label: batch of {len(ready)} failed: {exc}")
            labs = [None] * len(ready)
        for pos, i in enumerate(ready):
            lab = labs[pos] if pos < len(labs) else None
            _settle(i, todo[i], lab, None if lab else "classify")

    if todo:
        groups = _batches(len(todo))
        with ThreadPoolExecutor(max_workers=min(LABEL_WORKERS, len(groups))) as pool:
            for fut in [pool.submit(_label_batch, g) for g in groups]:
                fut.result()  # re-raise only truly unexpected errors (not per-seg)
    _check(should_cancel)   # a cancelled batch is abandoned, never spliced
    labelled = [r for r in results if r is not None]
    prog("label", "done")

    prog("stem", "active")
    # Only segments whose wav was actually written can feed a stem; a segment
    # that failed extraction is still labelled/counted but contributes no audio.
    usable = [l for l in labelled if l.get("ok")]
    if todo and not usable:
        # Every segment failed. Splicing nothing raises "no speech detected in
        # the clip" — which would be a LIE when the truth is that the classifier
        # was unreachable or the audio would not decode. Say which.
        raise UserFacing(
            f"none of the {len(todo)} speech segments could be prepared — "
            f"{state['extract_errors']} could not be decoded and "
            f"{state['classify_errors']} could not be classified. "
            "If this keeps happening the emotion classifier may be unavailable; "
            "try again in a few minutes.")
    # MEASURE the segments before anything is spliced: a bystander voice or a
    # mis-attributed span is cheap to exclude here and impossible to remove once
    # it is inside a stem. Wrapped whole — a scan is never failed over a
    # measurement, it is only ever made less informative (and says so).
    _check(should_cancel)
    try:
        fidelity, dropped, centre = measure_segments(usable)
    except Exception as exc:  # noqa: BLE001
        fidelity, dropped, centre = _unmeasured(
            f"speaker measurement failed: {type(exc).__name__}: {exc}"[:200]), set(), None
    if dropped:
        _log(f"label: {len(dropped)} segment(s) removed from the stems — they do "
             "not sound like the target speaker")
        usable = [l for l in usable if l["i"] not in dropped]
    if partial:
        partial({"fidelity": fidelity})

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

    # The stems exist now, so each one can be scored as a whole — the number the
    # review screen shows per stem. Splicing can lower it (level matching, the
    # borrowed baseline top-up), which is exactly why it is measured AFTER.
    try:
        score_stems(fidelity, centre,
                    {s["emotion"]: work_dir / f"stem_{s['emotion']}.wav" for s in stems})
    except Exception as exc:  # noqa: BLE001
        _log(f"stem: fidelity scoring skipped: {exc}")
    _outlier_by_index = {o["i"]: o["action"]
                         for o in fidelity.get("per_segment_outliers", [])}
    for s in stems:
        scored = fidelity.get("stems", {}).get(s["emotion"]) or {}
        # Absent = absent: a stem that could not be scored carries no key at all,
        # so the UI has nothing to render rather than a zero to misread.
        if scored.get("identity") is not None:
            s["identity"] = scored["identity"]
    prog("stem", "done")

    return {"target": target, "utterances": len(tsegs), "min_stem": min_stem, "stems": stems,
            "fidelity": fidelity, "spend": ledger.snapshot(),
            # `outlier` rides here (not only in fidelity.per_segment_outliers) so
            # the review list can mark a segment where the user is already
            # looking: "dropped" = its audio is not in any stem, "flagged" = it
            # is, and it looked unlike the rest. Absent = nothing measured about
            # it, which must render as nothing at all.
            #
            # `i` and `ok` ride here for the Casting Board: every consumer of
            # this list (recipes, the corpus, the segment endpoints) had to
            # re-derive the index by POSITION and re-derive usability from
            # `failure` + a stat() of the wav. Publishing both makes the join
            # the pipeline already knows explicit rather than reconstructed.
            # Position stays the contract (`i` equals it here, and the readers
            # still verify the join against each segment's labelled duration).
            "segments": [{"i": l["i"], "emotion": l["emotion"],
                          "confidence": l["confidence"], "cue": l["cue"],
                          "dur": l["dur"], "text": l["text"], "model": l["model"],
                          "failure": l.get("failure"), "ok": bool(l.get("ok")),
                          "outlier": _outlier_by_index.get(l["i"]),
                          "escalation": l.get("escalation")} for l in labelled]}


def have_cloud_keys() -> bool:
    """Both cloud providers are configured. Whitespace-only values are NOT keys —
    a `.env` line like `GEMINI_API_KEY= ` used to auto-select cloud mode and then
    fail inside analyze() with an assertion the user could not act on."""
    return bool(ELEVEN_KEY.strip() and GEMINI_KEY.strip())


def resolve_mode(mode: str = "auto") -> str:
    """auto → cloud when both API keys exist, else sovereign (local-only).

    An EXPLICIT mode is always honoured, including "cloud" without keys: the
    caller asked for it by name, and analyze() is where that is refused. Only
    "auto" is a decision this function makes.
    """
    if mode in ("cloud", "sovereign"):
        return mode
    return "cloud" if have_cloud_keys() else "sovereign"


# ── one-shot scan (CLI convenience: analyze → auto speaker → label) ────────────
def scan(audio: Path, work_dir: Path, speaker: str = "auto", min_stem: float = MIN_STEM_SECONDS,
         limit: int = 40, progress: Callable[[str, str], None] | None = None,
         mode: str = "auto") -> dict:
    mode = resolve_mode(mode)
    ledger = Spend()   # ONE budget for the whole one-shot run, both phases
    if mode == "sovereign":
        a = sovereign_analyze(audio, work_dir, progress)
    else:
        a = analyze(audio, work_dir, progress, spend=ledger)
    if not a["speakers"]:
        raise RuntimeError("no speech detected in the clip")
    target = a["speakers"][0]["id"] if speaker == "auto" else speaker
    r = label_and_stem(work_dir, target, min_stem, limit, progress, mode=mode, spend=ledger)
    return {"duration": a["duration"], "speakers": [s["id"] for s in a["speakers"]],
            "mode": mode, **r}


# ── COMMIT (clone selected stems) ─────────────────────────────────────────────
def commit(work_dir: Path, character: str, emotions: list[str], existing_cid: str | None = None,
           *, consent: str | None = None, clip_sha256: str | None = None,
           progress: Callable[[int, str | None], None] | None = None,
           should_cancel: Callable[[], bool] | None = None,
           on_voice: Callable[[dict], None] | None = None,
           allow_short: bool = False,
           synthesize: Callable[[str, str], bytes] | None = None,
           replace: bool = False, source: str = "ingest",
           derived_from: dict | None = None) -> list[dict]:
    """Clone each accepted stem into a Voice.

    Cloning runs in ONE child process (`python -m service.export_stems`) that
    loads the Pocket TTS model a single time and exports every stem in a loop —
    instead of one `pocket_tts export-voice` subprocess (one cold ~15s CPU model
    load) per emotion. The child streams a JSON status line per finished stem on
    stdout; we parse them to drive `progress(done, current)` and to poll
    `should_cancel()` between emotions (a cancel terminates the child after the
    current line). When `consent` (the attestation statement) is given, a consent
    receipt is stamped into each created Voice's metadata.

    `on_voice` is called with each entry the MOMENT it is registered, before the
    next stem is cloned. The return value only exists on the success path, so a
    caller that must undo a half-finished clone (ingest_api's rollback) cannot
    learn from it what an EXCEPTION left behind — registration happens per stem
    via `mutate_meta`, so a raise mid-batch leaves live Voices the return value
    never mentions. This callback is that caller's ledger.

    CLOSING THE LOOP: when speaker measurement is available, each exported clone
    is heard back — one fixed calibration line synthesized through the new
    embedding, scored against the stem it was cloned from — and the resulting
    identity is stamped on the Voice's registry row (design C1). `synthesize` is
    that seam: `(voice_id, text) -> wav bytes`. Left None it asks whether a loaded
    engine happens to be in this process and, if not, reports a named skip; the
    identity is then absent, never zero. NOTHING here can fail a clone: the whole
    measurement is advisory, and the reason for every skip travels back to the
    caller on the per-voice dict.

    RE-DERIVATION: `replace=True` (internal callers only; never a field on an
    HTTP request) makes a held (character_id, emotion) slot an UPGRADE instead of
    a skip — the new stem is exported, the old embedding is unlinked and its row
    dropped, and the new row takes the slot. The unlink happens FIRST, under the
    registry lock, exactly as `voices._unlink_then_forget` does it: a file that
    refuses to delete keeps its row and this emotion is treated as lost, because
    a .safetensors with no row is a phantom Character. `derived_from` is the
    provenance stamped on such a row (corpus revision, splice DSP version, model
    version) and `source` names what made it. Both are inert on the normal path.

    Eligibility: a stem shorter than MIN_STEM_SECONDS clones poorly, so it is
    SKIPPED (never cloned) and reported — the whole commit does not fail. Pass
    `allow_short=True` (internal callers only; never exposed over HTTP) to clone
    short stems anyway. The returned list contains only the Voices actually
    created; skipped emotions are simply absent from it (and logged)."""
    cid = existing_cid or _slug(character)
    if existing_cid is None:
        # The same boundary check create_voice and import_pack make, made here
        # for the third creation path: a name that slugs onto a built-in id is
        # refused BEFORE the model is loaded, so ingest cannot mint the collided
        # Character that _build_characters then has to log its way around.
        reject_builtin_collision(cid, character.strip() or cid)
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
        held = slot_holder(meta, cid, emo)
        if held is not None and not replace:
            # (character_id, emotion) is the registry's real key: a second row
            # for a slot is a Voice the roster shows and synthesis can never
            # reach. An EXTEND of a character that already covers this emotion
            # is therefore skipped and reported — the same treatment a too-short
            # stem gets — rather than failing the whole commit or (as before)
            # cloning a duplicate that only the logs would ever mention.
            skipped.append({"emotion": emo, "held_by": held})
            _log(f"commit: skipping '{emo}' — '{cid}' already has a voice for it ({held})")
            continue
        voice_id = f"{cid}-{emo}-{uuid.uuid4().hex[:6]}"
        plan.append({"emotion": emo, "src": str(sw), "seconds": seconds,
                     "voice_id": voice_id, "replaces": held if replace else None,
                     # asserts the resolved destination is inside VOICES_DIR
                     "dst": str(voice_file_path(voice_id, VOICES_DIR))})

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

    # Asked ONCE, before the model is loaded: if identity cannot be measured
    # there is no point synthesizing a calibration line to measure it with, so an
    # un-equipped box pays nothing for this feature and still gets told why.
    fidelity_reason = voiceprint.unavailable_reason()
    if fidelity_reason:
        _log(f"commit: clone identity will not be measured — {fidelity_reason}")

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
        # The embedding is written and loadable-back; hear it before registering
        # it, so the row lands carrying its own measured fact.
        identity, identity_reason = None, fidelity_reason
        if fidelity_reason is None:
            identity, identity_reason = calibrate_clone(
                p["voice_id"], Path(p["src"]), work_dir, synthesize)
            _log(f"commit: '{emo}' identity "
                 + (f"{identity:.3f}" if identity is not None
                    else f"not measured — {identity_reason}"))

        entry = {
            "name": name, "character_id": cid, "emotion": emo,
            "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "sample_seconds": p["seconds"], "lang": "EN", "source": source}
        if identity is not None:
            _stamp_fidelity(entry, Path(p["src"]), identity)
        # INTO THE MEASURED SPACE, through voices.py's own helper — the same
        # call `create_voice` makes, deliberately not a second implementation.
        # Without it a studio-committed Character has no `prosody` on any row,
        # `voices.prosody_map` returns {} for it, and every
        # `resolve(..., prosody=prosody_map(cid))` in app.py silently falls back
        # to the static prior chain — for the PRIMARY creation path on this box.
        # The stem is on disk right here (it is what the child just cloned), so
        # this is local numpy over audio we already have: no network, no model.
        # Called before `_add` registers the row, so the check compares this
        # take against the Character's other slots rather than against itself.
        label_check = stamp_measured(entry, Path(p["src"]), emo, cid)
        if derived_from is not None:
            # Provenance for a Voice this box REBUILT rather than recorded: what
            # corpus revision, splice DSP and model produced it. When any of the
            # three moves, this row is what says the voice can be improved.
            entry["derived_from"] = dict(derived_from)
        if consent is not None:
            entry["consent"] = {
                "consented_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "clip_sha256": clip_sha256, "statement": consent}

        def _add(meta, entry=entry, vid=p["voice_id"], emo=emo):
            # Re-checked UNDER the registry lock, like create_voice's commit:
            # cloning takes seconds per stem, so a concurrent clone (or a second
            # ingest of the same character) can take the slot after the plan was
            # built. Returning the holder instead of raising keeps the Voices
            # this commit already registered — a raise here skips the save.
            held = slot_holder(meta, cid, emo, exclude=vid)
            if held is not None:
                if not replace:
                    return held
                # UPGRADE this slot: file first, row second (voices.py's rule).
                try:
                    Path(voice_file_path(held, VOICES_DIR)).unlink(missing_ok=True)
                except (OSError, ValueError) as exc:
                    _log(f"commit: '{emo}' could not replace {held} "
                         f"(its embedding would not delete: {exc})")
                    return held
                meta["voices"].pop(held, None)
            meta["voices"][vid] = entry
            meta["characters"].setdefault(cid, {"name": name, "tags": ["ingested"]})
            return None
        lost_to = mutate_meta(_add)
        if lost_to is not None:
            # Unregistered, so the embedding must go too: the roster is
            # glob-driven, and a .safetensors with no row is a phantom
            # Character slugged out of the voice id.
            _log(f"commit: '{emo}' slot was taken by {lost_to} mid-commit — discarding {p['voice_id']}")
            Path(p["dst"]).unlink(missing_ok=True)
            done += 1
            if progress:
                progress(done, None)
                if done < len(plan):
                    progress(done, plan[done]["emotion"])
            continue
        made = {"voice_id": p["voice_id"], "emotion": emo, "seconds": p["seconds"]}
        if label_check is not None:
            # Reported, never stored — the same split `create_voice` makes. The
            # probe is a durable fact about the audio; the check is a comparison
            # against the roster AT THIS MOMENT, and a stored one would go stale
            # the next time the Character gained a slot.
            made["label_check"] = label_check
        if p.get("replaces"):
            made["replaced"] = p["replaces"]
        if identity is not None:
            made["identity"] = identity
        elif identity_reason:
            # Named, not silent: the studio can say "identity was not measured
            # because …" instead of showing an empty slot the user must guess at.
            made["identity_reason"] = identity_reason
        created.append(made)
        if on_voice:
            on_voice(made)
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


# ── THE VOICE CORPUS: ingest stops being disposable ───────────────────────────
# Everything above this line is thrown away. `_gc_once` rmtree's the workdir
# thirty minutes after a scan, and the only survivor of a commit is an opaque
# .safetensors nobody can regenerate or explain — so every quality gain is a
# future-only gain, and a user who records a second time gets a second unrelated
# clone attempt rather than a better voice.
#
# The corpus inverts that: on a successful commit the job's DURABLE FACTS are
# COPIED (never moved — GC still owns the workdir) into
# `SETTINGS.corpus_dir/<character_id>/`, keyed by the clip's sha256. Re-ingesting
# the same recording is therefore a no-op, and a later `rederive` can rebuild the
# stems from every take of that person at once.
#
# What makes retention defensible, and what none of this is allowed to skip:
#   * OPT-IN. Nothing is written unless the caller asked (`corpus: true`).
#   * CONSENT. Capture needs the same ownership attestation the clone needed,
#     and the receipt is stored beside the audio (never re-derived, never
#     assumed). No statement, no capture — named, not silent.
#   * VISIBLE. `corpus_view` itemizes every clip, segment, second and emotion.
#   * DELETABLE. `delete_clip` removes every segment and stem derived from one
#     recording and REPORTS what went, which is the whole retention story.
#   * BOUNDED. A hard byte cap with a named pruning order (see
#     `Settings.corpus_max_bytes`).
#   * VERSIONED. `corpus.json` carries a schema; a corpus written by a newer
#     version is refused rather than half-read, because re-derive must never
#     silently mean something different than it did when the audio was stored.
CORPUS_SCHEMA = 1
# The splice DSP this corpus's stems were built with (see the `stem splicing`
# section: level matching, raised-cosine fades, the silent gap). It is stamped
# into `derived_from` so a voice can say WHICH version of the splice made it and
# a future improvement can be recognised as a reason to re-derive.
DSP_VERSION = 1
CORPUS_INDEX = "corpus.json"
_CORPUS_LOCK = "corpus.lock"
_CORPUS_SEGMENTS = "segments"
_CORPUS_STEMS = "stems"
# Same tolerance ingest_api's recipe join uses: a labelled span and its
# extracted wav are the same audio, so a mismatch means the positional join is
# wrong and the capture must be abandoned rather than store misattributed audio.
_CORPUS_DUR_TOLERANCE = 0.35


def model_version() -> str:
    """What synthesizer a corpus-derived voice was exported with.

    pocket-tts exposes no version constant, so this asks the package metadata
    and, failing that, says so and names the export CONFIGURATION instead of
    inventing a number — an unknown version has to be readable as unknown.
    """
    try:
        from importlib.metadata import version
        return f"pocket-tts {version('pocket-tts')}"
    except Exception:  # noqa: BLE001 - absent metadata is not a failure
        return (f"pocket-tts (version not reported); language={SETTINGS.language}, "
                f"quantize={SETTINGS.quantize}")


def corpus_root() -> Path:
    """Read from SETTINGS at call time, so a test (or a re-pointed deployment)
    can move the corpus without re-importing this module."""
    return Path(SETTINGS.corpus_dir)


def corpus_dir(character_id: str) -> Path:
    """This character's corpus directory, with the id PROVEN to be a slug.

    The id reaches a filesystem path, so it is validated the way every other
    write path in this service validates one: rejected, never sanitised.
    """
    cid = (character_id or "").strip()
    if not cid or cid != _slug(cid):
        raise UserFacing("that is not a valid character id")
    return corpus_root() / cid


def _clip_dir(character_id: str, clip_sha: str) -> Path:
    sha = (clip_sha or "").strip().lower()
    if len(sha) < 8 or any(c not in "0123456789abcdef" for c in sha):
        raise UserFacing("that is not a valid clip hash")
    return corpus_dir(character_id) / sha


def _empty_index(character_id: str) -> dict:
    return {"schema": CORPUS_SCHEMA, "character_id": character_id,
            "rev": 0, "updated": None, "clips": []}


def load_corpus(character_id: str) -> dict:
    """This character's corpus index, or an empty one. Never invents data.

    A corpus written by a NEWER schema is refused: re-derivation reads segment
    selection rules out of this file, and half-understanding a future layout is
    how a "rebuild" quietly becomes a different voice.
    """
    path = corpus_dir(character_id) / CORPUS_INDEX
    if not path.is_file():
        return _empty_index(character_id)
    try:
        idx = json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise UserFacing(
            "this character's corpus index could not be read, so nothing about "
            "the stored audio can be shown or rebuilt from it "
            f"({type(exc).__name__})")
    if not isinstance(idx, dict) or not isinstance(idx.get("clips"), list):
        raise UserFacing("this character's corpus index is not in a shape this "
                         "version understands")
    schema = int(idx.get("schema") or 0)
    if schema > CORPUS_SCHEMA:
        raise UserFacing(
            f"this corpus was written by a newer version of Gravitone (index "
            f"schema {schema}, this build understands {CORPUS_SCHEMA}) — "
            "upgrade before reading or rebuilding from it")
    idx.setdefault("character_id", character_id)
    idx.setdefault("rev", 0)
    idx.setdefault("updated", None)
    return idx


def _save_corpus(character_id: str, idx: dict) -> dict:
    """Persist the index and bump its revision.

    `rev` is what `derived_from` points at, so it moves on EVERY mutation —
    capture, deletion and pruning alike — and a voice can always say which state
    of the corpus produced it.
    """
    d = corpus_dir(character_id)
    d.mkdir(parents=True, exist_ok=True)
    idx["schema"] = CORPUS_SCHEMA
    idx["character_id"] = character_id
    idx["rev"] = int(idx.get("rev") or 0) + 1
    idx["updated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    atomic_write_text(d / CORPUS_INDEX, json.dumps(idx, indent=2))
    return idx


def _corpus_lock(character_id: str):
    """Cross-PROCESS exclusion around a corpus read-modify-write. The service
    runs as N replica processes (replicas.py) and two concurrent captures for
    one character would otherwise each load the index, add a clip and save —
    losing one, exactly as the voice registry would without `mutate_meta`."""
    d = corpus_dir(character_id)
    d.mkdir(parents=True, exist_ok=True)
    return file_lock(d / _CORPUS_LOCK)


def _dir_bytes(path: Path) -> int:
    total = 0
    if not path.is_dir():
        return 0
    for p in path.rglob("*"):
        try:
            if p.is_file():
                total += p.stat().st_size
        except OSError:
            continue
    return total


def corpus_bytes(idx: dict) -> int:
    return sum(int(c.get("bytes") or 0) for c in idx.get("clips", []))


def _corpus_rows(work_dir: Path, result: dict) -> tuple[list[dict], str | None]:
    """The scan's per-segment labels re-joined to the wavs on disk.

    `label_and_stem` publishes segments in index order but not their index or
    path, so the join is positional — and a positional join that is wrong stores
    audio under the wrong label FOREVER, which is worse here than in a recipe.
    It is therefore verified against the labelled duration, and a mismatch
    abandons the capture with a named reason.
    """
    segs = result.get("segments")
    if not isinstance(segs, list) or not segs:
        return [], "this scan published no per-segment labels"
    rows: list[dict] = []
    for i, s in enumerate(segs):
        wav = work_dir / f"seg_{i:03d}.wav"
        seconds = 0.0
        if wav.is_file():
            try:
                seconds = round(_wav_seconds(wav), 2)
            except Exception:  # noqa: BLE001 - an unreadable wav is simply not copied
                seconds = 0.0
        declared = float(s.get("dur") or 0.0)
        if seconds and declared and abs(seconds - declared) > _CORPUS_DUR_TOLERANCE:
            return [], "segment audio could not be matched to its labels"
        # A segment the pipeline could not prepare, or measured as NOT this
        # speaker, contributed no audio to any stem — so its audio is not stored
        # either. The label still is: "we heard this and rejected it, for this
        # reason" is precisely the fact a corpus exists to keep.
        used = (wav.is_file() and not s.get("failure")
                and s.get("outlier") != "dropped" and seconds > 0)
        rows.append({"i": i, "src": wav if used else None,
                     "emotion": s.get("emotion"),
                     "confidence": float(s.get("confidence") or 0.0),
                     "cue": s.get("cue") or "", "seconds": seconds,
                     "failure": s.get("failure"), "outlier": s.get("outlier"),
                     "escalation": s.get("escalation"), "model": s.get("model"),
                     "used": used})
    if not any(r["used"] for r in rows):
        return [], "this scan has no usable segment audio left to keep"
    return rows, None


def _clip_fidelity(result: dict) -> dict | None:
    """The compact, per-clip half of the fidelity payload — the number a
    selection or a prune can rank on. None when nothing was measured, because
    absent and measured-badly must stay distinguishable."""
    fid = result.get("fidelity")
    if not isinstance(fid, dict) or not fid.get("available"):
        return None
    stems = {}
    for emo, row in (fid.get("stems") or {}).items():
        if isinstance(row, dict) and row.get("identity") is not None:
            stems[emo] = row["identity"]
    return {"version": fid.get("version"),
            "reference_similarity": fid.get("reference_similarity"),
            "cohesion_mad": fid.get("cohesion_mad"),
            "segments_measured": fid.get("segments_measured"),
            "stem_identity": stems, "measures": fid.get("measures")}


def capture_corpus(work_dir: Path, character_id: str, result: dict, *,
                   clip_sha256: str | None, consent: str | None,
                   mode: str = "cloud", levels: dict | None = None,
                   committed: list[dict] | None = None,
                   max_bytes: int | None = None) -> dict:
    """COPY one finished job's durable facts into the character's corpus.

    Called after a commit that actually created Voices. Never raises and never
    fails a commit: the clone the user asked for has already happened, and a
    capture that could not run says why (`captured: False, reason: ...`) instead
    of turning a success into an error.

    Append-only and content-addressed: the clip's sha256 IS the directory name,
    so re-ingesting the same recording finds it already there and does nothing.
    """
    try:
        if not clip_sha256:
            return {"captured": False,
                    "reason": "this job has no clip hash, so its audio cannot be "
                              "stored content-addressed (nothing was written)"}
        statement = (consent or "").strip()
        if not statement:
            # The one refusal that is not about plumbing: retention of a
            # person's voice needs the attestation the clone needed, stored with
            # the audio. No statement, no corpus — and say so.
            return {"captured": False,
                    "reason": "corpus capture needs the ownership attestation "
                              "this clone was made under; nothing was stored"}
        with _corpus_lock(character_id):
            idx = load_corpus(character_id)
            if any(c.get("clip_sha256") == clip_sha256 for c in idx["clips"]):
                return {"captured": False, "already": True, "rev": idx["rev"],
                        "clip_sha256": clip_sha256,
                        "reason": "this recording is already in the corpus "
                                  "(content-addressed by clip hash)"}
            rows, why = _corpus_rows(Path(work_dir), result)
            if why:
                return {"captured": False, "reason": why}

            dest = _clip_dir(character_id, clip_sha256)
            if dest.exists():
                # On disk but not in the index: a capture that died between the
                # copy and the save. Start it again from clean rather than
                # merging into rubbish nobody can account for.
                shutil.rmtree(dest, ignore_errors=True)
            (dest / _CORPUS_SEGMENTS).mkdir(parents=True, exist_ok=True)
            (dest / _CORPUS_STEMS).mkdir(parents=True, exist_ok=True)

            seg_records: list[dict] = []
            for r in rows:
                rel = None
                if r["used"]:
                    rel = f"{_CORPUS_SEGMENTS}/seg_{r['i']:03d}.wav"
                    shutil.copyfile(r["src"], dest / rel)
                seg_records.append(
                    {"i": r["i"], "emotion": r["emotion"],
                     "confidence": round(r["confidence"], 3), "cue": r["cue"],
                     "seconds": r["seconds"], "failure": r["failure"],
                     "outlier": r["outlier"], "escalation": r["escalation"],
                     "model": r["model"], "wav": rel})

            fid = _clip_fidelity(result)
            stem_records: list[dict] = []
            for stem in result.get("stems") or []:
                emo = stem.get("emotion")
                src = Path(work_dir) / f"stem_{emo}.wav"
                if not emo or not src.is_file():
                    continue
                rel = f"{_CORPUS_STEMS}/stem_{emo}.wav"
                shutil.copyfile(src, dest / rel)
                stem_records.append(
                    {"emotion": emo, "seconds": stem.get("seconds"),
                     "segments": stem.get("segments"),
                     "identity": (fid or {}).get("stem_identity", {}).get(emo),
                     "note": stem.get("note"), "wav": rel})

            # segments.json beside the audio: the corpus must be readable
            # WITHOUT the index (the index is a convenience, the clip directory
            # is the record).
            atomic_write_text(dest / "segments.json", json.dumps(
                {"schema": CORPUS_SCHEMA, "clip_sha256": clip_sha256,
                 "mode": mode, "segments": seg_records, "stems": stem_records},
                indent=2))

            clip = {
                "clip_sha256": clip_sha256, "dir": clip_sha256, "mode": mode,
                "added": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "dsp_version": DSP_VERSION,
                # The receipt, stored ONCE and never re-derived — deletion and
                # the read API both quote it back.
                "consent": {"statement": statement, "clip_sha256": clip_sha256,
                            "consented_at": datetime.now(timezone.utc)
                            .isoformat(timespec="seconds")},
                "levels": levels,
                "fidelity": fid,
                "segments": seg_records,
                "stems": stem_records,
                "voices": [v.get("voice_id") for v in (committed or [])
                           if isinstance(v, dict) and v.get("voice_id")],
                "bytes": _dir_bytes(dest),
            }
            idx["clips"].append(clip)
            idx = _save_corpus(character_id, idx)
            pruned = _prune_locked(character_id, idx, max_bytes)
        kept = sum(1 for r in seg_records if r["wav"])
        return {"captured": True, "reason": None, "clip_sha256": clip_sha256,
                "rev": idx["rev"], "segments": kept,
                "segments_recorded": len(seg_records),
                "stems": len(stem_records), "bytes": clip["bytes"],
                "pruned": pruned}
    except Exception as exc:  # noqa: BLE001 - a capture never fails a commit
        _log(f"corpus: capture for '{character_id}' failed: {exc}")
        return {"captured": False,
                "reason": f"the corpus could not be written ({type(exc).__name__})"}


def _prune_rank(clip: dict) -> tuple:
    """Pruning order, named: LOWEST measured identity first, then oldest.

    An unmeasured clip sorts below every measured one on purpose — it is the
    clip with the least evidence that it is worth the disk, not the clip we know
    is worst. Ties (and unmeasured clips against each other) break oldest-first.
    """
    fid = clip.get("fidelity") or {}
    sim = fid.get("reference_similarity")
    return (0 if sim is None else 1, sim if sim is not None else 0.0,
            clip.get("added") or "")


def _prune_locked(character_id: str, idx: dict, max_bytes: int | None) -> list[dict]:
    """Drop whole clips until the character is under its byte cap. Caller holds
    the corpus lock and passes the freshly-saved index.

    Whole clips, never individual segments: a half-deleted recording is a
    retention story nobody can tell, and the deletion surface the product
    promises is "this recording, gone".
    """
    cap = SETTINGS.corpus_max_bytes if max_bytes is None else max_bytes
    removed: list[dict] = []
    if cap <= 0:
        return removed
    while corpus_bytes(idx) > cap and len(idx["clips"]) > 1:
        victim = sorted(idx["clips"], key=_prune_rank)[0]
        sim = (victim.get("fidelity") or {}).get("reference_similarity")
        shutil.rmtree(_clip_dir(character_id, victim["clip_sha256"]),
                      ignore_errors=True)
        idx["clips"] = [c for c in idx["clips"]
                        if c.get("clip_sha256") != victim["clip_sha256"]]
        removed.append({
            "clip_sha256": victim["clip_sha256"], "bytes": victim.get("bytes"),
            "why": (f"pruned to stay under the {cap}-byte corpus cap — "
                    + ("its speaker identity was never measured, so it is the "
                       "least-evidenced audio held"
                       if sim is None else
                       f"lowest measured speaker identity ({sim}) in this corpus")
                    + f", added {victim.get('added')}")})
    if removed:
        _save_corpus(character_id, idx)
    if corpus_bytes(idx) > cap and len(idx["clips"]) <= 1:
        removed.append({
            "clip_sha256": None, "bytes": corpus_bytes(idx),
            "why": (f"this corpus is over its {cap}-byte cap but only one "
                    "recording remains — nothing was pruned, because a cap is "
                    "not a reason to leave a character with no corpus at all")})
    return removed


def prune_corpus(character_id: str, max_bytes: int | None = None) -> list[dict]:
    """Bring a character's corpus back under its cap. Returns what went, named."""
    with _corpus_lock(character_id):
        idx = load_corpus(character_id)
        return _prune_locked(character_id, idx, max_bytes)


def corpus_view(character_id: str) -> dict:
    """What audio of this person the box holds — itemized.

    Clips → segments → seconds/emotions/fidelity, plus the consent receipt each
    recording was kept under and the byte budget. This is the surface that makes
    retention inspectable rather than a claim, and it is the same data the
    DELETE route removes by clip hash.
    """
    idx = load_corpus(character_id)
    cap = SETTINGS.corpus_max_bytes
    clips: list[dict] = []
    tot_secs = 0.0
    tot_segs = 0
    for c in idx["clips"]:
        kept = [s for s in c.get("segments", []) if s.get("wav")]
        secs = round(sum(float(s.get("seconds") or 0.0) for s in kept), 2)
        emotions: dict[str, dict] = {}
        for s in kept:
            e = emotions.setdefault(str(s.get("emotion")),
                                    {"segments": 0, "seconds": 0.0})
            e["segments"] += 1
            e["seconds"] = round(e["seconds"] + float(s.get("seconds") or 0.0), 2)
        tot_secs += secs
        tot_segs += len(kept)
        consent = c.get("consent") or {}
        clips.append({
            "clip_sha256": c.get("clip_sha256"), "added": c.get("added"),
            "mode": c.get("mode"), "bytes": c.get("bytes"),
            "seconds": secs, "segments": len(kept),
            "segments_recorded": len(c.get("segments", [])),
            "emotions": emotions,
            "fidelity": c.get("fidelity"),
            "levels": c.get("levels"),
            "voices": c.get("voices") or [],
            "consent": {"consented_at": consent.get("consented_at"),
                        "statement": consent.get("statement"),
                        "clip_sha256": consent.get("clip_sha256")},
            "stems": [{"emotion": s.get("emotion"), "seconds": s.get("seconds"),
                       "segments": s.get("segments"),
                       "identity": s.get("identity")}
                      for s in c.get("stems", [])],
            "items": [{"i": s.get("i"), "emotion": s.get("emotion"),
                       "seconds": s.get("seconds"),
                       "confidence": s.get("confidence"), "cue": s.get("cue"),
                       "outlier": s.get("outlier"), "failure": s.get("failure")}
                      for s in c.get("segments", [])],
        })
    used = corpus_bytes(idx)
    return {"character_id": character_id, "schema": idx.get("schema"),
            "corpus_rev": idx.get("rev"), "updated": idx.get("updated"),
            "dsp_version": DSP_VERSION, "clips": clips,
            "totals": {"clips": len(clips), "segments": tot_segs,
                       "seconds": round(tot_secs, 2), "bytes": used},
            "cap_bytes": cap, "over_cap": bool(cap > 0 and used > cap)}


def delete_clip(character_id: str, clip_sha: str) -> dict:
    """Remove EVERY segment and stem derived from one recording, and say what
    went. The retention story in one call: what the box held, gone, itemized.

    Returns None-free facts (`removed`) plus what remains, so a client can show
    the user the consequence of the deletion instead of a bare 204.
    """
    with _corpus_lock(character_id):
        idx = load_corpus(character_id)
        target = next((c for c in idx["clips"]
                       if c.get("clip_sha256") == clip_sha), None)
        if target is None:
            return {"removed": None,
                    "reason": "no recording with that clip hash is in this "
                              "character's corpus"}
        d = _clip_dir(character_id, clip_sha)
        on_disk = _dir_bytes(d)
        shutil.rmtree(d, ignore_errors=True)
        still_there = d.exists()
        idx["clips"] = [c for c in idx["clips"]
                        if c.get("clip_sha256") != clip_sha]
        idx = _save_corpus(character_id, idx)
        kept = [s for s in target.get("segments", []) if s.get("wav")]
        report = {
            "removed": {
                "clip_sha256": clip_sha,
                "segments": len(kept),
                "segment_labels": len(target.get("segments", [])),
                "stems": len(target.get("stems", [])),
                "seconds": round(sum(float(s.get("seconds") or 0.0)
                                     for s in kept), 2),
                "bytes": on_disk or target.get("bytes"),
                "added": target.get("added"),
                # Named honestly: the index no longer references this clip
                # either way, but "the files would not delete" is a fact an
                # operator has to be able to act on.
                "files_deleted": not still_there,
            },
            "reason": None if not still_there else
            "the index no longer holds this recording, but some of its files "
            "could not be deleted from disk and must be removed by hand",
            "corpus_rev": idx["rev"],
            "remaining": {"clips": len(idx["clips"]),
                          "bytes": corpus_bytes(idx)},
        }
    return report


# ── RE-DERIVATION: rebuild a character's stems from its whole corpus ──────────
# The pay-off. Selection is BEST-OF across every take the box holds, so a too-
# short emotion that could never clear MIN_STEM_SECONDS in one recording clears
# it across takes — and a better splice DSP, a newer model or one more recording
# retroactively improves voices that already exist.
def _selection_basis(rows: list[dict]) -> str:
    """Which ranking a selection is entitled to use.

    Measured identity is only comparable against measured identity, so it is
    used ONLY when every candidate has one; a mixed set falls back wholesale to
    duration x confidence rather than ranking two different quantities against
    each other and calling the result "best".
    """
    if rows and all(r.get("identity") is not None for r in rows):
        return "fidelity"
    return "duration_confidence"


def corpus_candidates(character_id: str, idx: dict | None = None) -> list[dict]:
    """Every stored segment of this character that still has audio on disk."""
    idx = load_corpus(character_id) if idx is None else idx
    base = corpus_dir(character_id)
    rows: list[dict] = []
    for c in idx.get("clips", []):
        sha = c.get("clip_sha256")
        ident = (c.get("fidelity") or {}).get("stem_identity") or {}
        for s in c.get("segments", []):
            rel = s.get("wav")
            if not rel:
                continue
            wav = base / str(sha) / rel
            if not wav.is_file():
                continue
            rows.append({
                "clip_sha256": sha, "added": c.get("added") or "",
                "i": int(s.get("i") or 0), "emotion": s.get("emotion"),
                "seconds": float(s.get("seconds") or 0.0),
                "confidence": float(s.get("confidence") or 0.0),
                # Per-clip-per-emotion measured identity: the finest grain this
                # pipeline ever measured for a stem, and named as such.
                "identity": ident.get(s.get("emotion")),
                "outlier": s.get("outlier"), "wav": str(wav)})
    return rows


def select_best(character_id: str, emotions: list[str] | None = None,
                idx: dict | None = None,
                cap_seconds: float | None = None) -> dict:
    """Best-of selection per emotion, across every clip in the corpus.

    Merit chooses; chronology splices — segments are picked by rank and then
    ordered by (clip added, segment index), because `concat_wavs` level-matches
    and crossfades a SEQUENCE and re-ordering utterances is what makes a stem
    sound assembled. Flagged (unlike-the-rest) segments rank last but are not
    excluded: the scan already dropped everything that was not this person.
    """
    idx = load_corpus(character_id) if idx is None else idx
    cap = SETTINGS.corpus_stem_seconds if cap_seconds is None else cap_seconds
    rows = corpus_candidates(character_id, idx)
    by_emotion: dict[str, list[dict]] = {}
    for r in rows:
        by_emotion.setdefault(str(r["emotion"]), []).append(r)
    want = list(by_emotion) if not emotions else list(dict.fromkeys(emotions))

    picks: dict[str, list[dict]] = {}
    report: dict[str, dict] = {}
    for emo in want:
        cands = by_emotion.get(emo) or []
        if not cands:
            report[emo] = {"segments": 0, "seconds": 0.0, "basis": None,
                           "why": "no stored audio is labelled with this emotion"}
            continue
        basis = _selection_basis(cands)
        if basis == "fidelity":
            key = (lambda r: (1 if r["outlier"] else 0, -float(r["identity"]),
                              -r["seconds"], r["added"], r["i"]))
        else:
            key = (lambda r: (1 if r["outlier"] else 0,
                              -(r["seconds"] * max(r["confidence"], 0.0)),
                              -r["seconds"], r["added"], r["i"]))
        picked: list[dict] = []
        have = 0.0
        for r in sorted(cands, key=key):
            if have >= cap:
                break
            picked.append(r)
            have += r["seconds"]
        picked.sort(key=lambda r: (r["added"], r["clip_sha256"] or "", r["i"]))
        picks[emo] = picked
        report[emo] = {"segments": len(picked), "seconds": round(have, 2),
                       "basis": basis,
                       "clips": sorted({r["clip_sha256"] for r in picked}),
                       "why": None}
    return {"picks": picks, "report": report, "corpus_rev": idx.get("rev", 0)}


def rederive(character_id: str, work_dir: Path,
             emotions: list[str] | None = None, *,
             progress: Callable[[int, str | None], None] | None = None,
             should_cancel: Callable[[], bool] | None = None,
             on_voice: Callable[[dict], None] | None = None,
             synthesize: Callable[[str, str], bytes] | None = None,
             max_bytes: int | None = None) -> dict:
    """Rebuild this character's stems from its corpus and re-export the Voices.

    No upload, no cloud call, no new consent (the receipt stored with the audio
    is the consent, and it is stamped forward onto every rebuilt Voice) — the
    whole job is local by construction. Re-export goes through the SAME one-load
    child `commit` already drives, with `replace=True` so an existing emotion is
    upgraded in place rather than skipped as a slot collision.

    It is also THE upgrade path for the measured space. A Voice committed before
    `commit` stamped `prosody` carries none, so it is invisible to
    `voices.prosody_map` and to `emotions.resolve`'s measured walk; a rebuild
    re-splices the stems and re-registers through the same `commit`, so it picks
    the measurement up for free. A one-shot backfill CLI was considered and is
    not possible for the rest: the stem a legacy Voice was cloned from lived in
    the job workdir, which `_gc_once` rmtree's half an hour after the scan, and
    an embedding cannot be probed. So the honest statement is — corpus-backed
    Characters upgrade on the next rebuild, and a Character whose audio was
    never retained can only regain a measurement by being ingested again.

    Three refusals, each named rather than empty-successful:
      * NO CORPUS       — nothing was ever captured for this character.
      * EMPTY SELECTION — a corpus exists but holds no audio for what was asked.
      * OVER CAP        — the corpus is above its byte cap; prune it first, so a
        rebuild is never the thing that cements an over-budget corpus in place.
    """
    idx = load_corpus(character_id)
    if not idx.get("clips"):
        raise UserFacing(
            "there is no corpus for this character — capture is opt-in, so "
            "re-run an ingest with corpus enabled before rebuilding from it")
    cap = SETTINGS.corpus_max_bytes if max_bytes is None else max_bytes
    used = corpus_bytes(idx)
    if cap > 0 and used > cap:
        raise UserFacing(
            f"this character's corpus is {used} bytes, over its {cap}-byte cap "
            "— prune or delete recordings before rebuilding from it")

    sel = select_best(character_id, emotions, idx)
    picks = {e: rows for e, rows in sel["picks"].items() if rows}
    if not picks:
        raise UserFacing(
            "nothing in this character's corpus matches what was asked for, so "
            "there is nothing to rebuild")

    work_dir = Path(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    built: list[dict] = []
    for emo, rows in sorted(picks.items()):
        dst = work_dir / f"stem_{emo}.wav"
        try:
            sp = concat_wavs([Path(r["wav"]) for r in rows], dst,
                             cap_seconds=SETTINGS.corpus_stem_seconds)
        except Exception as exc:  # noqa: BLE001 - one emotion, never the job
            _log(f"rederive: '{emo}' could not be spliced: {exc}")
            sel["report"].setdefault(emo, {})["why"] = (
                "the stored segments for this emotion could not be spliced")
            continue
        built.append({"emotion": emo, "seconds": sp.seconds,
                      "segments": sp.segments,
                      "eligible": sp.seconds >= MIN_STEM_SECONDS})
        sel["report"].setdefault(emo, {})["stem_seconds"] = sp.seconds
    if not built:
        raise UserFacing("none of this character's stored audio could be "
                         "spliced into a stem")

    meta = _load_meta()
    name = meta["characters"].get(character_id, {}).get("name", character_id)
    newest = max(idx["clips"], key=lambda c: c.get("added") or "")
    consent = (newest.get("consent") or {}).get("statement")
    provenance = {"corpus_rev": idx.get("rev", 0), "dsp_version": DSP_VERSION,
                  "model_version": model_version(),
                  "basis": {e: sel["report"].get(e, {}).get("basis")
                            for e in picks},
                  "clips": sorted({r["clip_sha256"] for rows in picks.values()
                                   for r in rows}),
                  "derived_at": datetime.now(timezone.utc)
                  .isoformat(timespec="seconds")}

    created = commit(work_dir, name, [b["emotion"] for b in built],
                     character_id, consent=consent,
                     clip_sha256=(newest.get("consent") or {}).get("clip_sha256"),
                     progress=progress, should_cancel=should_cancel,
                     on_voice=on_voice, synthesize=synthesize,
                     replace=True, source="rederive", derived_from=provenance)
    return {"character_id": character_id, "created": created,
            "stems": built, "selection": sel["report"],
            "derived_from": provenance,
            "skipped": [b["emotion"] for b in built
                        if b["emotion"] not in {c["emotion"] for c in created}]}


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
