"""HTTP surface for the Character-ingestion flow (with speaker selection).

  POST /v1/ingest/scan                      (file) → { job_id }  [analyze: transcribe+isolate]
  GET  /v1/ingest/{job}                     → { status, step, steps[], partial, speakers, result }
  GET  /v1/ingest/{job}/speaker-preview/{id}→ per-speaker sample wav
  POST /v1/ingest/{job}/speaker             { speaker_id }  [start label+stem for that speaker]
  GET  /v1/ingest/{job}/preview/{emotion}   → stem wav (the SPEAKER's own audio)
  POST /v1/ingest/{job}/audition            { emotion, text, recipe? } → wav (a CLONE)
  POST /v1/ingest/{job}/commit              { character, emotions[], character_id?,
                                              recipes?, corpus? } → voices
  POST /v1/ingest/rederive                  { character_id, emotions? } → { job_id }
  GET  /v1/characters/{id}/corpus           → what audio of this person is kept
  DELETE /v1/characters/{id}/corpus/{sha}   → remove every segment from one clip

The corpus (`service/ingest.py`, "THE VOICE CORPUS"): OPT-IN per job (`corpus:
true` on the scan or the commit, default OFF), captured only after a commit that
really created Voices, and only when that commit carried an ownership
attestation. `rederive` rebuilds a character's stems from everything the corpus
holds and re-exports through the same one-load child a commit uses — it is a
JOB, not a blocking call, for exactly the reason commit is one.

Status flow: running → awaiting_speaker → running → done. `partial` streams live
intermediate data (word count, speakers, per-emotion tally) for a data-rich loader.

Durability: every job owns a subdir under INGEST_WORK_DIR holding its files and a
`state.json` mirror of the job dict. All JOBS mutations + persistence happen under a
single lock. On import we rehydrate finished/awaiting jobs (marking any job caught
mid-flight by the restart as errored) and start a background GC thread that expires
IDLE jobs (and orphan workdirs) on a timer — a job that is actively working only
ages out on the far longer wedged threshold, so GC never deletes a workdir under
a running thread.

Abandonment: `job["cancel"]` is the single teardown flag, and EVERY phase honours
it — analyze polls it before each paid call, labelling before each segment,
commit between emotions. A commit that is cancelled OR that fails rolls back the
Voices it had already registered (`_rollback`), because registration happens per
stem and both paths otherwise leave a partial Character behind. Phase failures
reach the client through `errors.sanitize_detail`, never as raw tool output.

Admission: `Settings.ingest_max_jobs` bounds how many jobs may be working at
once; the phase-starting routes answer 429 above it. Auditions are admitted
SEPARATELY (`_audition_slot`): they hold no job slot, because an audition is a
read-only experiment on a finished scan and queueing one behind two long scans
would make "hear it first" unavailable exactly when someone is deciding.

Auditions (the Audition Room): `/preview/{emotion}` serves the SOURCE stem — the
speaker's own spliced audio — and always has. `/audition` serves a CLONE of a
candidate stem speaking a chosen line: a throwaway voice, exported and spoken in
one child process, never registered in the roster, deleted before the response is
written. Candidate stems come from `recipes`: 2-3 deterministic splices per
emotion computed from the segment labels the scan already produced, so a user can
compare "all of it" against "the longest takes" against "the cleanest signal"
before anything irreversible happens. `commit` re-splices to the chosen recipe.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import shutil
import subprocess
import threading
import time
import uuid
import wave
from pathlib import Path
from typing import Callable, Iterator

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from service import errors, export_stems, ingest, voices
from service.config import SETTINGS
from service.emotions import normalize_emotion
from service.errors import job_expired

logger = logging.getLogger("gravitone")

# ONE router, NO prefix — deliberately. This module owns two path families:
# `/v1/ingest/...` (the scan → review → commit flow) and
# `/v1/characters/{id}/corpus...` (what audio of a person the box kept, and the
# deletion surface for it). They are the same capability and the same "clone"
# scope, so they ride the same router `service/app.py` already mounts; a second
# router would need a second mount and would let the corpus surface ship
# unwired. Every path below is therefore written out in full.
router = APIRouter(tags=["ingest"])
INGEST = "/v1/ingest"

# Same step KEYS in both modes (the web loader keys off them); only the
# labels differ. Sovereign = local-only ffmpeg pipeline, no network I/O.
STEPS_BY_MODE = {
    "cloud": [
        {"key": "transcribe", "label": "Transcribe & diarize"},
        {"key": "isolate", "label": "Isolate voice"},
        {"key": "label", "label": "Detect emotions"},
        {"key": "stem", "label": "Build emotion stems"},
    ],
    "sovereign": [
        {"key": "isolate", "label": "Clean audio (local)"},
        {"key": "transcribe", "label": "Detect speech (local)"},
        {"key": "label", "label": "Group segments (local)"},
        {"key": "stem", "label": "Build voice stem"},
    ],
    # Re-derivation has no recording to analyze: it selects from stored audio
    # and clones. Same step-key shape so the studio's loader needs no new case.
    "rederive": [
        {"key": "stem", "label": "Rebuild stems from the corpus"},
        {"key": "clone", "label": "Re-export voices"},
    ],
}
# Modes a caller may ASK for on /scan. "rederive" is a mode this service enters
# by its own route, never by upload — kept off this tuple so the scan surface
# cannot be talked into it.
SCAN_MODES = ("auto", "cloud", "sovereign")

# ── durable job store ─────────────────────────────────────────────────────────
JOBS: dict[str, dict] = {}
_LOCK = threading.RLock()          # guards every JOBS mutation + state persistence
WORK_ROOT = Path(SETTINGS.ingest_work_dir)
_TTL = 60 * 30                     # idle jobs (and their workdirs) expire after 30 min
_GC_INTERVAL = 60 * 5             # background GC sweep cadence

# Statuses that mean "a thread is doing work for this job right now". They are
# what the admission gate counts and what GC refuses to reap on the idle TTL.
ACTIVE_STATUSES = ("running", "committing")
# The only TTL an ACTIVE job can hit. Expiry is measured from the last state
# mutation (`touched`), not from creation: a cloud scan of a long recording, or
# a commit started 25 minutes after the scan, used to be reaped mid-phase by the
# creation-age TTL — the workdir was deleted out from under a thread that was
# still writing into it. A job that has genuinely made no progress for this long
# is wedged, and IS reaped (with the cancel flag set first, as always).
_RUNNING_TTL = 60 * 120
# Bounded concurrency: nothing used to stop N uploads spawning N unbounded
# fan-outs of ffmpeg + paid cloud calls. See Settings.ingest_max_jobs.
MAX_ACTIVE_JOBS = SETTINGS.ingest_max_jobs
# How long a refused caller is told to wait. Coarse on purpose: the work that
# holds a slot is a whole scan or commit (minutes), so any precise-looking
# number would be a guess dressed as an ETA. See `_admit`.
ADMISSION_RETRY_AFTER_S = 5

# ── auditions ─────────────────────────────────────────────────────────────────
# How many auditions may be synthesizing at once, ACROSS jobs. Deliberately its
# own budget rather than a job slot: an audition neither transcribes nor
# registers anything, it is a finished scan being sampled, and the whole feature
# is worthless if it is unavailable while somebody else's scan runs. It is still
# bounded, because each one is a real CPU model load in a child process.
MAX_ACTIVE_AUDITIONS = 2
AUDITION_RETRY_AFTER_S = 8
# One cold model load (~15s) plus one line of CPU synthesis. Generous, and a
# timeout is REPORTED as a timeout (export_stems.audition names it).
AUDITION_TIMEOUT_S = 240.0
# The line a candidate speaks when the caller does not choose one. Short, plainly
# declarative, and emotionally uncommitted, so the recipe is what differs between
# two takes rather than the reading.
DEFAULT_AUDITION_TEXT = "This is how I sound when I say something I mean."
MAX_AUDITION_TEXT = 240
_audition_lock = threading.Lock()
_active_auditions = 0


@contextlib.contextmanager
def _audition_slot() -> Iterator[None]:
    """Cheap admission for one audition. 429 (named, with Retry-After) when the
    audition budget is full — never counted against, and never blocked by,
    `MAX_ACTIVE_JOBS`. Released in a `finally`, so a failed synthesis cannot
    strand the budget the way a leaked counter would."""
    global _active_auditions
    with _audition_lock:
        if _active_auditions >= MAX_ACTIVE_AUDITIONS:
            raise HTTPException(
                429, f"{_active_auditions} audition(s) are already being "
                     "synthesized on the CPU engine — try again in a moment",
                headers={"Retry-After": str(AUDITION_RETRY_AFTER_S)})
        _active_auditions += 1
    try:
        yield
    finally:
        with _audition_lock:
            _active_auditions -= 1


# ── recipes ───────────────────────────────────────────────────────────────────
# A recipe is one DETERMINISTIC way to splice an emotion's segments into a stem.
# The scan already knows each segment's emotion, confidence, duration and levels;
# collapsing all of that into a single stem threw away every alternative reading
# of the same recording. These are those alternatives, named:
#
#   full       every usable segment, recording order — what the ledger shows and
#              what commit has always cloned. Always present, always the default.
#   longest    the longest takes only — sustained phonation teaches a voice more
#              than a pile of two-word fragments.
#   confident  only the segments the classifier was most sure about — a stem with
#              no mislabelled audio in it, at the cost of length.
#   tightest   the best speech-to-noise-floor segments (`ingest.measure_levels`,
#              the same measurement the sovereign path takes) — drops the noisy
#              spans rather than the short ones.
#
# Determinism is a contract, not an accident: every ordering breaks ties on the
# segment index, so the same job produces the same recipes on every rebuild, and
# a test can assert the exact index sets.
RECIPE_FULL = "full"
RECIPE_ORDER = (RECIPE_FULL, "longest", "confident", "tightest")
RECIPE_LABELS = {
    RECIPE_FULL: ("everything", "every usable segment, in recording order"),
    "longest": ("longest takes", "the longest segments only — more sustained speech"),
    "confident": ("surest labels", "only the segments the classifier was most sure about"),
    "tightest": ("cleanest signal", "the segments with the most speech above the noise floor"),
}
# 3 = the default plus two alternatives. Beyond that an A/B becomes a menu, and
# the proposal's own risk note is decision fatigue on the critical path.
MAX_RECIPES_PER_EMOTION = 3
# How much audio a subset recipe aims for before it stops adding segments. The
# floor is the backend's own clone minimum, so no alternative is offered that is
# knowably too short to commit; above that a little headroom beats a bare pass.
RECIPE_TARGET_SECONDS = 8.0
# ...but never so much of what is available that every "subset" is the whole set.
# A target at or above the emotion's total length makes each ordering select
# everything, the variants collapse into `full`, and the drill-down silently
# disappears on exactly the recordings it was built for (a 6s stem). The share is
# therefore relative to what this emotion actually has.
RECIPE_TARGET_SHARE = 0.7


def _wav_seconds(path: Path) -> float:
    try:
        with wave.open(str(path), "rb") as w:
            return round(w.getnframes() / w.getframerate(), 2)
    except (OSError, wave.Error):
        return 0.0


def segment_rows(work_dir: Path, result: dict) -> tuple[list[dict], str | None]:
    """The scan's per-segment labels re-joined to their extracted wavs.

    `label_and_stem` reports segments in index order but publishes neither the
    index nor the wav path, so the join is positional — and a positional join
    that is wrong would silently splice the wrong audio into a recipe. It is
    therefore VERIFIED: each row's labelled duration must match the wav on disk
    (they are the same span, extracted by `to_wav`). A mismatch abandons recipes
    entirely with a named reason rather than offering candidates built from
    misattributed audio.

    Returns (rows, reason-recipes-are-unavailable).
    """
    segs = result.get("segments")
    if not isinstance(segs, list) or not segs:
        return [], "no per-segment labels on this scan"
    rows: list[dict] = []
    for i, s in enumerate(segs):
        wav = work_dir / f"seg_{i:03d}.wav"
        if not wav.is_file():
            # A segment that failed extraction has no audio and feeds no stem —
            # exactly as the pipeline's own `usable` filter treats it.
            if not s.get("failure"):
                return [], "segment audio is missing for this scan"
            continue
        seconds = _wav_seconds(wav)
        declared = float(s.get("dur") or 0.0)
        if declared and abs(seconds - declared) > 0.35:
            return [], "segment audio could not be matched to its labels"
        if s.get("failure"):
            continue
        if s.get("outlier") == "dropped":
            # The pipeline measured this segment as not the target speaker and
            # removed it from every stem (ingest.label_and_stem). A recipe that
            # re-introduced it would quietly undo that decision — and "the user
            # picked it" is not consent to clone a bystander. "flagged" segments
            # ARE in the stems, so they stay candidates.
            continue
        rows.append({"i": i, "wav": str(wav), "emotion": s.get("emotion"),
                     "confidence": float(s.get("confidence") or 0.0),
                     "seconds": seconds})
    if not rows:
        return [], "no usable segments on this scan"
    return rows, None


def _prefix_to_target(cands: list[dict], order: list[dict], target: float) -> list[dict]:
    """Take segments in `order` until `target` seconds are covered, then return
    them in RECORDING order. The selection is by merit; the splice is always
    chronological, because `concat_wavs` level-matches and crossfades a sequence
    and re-ordering utterances is the one thing that makes a stem sound assembled."""
    picked: list[dict] = []
    have = 0.0
    for row in order:
        if have >= target:
            break
        picked.append(row)
        have += row["seconds"]
    return sorted(picked, key=lambda r: r["i"])


def _variants(cands: list[dict], target: float) -> list[tuple[str, list[dict]]]:
    """Every candidate splice for one emotion, in offer order. A variant that
    would be identical to one already offered is not offered — an A/B between two
    identical takes is a fake choice, and this flow's whole problem was fake
    information about audio."""
    out: list[tuple[str, list[dict]]] = [(RECIPE_FULL, cands)]
    if len(cands) >= 2:
        out.append(("longest", _prefix_to_target(
            cands, sorted(cands, key=lambda r: (-r["seconds"], r["i"])), target)))
        confs = {r["confidence"] for r in cands}
        if len(confs) > 1:
            # All-equal confidence (sovereign mode labels everything 1.0) would
            # make "surest labels" a lie dressed as a measurement.
            out.append(("confident", _prefix_to_target(
                cands, sorted(cands, key=lambda r: (-r["confidence"], r["i"])), target)))
        snr: list[tuple[float, dict]] = []
        for r in cands:
            lv = ingest.measure_levels(Path(r["wav"]))
            if lv.measured:
                snr.append((lv.speech_db - lv.floor_db, r))
        if len(snr) == len(cands) and len(cands) >= 3:
            out.append(("tightest", _prefix_to_target(
                cands, [r for _, r in sorted(snr, key=lambda t: (-t[0], t[1]["i"]))], target)))

    seen: set[tuple[int, ...]] = set()
    deduped: list[tuple[str, list[dict]]] = []
    for kind, rows in out:
        key = tuple(r["i"] for r in rows)
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append((kind, rows))
    return deduped[:MAX_RECIPES_PER_EMOTION]


def build_recipes(work_dir: Path, result: dict) -> tuple[dict[str, dict[str, list[int]]], str | None]:
    """Compute + splice the candidate stems for a finished scan, IN PLACE.

    Grows every `result["stems"][*]` entry with `recipes: [{id, label, how,
    seconds, segments, default}]` and writes one `stem_{emotion}__{id}.wav` per
    non-default recipe (the default recipe IS `stem_{emotion}.wav`, already on
    disk and already measured — it is never re-spliced, so the number the ledger
    showed stays the number the ledger shows).

    Returns (plan, reason) where `plan` is `{emotion: {recipe_id: [segment
    indices]}}` — kept on the job and NEVER published: a client names a recipe by
    id, so no caller can ever hand this service a segment selection of its own.
    `reason` names a degraded outcome for the payload; recipes are advisory and
    their absence must never fail a scan.
    """
    stems = result.get("stems")
    if not isinstance(stems, list) or not stems:
        return {}, "this scan produced no stems"
    rows, reason = segment_rows(work_dir, result)
    if reason:
        return {}, reason

    min_stem = float(result.get("min_stem") or ingest.MIN_STEM_SECONDS)
    by_emotion: dict[str, list[dict]] = {}
    for r in rows:
        by_emotion.setdefault(r["emotion"], []).append(r)

    plan: dict[str, dict[str, list[int]]] = {}
    for stem in stems:
        emo = stem.get("emotion")
        if emo == ingest.BASELINE:
            # The baseline stem is not "the neutral segments": plan_baseline may
            # have topped it up from other emotions to clear the minimum, and it
            # reports that. Recipes must start from the SAME material the shipped
            # stem started from, or "everything" would mean something different
            # here than it does one row above.
            cands = list(ingest.plan_baseline(by_emotion, min_stem).labs)
            for c in cands:
                c.setdefault("seconds", _wav_seconds(Path(c["wav"])))
        else:
            cands = sorted(by_emotion.get(emo, []), key=lambda r: r["i"])
        if len(cands) < 2:
            continue   # one segment has exactly one splice; absent = invisible
        total = sum(c["seconds"] for c in cands)
        target = max(min_stem, min(RECIPE_TARGET_SECONDS, total * RECIPE_TARGET_SHARE))

        offers: list[dict] = []
        for kind, sel in _variants(cands, target):
            label, how = RECIPE_LABELS[kind]
            if kind == RECIPE_FULL:
                seconds, segments = stem.get("seconds"), stem.get("segments")
            else:
                dst = work_dir / f"stem_{emo}__{kind}.wav"
                try:
                    sp = ingest.concat_wavs([Path(r["wav"]) for r in sel], dst)
                except Exception as exc:  # noqa: BLE001 - one recipe, never the scan
                    logger.warning("recipe %s/%s could not be spliced: %s", emo, kind, exc)
                    continue
                seconds, segments = sp.seconds, sp.segments
            offers.append({"id": kind, "label": label, "how": how,
                           "seconds": seconds, "segments": segments,
                           "default": kind == RECIPE_FULL})
            plan.setdefault(emo, {})[kind] = [r["i"] for r in sel]
        if len(offers) > 1:
            # A lone "everything" is not a choice worth rendering.
            stem["recipes"] = offers
        else:
            plan.pop(emo, None)
    return plan, None


# One external-spend ledger per job, shared by its analyze and label phases so
# the retry/escalation budgets are per JOB (the point of them) and the reported
# cost is the whole job's. Per process, exactly like JOBS.
_SPEND: dict[str, ingest.Spend] = {}

# ── upload validation ─────────────────────────────────────────────────────────
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
MIN_CLIP_SECONDS = 3.0
# Both ElevenLabs calls bill by duration, so the floor without a ceiling bounded
# nothing that costs money. See Settings.ingest_max_clip_seconds.
MAX_CLIP_SECONDS = SETTINGS.ingest_max_clip_seconds
_AUDIO_EXTS = {
    ".mp3", ".wav", ".wave", ".m4a", ".m4b", ".mp4", ".mov", ".ogg", ".oga",
    ".opus", ".flac", ".aac", ".webm", ".wma", ".aiff", ".aif", ".aifc",
    ".amr", ".3gp", ".mkv",
}
# Leading magic bytes that mark a container/codec we can hand to ffmpeg.
_AUDIO_MAGIC = (b"RIFF", b"ID3", b"OggS", b"fLaC", b"FORM", b"\x1aE\xdf\xa3")


def _looks_audio(data: bytes, filename: str) -> bool:
    """Extension whitelist first, then a header-byte sniff so a truthful upload
    without an extension still passes and a mislabelled blob is rejected."""
    if Path(filename or "").suffix.lower() in _AUDIO_EXTS:
        return True
    head = data[:16]
    if any(head.startswith(m) for m in _AUDIO_MAGIC):
        return True
    if len(head) >= 8 and head[4:8] == b"ftyp":   # mp4 / m4a / mov family
        return True
    if len(head) >= 2 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0:  # mp3 frame sync
        return True
    return False


def validate_upload_bytes(data: bytes, filename: str) -> str | None:
    """Return a human error string if the upload is unacceptable, else None."""
    if not data:
        return "empty upload — choose an audio file"
    if len(data) > MAX_UPLOAD_BYTES:
        return f"file too large — keep it under {MAX_UPLOAD_BYTES // (1024 * 1024)} MB"
    if not _looks_audio(data, filename):
        return "unsupported file type — upload an audio or video recording"
    return None


def probe_duration(path: Path) -> float | None:
    """Clip length via ffprobe; None when it can't be determined.

    None is not "fine, carry on": `check_duration` treats it as a REJECTION,
    because the duration gate is the only thing standing between an upload and
    two duration-billed cloud calls. A missing ffprobe binary (OSError) lands
    here too — the whole pipeline needs ffmpeg, so failing closed is honest."""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True)
    except OSError:
        return None
    if r.returncode != 0:
        return None
    try:
        return float(r.stdout.decode(errors="ignore").strip())
    except ValueError:
        return None


def check_duration(dur: float | None) -> str | None:
    """Human error string when a clip's length disqualifies it, else None.

    Runs BEFORE any paid call. There used to be a floor and no ceiling, and an
    unreadable duration disabled even the floor: `dur is None` waved the upload
    straight through to Scribe."""
    if dur is None:
        return ("couldn't read this recording's length — re-export it as WAV or MP3 "
                "and try again")
    if dur < MIN_CLIP_SECONDS:
        return f"clip too short — record at least {MIN_CLIP_SECONDS:.0f} seconds of speech"
    if dur > MAX_CLIP_SECONDS:
        return (f"recording too long — keep it under {MAX_CLIP_SECONDS / 60:.0f} minutes "
                "(trim to the part you want cloned)")
    return None


def _spend_for(job_id: str) -> ingest.Spend:
    with _LOCK:
        led = _SPEND.get(job_id)
        if led is None:
            led = _SPEND[job_id] = ingest.Spend()
        return led




# ── state persistence (all callers hold _LOCK) ────────────────────────────────
def _persist(job: dict) -> None:
    wd = Path(job["work_dir"])
    # Do NOT mkdir: a teardown (DELETE or GC) may have just rmtree'd this
    # workdir, and recreating it here resurrects an orphan directory that no
    # job owns. If the tree is gone the job is gone — there is nothing to
    # persist.
    if not wd.is_dir():
        return
    # Every state change is a heartbeat: GC ages a job from its last mutation,
    # so a job that is visibly progressing is never reaped mid-phase.
    job["touched"] = time.time()
    try:
        tmp = wd / "state.json.tmp"
        tmp.write_text(json.dumps(job), "utf-8")
        tmp.replace(wd / "state.json")
    except OSError as exc:
        # Losing the on-disk mirror means a restart can't rehydrate this job —
        # worth a log line rather than a bare pass.
        logger.warning("ingest job %s: state persist failed: %s",
                       job.get("id"), exc)


def _get_job(job_id: str) -> dict | None:
    """Locked lookup. Phase threads MUST use this: a bare JOBS[job_id] races a
    concurrent DELETE and dies with an uncaught KeyError on a bare thread."""
    with _LOCK:
        return JOBS.get(job_id)


def _update(job: dict, **fields) -> None:
    """Mutate + persist under the lock. No-op once the job is cancelled so a
    lagging worker thread can't resurrect a torn-down job."""
    with _LOCK:
        if job.get("cancel"):
            return
        job.update(fields)
        _persist(job)


def _mk_step(job: dict, key: str, state: str) -> None:
    with _LOCK:
        if job.get("cancel"):
            return
        for s in job["steps"]:
            if s["key"] == key:
                s["state"] = state
        job["step"] = key
        _persist(job)


def _partial(job: dict, d: dict) -> None:
    with _LOCK:
        if job.get("cancel"):
            return
        job["partial"].update(d)
        _persist(job)


# ── rehydrate + GC ────────────────────────────────────────────────────────────
def _rehydrate() -> None:
    """Reload jobs from disk on startup. Jobs caught mid-flight (running) by the
    restart become errored; awaiting/finished jobs stay usable until they expire."""
    if not WORK_ROOT.is_dir():
        return
    for d in sorted(WORK_ROOT.iterdir()):
        sf = d / "state.json"
        if not d.is_dir() or not sf.is_file():
            continue
        try:
            job = json.loads(sf.read_text("utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(job, dict) or "id" not in job:
            continue
        job["cancel"] = False
        if job.get("status") in ("running", "committing"):
            job["status"] = "error"
            job["error"] = "interrupted by restart"
            _persist(job)  # tmp+replace, same as every other writer
        JOBS[job["id"]] = job


def _is_expired(job: dict, now: float) -> bool:
    """Age a job from its last state mutation, against a TTL chosen by STATUS.

    Age alone reaped jobs that were mid-flight and healthy (a long cloud scan
    hit the 30-minute mark and had its workdir deleted under the running
    thread). An actively-working job now only expires on the far longer wedged
    threshold, and only if it has stopped reporting progress."""
    age = now - max(job.get("touched", 0), job.get("created", 0))
    return age > (_RUNNING_TTL if job.get("status") in ACTIVE_STATUSES else _TTL)


def _active_count() -> int:
    """Jobs currently occupying CPU / external spend. Caller holds _LOCK."""
    return sum(1 for v in JOBS.values() if v.get("status") in ACTIVE_STATUSES)


def _admit() -> None:
    """Admission gate for every phase that starts real work. 429 rather than
    queue: the client is a poller that can retry, and silently queueing an
    upload behind a 10-minute scan reads as a hang.

    `Retry-After` is set because a 429 without one makes the CLIENT invent the
    wait: the studio's retry countdown has to fall back to its own backoff and
    say so, rather than telling the user what this service actually asked for.
    The engine's backpressure paths (service/app.py) have always sent it; this
    one did not, so the two 429s in the product disagreed about whether a
    caller is told when to come back. A scan is minutes long, so the hint is
    deliberately coarse — it says "not instantly", not a real ETA, which is
    the honest amount of information available here.
    """
    with _LOCK:
        active = _active_count()
    if active >= MAX_ACTIVE_JOBS:
        raise HTTPException(
            429, f"{active} recordings are already being processed — "
                 "try again in a moment",
            headers={"Retry-After": str(ADMISSION_RETRY_AFTER_S)})


def _gc_once() -> None:
    now = time.time()
    with _LOCK:
        for jid in [j for j, v in JOBS.items() if _is_expired(v, now)]:
            # Set the cancel flag BEFORE deleting anything — same teardown
            # protocol as cancel_job. Without it a phase thread that outlived
            # the TTL keeps working against a deleted workdir (and _persist
            # used to recreate the directory behind GC's back).
            JOBS[jid]["cancel"] = True
            shutil.rmtree(JOBS[jid]["work_dir"], ignore_errors=True)
            JOBS.pop(jid, None)
            _SPEND.pop(jid, None)
        live = {v["work_dir"] for v in JOBS.values()}
    # Scratch audition artefacts inside a LIVE job's workdir. `export_stems
    # .audition` removes its own scratch dir in a `finally`, so anything left
    # here outlived a crash — log it rather than tidy up in silence.
    for wd in live:
        try:
            leaked = export_stems.gc_scratch(wd)
        except Exception as exc:  # noqa: BLE001 - the sweep must never break GC
            logger.warning("audition scratch sweep failed for %s: %s", wd, exc)
            continue
        if leaked:
            logger.warning("swept %d leaked audition scratch artefact(s) in %s: %s",
                           len(leaked), wd, leaked)
    # orphan workdirs with no live job (e.g. left by a crash) age out too
    if WORK_ROOT.is_dir():
        for d in WORK_ROOT.iterdir():
            if not d.is_dir() or str(d) in live:
                continue
            try:
                if now - d.stat().st_mtime > _TTL:
                    shutil.rmtree(d, ignore_errors=True)
            except OSError:
                pass


def _gc_loop() -> None:
    while True:
        try:
            # Sweep FIRST: the most valuable sweep is the one right after a
            # restart (orphan workdirs left by the previous process), and
            # sleeping first stranded those for a full interval.
            _gc_once()
        except Exception as exc:  # noqa: BLE001 - the loop must never die
            logger.warning("ingest GC sweep failed: %s", exc)
        time.sleep(_GC_INTERVAL)


# ── background phases ─────────────────────────────────────────────────────────
def _canceller(job: dict) -> Callable[[], bool]:
    """The one cancellation predicate handed to the pipeline. Reads the flag
    under _LOCK — cancel_job/GC set it on this same dict after popping the job
    from JOBS, so the thread keeps seeing it."""
    def cancelled() -> bool:
        with _LOCK:
            return bool(job.get("cancel"))
    return cancelled


def _fail(job: dict, action: str, exc: BaseException) -> None:
    """Terminal failure of a background phase, told honestly but without
    internals. Phase exceptions routinely wrap ffmpeg/pocket-tts stderr and
    absolute paths; `errors.sanitize_detail` logs the raw cause against a
    request id and leaves the client the id (only `errors.UserFacing` messages,
    authored for humans, pass through)."""
    _update(job, status="error", error=errors.sanitize_detail(action, exc))


def _analyze(job_id: str, audio: Path) -> None:
    job = _get_job(job_id)
    if job is None:  # cancelled between Thread.start() and here
        audio.unlink(missing_ok=True)
        return
    cancelled = _canceller(job)
    sovereign = job["mode"] == "sovereign"
    try:
        if sovereign:
            # Local-only phase: no paid calls, no fan-out. Cancellation is
            # honoured at its edges (the expensive fan-out in BOTH modes is the
            # labelling phase, which polls per segment).
            if cancelled():
                raise ingest.Cancelled()
            res = ingest.sovereign_analyze(
                audio, Path(job["work_dir"]),
                progress=lambda k, s: _mk_step(job, k, s),
                partial=lambda d: _partial(job, d))
            if cancelled():
                raise ingest.Cancelled()
        else:
            res = ingest.analyze(
                audio, Path(job["work_dir"]),
                progress=lambda k, s: _mk_step(job, k, s),
                partial=lambda d: _partial(job, d),
                should_cancel=cancelled, spend=_spend_for(job_id))
        if not res.get("speakers"):
            raise errors.UserFacing("no speech detected in the clip")
        # What this phase actually spent — zeros in sovereign mode, which is
        # itself worth showing (the audio never left the machine).
        _partial(job, {"spend": _spend_for(job_id).snapshot()})
        # `note`, `limits` and `detection` are what the analyze phase LEARNED
        # about this recording (sovereign only, today): the mode's own limits,
        # the speech-detection outcome and the levels it measured. They used to
        # be dropped here, so the studio hand-copied the limits constant and
        # never saw an outcome at all. Absent in cloud mode → None, not a key
        # the client has to distinguish from "not computed yet".
        _update(job, speakers=res["speakers"], duration=res["duration"],
                note=res.get("note"), limits=res.get("limits"),
                detection=res.get("detection"),
                status="awaiting_speaker")
    except ingest.Cancelled:
        # Not a failure: the job is already torn down and `_update` would
        # no-op anyway. Say so in the log so a vanished job is explicable.
        logger.info("ingest job %s: analyze abandoned (cancelled)", job_id)
    except Exception as exc:  # noqa: BLE001
        _fail(job, "recording analysis", exc)
    finally:
        audio.unlink(missing_ok=True)


def _label(job_id: str, target: str) -> None:
    job = _get_job(job_id)
    if job is None:  # cancelled between Thread.start() and here
        return
    try:
        res = ingest.label_and_stem(
            Path(job["work_dir"]), target,
            progress=lambda k, s: _mk_step(job, k, s),
            partial=lambda d: _partial(job, d),
            mode=job["mode"],
            should_cancel=_canceller(job), spend=_spend_for(job_id))
        # Candidate stems for the Audition Room. Advisory by construction: a
        # failure here costs the user the drill-down, never the scan, and the
        # reason is published rather than swallowed (`recipes.unavailable`).
        plan: dict[str, dict[str, list[int]]] = {}
        why: str | None = None
        try:
            plan, why = build_recipes(Path(job["work_dir"]), res)
        except Exception as exc:  # noqa: BLE001 - never fail a scan over recipes
            logger.warning("ingest job %s: recipes skipped: %s", job_id, exc)
            why = "candidate stems could not be built for this scan"
        _update(job, result={"duration": job.get("duration", 0),
                             "speakers": [s["id"] for s in job.get("speakers", [])],
                             "mode": job["mode"], **res},
                recipe_plan=plan,
                recipes={"applied": {}, "skipped": [], "unavailable": why},
                status="done")
    except ingest.Cancelled:
        logger.info("ingest job %s: labelling abandoned (cancelled)", job_id)
    except Exception as exc:  # noqa: BLE001
        _fail(job, "emotion labelling", exc)


def _commit_progress(job: dict, done: int, total: int, current: str | None) -> None:
    with _LOCK:
        if job.get("cancel"):
            return
        job["partial"] = {"emotions_done": done, "emotions_total": total, "current": current}
        _persist(job)


def _rollback(job_id: str, created: list[dict], why: str) -> None:
    """Undo a half-finished clone. ONE rollback for both abandonment paths.

    `ingest.commit` registers each Voice as it goes, and tearing down the
    WORKDIR does not touch VOICES_DIR — so every emotion that finished before a
    cancel OR before an exception is a live, registered Voice: exactly the
    partial Character the user never agreed to. Only the ids this commit
    created are removed, so a cancelled *extend* keeps the character's
    pre-existing Voices. Teardown must not raise: a failed rollback is logged
    loudly (the voices really are still live) and the job still ends terminal.
    """
    ids = [v.get("voice_id") for v in created
           if isinstance(v, dict) and v.get("voice_id")]
    if not ids:
        return
    try:
        removed = voices.remove_voices(ids)
        logger.warning("ingest job %s %s mid-clone; rolled back %d/%d "
                       "voice(s): %s", job_id, why, len(removed), len(ids), removed)
    except Exception as exc:  # noqa: BLE001 - teardown must not raise
        logger.error(
            "ingest job %s %s but ROLLBACK FAILED — these voices remain "
            "registered and must be removed by hand: %s (%s)",
            job_id, why, ids, exc)


def _apply_recipes(job: dict, emotions: list[str], chosen: dict[str, str]) -> None:
    """Re-splice each chosen emotion's stem to the recipe the user auditioned.

    `ingest.commit` clones `stem_{emotion}.wav`, so committing a choice means
    making that file BE the chosen splice — the recipe wavs were written next to
    it at scan time, so this is a copy, not a re-render, and the audition the user
    heard is byte-identical to what gets cloned.

    Every outcome is named on the job (`recipes.applied` / `recipes.skipped`): a
    chosen recipe whose audio has since been swept, or which was never offered
    for that emotion, must not silently clone the default and let the user
    believe their pick shipped.
    """
    wd = Path(job["work_dir"])
    plan = job.get("recipe_plan") or {}
    applied: dict[str, str] = {}
    skipped: list[dict] = []
    for emo in emotions:
        rid = chosen.get(emo)
        if not rid or rid == RECIPE_FULL:
            continue
        if rid not in (plan.get(emo) or {}):
            skipped.append({"emotion": emo, "recipe": rid,
                            "why": "that recipe was not offered for this emotion"})
            continue
        src = wd / f"stem_{emo}__{rid}.wav"
        dst = wd / f"stem_{emo}.wav"
        try:
            shutil.copyfile(src, dst)
        except OSError as exc:
            logger.warning("ingest job %s: recipe %s/%s not applied: %s",
                           job.get("id"), emo, rid, exc)
            skipped.append({"emotion": emo, "recipe": rid,
                            "why": "the recipe audio is no longer available"})
            continue
        applied[emo] = rid
    with _LOCK:
        if job.get("cancel"):
            return
        cur = job.get("recipes") or {}
        job["recipes"] = {"applied": applied, "skipped": skipped,
                          "unavailable": cur.get("unavailable")}
        _persist(job)


def _capture_corpus(job: dict, character_id: str, statement: str,
                    created: list[dict]) -> None:
    """Copy this job's durable facts into the character's corpus, after a commit
    that really created Voices.

    Runs LAST and reports on the job (`corpus`), never raises and never changes
    the commit's outcome: the clone is already done and registered, so a corpus
    that could not be written is a named degradation, not a failed clone. The
    workdir is untouched — GC still owns it — because the corpus is a COPY.
    """
    outcome: dict
    if not created:
        outcome = {"requested": True, "captured": False,
                   "reason": "this commit created no voices, so there is "
                             "nothing whose source audio would be kept"}
    else:
        res = ingest.capture_corpus(
            Path(job["work_dir"]), character_id, job.get("result") or {},
            clip_sha256=job.get("clip_sha256"), consent=statement,
            mode=job.get("mode") or "cloud", levels=job.get("detection"),
            committed=created)
        outcome = {"requested": True, **res}
    with _LOCK:
        if job.get("cancel"):
            return
        job["corpus"] = outcome
        _persist(job)


def _do_commit(job_id: str, character: str, emotions: list[str], character_id: str | None,
               statement: str, recipes: dict[str, str] | None = None,
               corpus: bool = False) -> None:
    job = _get_job(job_id)
    if job is None:  # cancelled between Thread.start() and here
        return
    if recipes:
        # BEFORE the clone: the stems must be what the user chose by the time the
        # exporter reads them.
        try:
            _apply_recipes(job, emotions, recipes)
        except Exception as exc:  # noqa: BLE001 - a commit must not die over this
            logger.warning("ingest job %s: recipe application failed: %s", job_id, exc)
    total = len(emotions)
    cancelled = _canceller(job)

    # Ledger of what was actually REGISTERED, kept as it happens: on the
    # exception path there is no return value to inspect, and the voices
    # already written are precisely what has to be undone.
    registered: list[dict] = []

    failure: BaseException | None = None
    try:
        created = ingest.commit(
            Path(job["work_dir"]), character, emotions, character_id,
            consent=statement, clip_sha256=job.get("clip_sha256"),
            progress=lambda done, cur: _commit_progress(job, done, total, cur),
            should_cancel=cancelled, on_voice=registered.append)
    except Exception as exc:  # noqa: BLE001
        created, failure = registered, exc

    with _LOCK:
        was_cancelled = bool(job.get("cancel"))
        if not was_cancelled and failure is None:
            job["committed"] = created
            job["partial"] = {"emotions_done": total, "emotions_total": total,
                              "current": None}
            job["status"] = "committed"
            _persist(job)

    if failure is not None:
        # Reach a terminal state FIRST (a poller must never hang on a failed
        # commit), then undo. `_update` no-ops if the job was also cancelled.
        _fail(job, "voice cloning", failure)
        _rollback(job_id, registered, "failed")
    elif was_cancelled:
        _rollback(job_id, created, "cancelled")
    elif corpus:
        # ONLY on the clean path: a rolled-back commit's voices no longer exist,
        # and keeping the audio that made them would be retention with nothing
        # to justify it.
        cid = character_id or voices._slug(character)
        try:
            _capture_corpus(job, cid, statement, created)
        except Exception as exc:  # noqa: BLE001 - never turn a clone into an error
            logger.warning("ingest job %s: corpus capture failed: %s", job_id, exc)


def _do_rederive(job_id: str, character_id: str, emotions: list[str] | None) -> None:
    """Rebuild + re-export one character's voices from its corpus, as a phase.

    Same shape as `_do_commit`, for the same reasons: it loads the TTS model in
    a child process (minutes on a CPU box), it registers Voices one at a time,
    and a caller must be able to cancel it and poll it.

    It does NOT roll back, and that is the deliberate difference from a commit.
    A commit's rollback removes voices the user never had; a re-derivation
    REPLACES voices they already had, and the embedding it replaced is gone by
    the time the row is swapped. Removing the rebuilt voice would therefore
    leave the character with no voice for that emotion at all — strictly worse
    than the rebuilt one it just made. So an abandoned rebuild keeps every
    emotion it finished, and says which ones those were.
    """
    job = _get_job(job_id)
    if job is None:
        return
    registered: list[dict] = []
    started = {"clone": False}

    def _progress(done: int, current: str | None) -> None:
        if not started["clone"]:
            started["clone"] = True
            _mk_step(job, "stem", "done")
            _mk_step(job, "clone", "active")
        with _LOCK:
            if job.get("cancel"):
                return
            job["partial"] = {**(job.get("partial") or {}),
                              "emotions_done": done, "current": current}
            _persist(job)

    failure: BaseException | None = None
    res: dict = {}
    try:
        _mk_step(job, "stem", "active")
        res = ingest.rederive(
            character_id, Path(job["work_dir"]), emotions,
            progress=_progress, should_cancel=_canceller(job),
            on_voice=registered.append)
    except ingest.Cancelled:
        logger.info("ingest job %s: rederive abandoned (cancelled)", job_id)
    except Exception as exc:  # noqa: BLE001
        failure = exc

    with _LOCK:
        was_cancelled = bool(job.get("cancel"))
        if not was_cancelled and failure is None:
            _mk_step(job, "clone", "done")
            job["committed"] = res.get("created") or []
            job["result"] = {"mode": "rederive", **res}
            job["partial"] = {"emotions_done": len(res.get("created") or []),
                              "emotions_total": len(res.get("stems") or []),
                              "current": None}
            job["status"] = "committed"
            _persist(job)

    if failure is not None or was_cancelled:
        done = [v.get("voice_id") for v in registered if isinstance(v, dict)]
        logger.warning(
            "ingest job %s: rederive %s after rebuilding %d voice(s) — they are "
            "KEPT (see _do_rederive): %s", job_id,
            "failed" if failure is not None else "was cancelled", len(done), done)
    if failure is not None:
        _fail(job, "voice re-derivation", failure)


# ── endpoints ─────────────────────────────────────────────────────────────────
@router.post(f"{INGEST}/scan")
def start_scan(file: UploadFile = File(...), mode: str = Form("auto"),
               corpus: bool = Form(False)) -> dict:
    # NOT async: the prologue writes up to 50 MB, runs ffprobe and hashes the
    # clip before handing off to the phase thread — all of that belongs on the
    # threadpool, not the event loop (every other route in this file is `def`).
    #
    # `corpus` (default FALSE) is the whole opt-in: it asks this box to KEEP the
    # audio and labels this job produces once the clone succeeds. It changes
    # nothing about the scan itself, and the commit can still override it.
    if mode not in SCAN_MODES:
        raise HTTPException(400, "mode must be auto, cloud or sovereign")
    _admit()  # before the 50 MB read: a rejected upload should cost nothing
    data = file.file.read()  # sync read — we're on the threadpool
    err = validate_upload_bytes(data, file.filename or "")
    if err:
        raise HTTPException(400, err)

    resolved = ingest.resolve_mode(mode)
    job_id = uuid.uuid4().hex[:12]
    work_dir = WORK_ROOT / job_id
    work_dir.mkdir(parents=True, exist_ok=True)
    safe_name = Path(file.filename or "upload").name
    src = work_dir / f"src-{safe_name}"
    src.write_bytes(data)

    bad = check_duration(probe_duration(src))
    if bad:
        shutil.rmtree(work_dir, ignore_errors=True)
        raise HTTPException(400, bad)

    job = {
        "id": job_id, "status": "running", "step": None, "mode": resolved,
        "steps": [{**s, "state": "pending"} for s in STEPS_BY_MODE[resolved]],
        "partial": {}, "speakers": None, "duration": 0, "result": None, "error": None,
        "note": None, "limits": None, "detection": None,
        "work_dir": str(work_dir), "created": time.time(),
        "clip_sha256": hashlib.sha256(data).hexdigest(), "cancel": False,
        "committed": None,
        # Audition Room state: `recipes` is public (choices + named outcomes),
        # `recipe_plan` is the server-side index map behind them.
        "recipes": None, "recipe_plan": {},
        # Corpus state. `requested` is what the caller asked for at upload time
        # (the commit may still change its mind); everything else is filled in
        # after a successful commit and always NAMES the outcome, including
        # "not requested" — a silent absence would be indistinguishable from a
        # capture that failed.
        "corpus": {"requested": bool(corpus), "captured": False,
                   "reason": None if corpus else "corpus capture was not requested"}}
    with _LOCK:
        JOBS[job_id] = job
        _persist(job)
    threading.Thread(target=_analyze, args=(job_id, src), daemon=True).start()
    return {"job_id": job_id, "mode": resolved}


_PUBLIC_KEYS = ("id", "status", "step", "steps", "partial", "speakers",
                "duration", "result", "error", "mode", "committed",
                # What happened to the user's recipe choices at commit, plus the
                # reason candidate stems are absent when they are. `recipe_plan`
                # (the segment indices behind each recipe) is deliberately NOT
                # here: a client names a recipe, it never selects audio.
                "recipes",
                # Whether this job's audio was kept, and — always — why not.
                "corpus",
                # What analyze learned about THIS recording. A key the job dict
                # holds but this tuple omits is computed and then thrown away —
                # that is exactly what happened to these three.
                "note", "limits", "detection")


@router.get(f"{INGEST}/modes")
def modes() -> dict:
    """What each ingest mode does to a recording, from the backend's own
    constants — and which one `auto` resolves to right now.

    Declared BEFORE `/{job_id}` on purpose: the dynamic route would otherwise
    swallow this path and answer "job expired". The studio used to hand-write
    sovereign's limits into its upload panel, one copy per side of the API with
    nothing to catch a drift; `resolve_mode` is served with them so a user whose
    `auto` will resolve to sovereign is told before they upload, not after."""
    return {
        "resolved_auto": ingest.resolve_mode("auto"),
        "sovereign": {"limits": list(ingest.SOVEREIGN_LIMITS),
                      "note": ingest.sovereign_note()},
    }


@router.get(INGEST + "/{job_id}")
def get_job(job_id: str):
    with _LOCK:
        job = JOBS.get(job_id)
        if not job:
            return job_expired()
        return {k: job.get(k) for k in _PUBLIC_KEYS}


@router.get(INGEST + "/{job_id}/speaker-preview/{sid}")
def speaker_preview(job_id: str, sid: str):
    job = _get_job(job_id)
    if not job:
        return job_expired()
    p = Path(job["work_dir"]) / f"speaker_{sid}.wav"
    if not p.is_file():
        raise HTTPException(404, "preview not found")
    return FileResponse(str(p), media_type="audio/wav")


class SpeakerReq(BaseModel):
    speaker_id: str


@router.post(INGEST + "/{job_id}/speaker")
def choose_speaker(job_id: str, req: SpeakerReq) -> dict:
    _admit()  # labelling is the biggest fan-out in the pipeline
    with _LOCK:
        job = JOBS.get(job_id)
        if not job:
            return job_expired()
        if job["status"] != "awaiting_speaker":
            raise HTTPException(409, "not awaiting speaker")
        job["status"] = "running"
        job["partial"] = {}
        _persist(job)
    threading.Thread(target=_label, args=(job_id, req.speaker_id), daemon=True).start()
    return {"status": "running"}


class AuditionReq(BaseModel):
    emotion: str
    text: str = ""
    recipe: str | None = None


@router.post(INGEST + "/{job_id}/audition")
def audition(job_id: str, req: AuditionReq):
    """Hear a candidate stem AS A VOICE, before anything is committed.

    The one thing this flow could never do: `/preview/{emotion}` plays the
    speaker's own spliced audio, so the question the product exists to answer
    ("does the clone sound like me?") was only answerable after an irreversible
    commit had written real Voices into the roster. This synthesizes `text` with a
    throwaway clone of the chosen candidate stem and returns the wav.

    What makes it safe to call freely:
      * it holds an AUDITION slot, not a job slot (`_audition_slot`), so it
        neither blocks nor is blocked by scans and commits;
      * the scratch voice lives and dies inside this job's workdir under the
        `_audition_` prefix — never `VOICES_DIR`, never `meta.json`, never a
        slot-holder check (`export_stems.audition`);
      * there is no length gate: a stem too short to COMMIT can still be heard,
        which is the point.

    Meta comes back on `X-Audition-*` headers (emotion, recipe, seconds, source
    seconds) so the studio can label what is playing without a second round trip.
    """
    try:
        emotion = normalize_emotion(req.emotion)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    recipe = req.recipe or RECIPE_FULL
    if recipe not in RECIPE_ORDER:
        raise HTTPException(400, "unknown recipe")
    text = (req.text or "").strip() or DEFAULT_AUDITION_TEXT
    if len(text) > MAX_AUDITION_TEXT:
        raise HTTPException(
            400, f"audition line too long — keep it under {MAX_AUDITION_TEXT} characters")

    job = _get_job(job_id)
    if not job:
        return job_expired()
    if job.get("status") != "done":
        raise HTTPException(409, "auditions need a finished scan")
    wd = Path(job["work_dir"])
    if recipe == RECIPE_FULL:
        src = wd / f"stem_{emotion}.wav"
    else:
        if recipe not in ((job.get("recipe_plan") or {}).get(emotion) or {}):
            raise HTTPException(404, "that recipe was not offered for this emotion")
        src = wd / f"stem_{emotion}__{recipe}.wav"
    if not src.is_file():
        raise HTTPException(404, "no audio for that emotion")

    with _audition_slot():
        res = export_stems.audition(
            src=src, text=text,
            language=SETTINGS.language, quantize=SETTINGS.quantize,
            scratch_dir=wd / f"{export_stems.AUDITION_PREFIX}{uuid.uuid4().hex[:8]}",
            timeout=AUDITION_TIMEOUT_S)
    if not res.get("ok") or not res.get("audio"):
        # Named, sanitized: the child's error can carry paths and torch noise.
        raise errors.sanitized_500("audition", res.get("error") or "audition failed")
    return Response(
        content=res["audio"], media_type="audio/wav",
        headers={
            "X-Audition-Emotion": emotion,
            "X-Audition-Recipe": recipe,
            "X-Audition-Seconds": str(res.get("seconds") or ""),
            "X-Audition-Source-Seconds": str(_wav_seconds(src)),
            # A candidate is regenerated on demand and never the same twice —
            # nothing about it is cacheable.
            "Cache-Control": "no-store",
        })


@router.get(INGEST + "/{job_id}/preview/{emotion}")
def preview(job_id: str, emotion: str):
    job = _get_job(job_id)
    if not job:
        return job_expired()
    stem = Path(job["work_dir"]) / f"stem_{emotion}.wav"
    if not stem.is_file():
        raise HTTPException(404, "stem not found")
    return FileResponse(str(stem), media_type="audio/wav")


class CommitReq(BaseModel):
    character: str
    emotions: list[str]
    character_id: str | None = None
    # Server-side consent gate: a direct API caller must attest ownership, and
    # the statement is stored as a receipt on every created Voice.
    attested: bool = False
    statement: str = ""
    # {emotion: recipe_id} — the candidate splice the user auditioned and chose.
    # Absent, empty or `full` for an emotion all mean the same thing: clone what
    # the ledger showed. The fast path never sends this.
    recipes: dict[str, str] | None = None
    # Keep this recording's segments, labels, stems and levels for this
    # character (see ingest.capture_corpus). None = whatever the scan asked for
    # (default OFF); an explicit true/false here wins, because the decision to
    # RETAIN belongs at the moment of consent, not at upload.
    corpus: bool | None = None


@router.post(INGEST + "/{job_id}/commit")
def commit(job_id: str, req: CommitReq):
    """Kick off cloning as a background phase and return immediately. Progress
    (emotions_done / total / current) streams via `partial`; the job ends
    'committed' or 'error'. Poll GET /{job} to follow it."""
    # Boundary validation, BEFORE admission: both fields are client-supplied and
    # both end up in filenames downstream (ingest.commit builds
    # `stem_{emotion}.wav` and the `{cid}-{emotion}-….safetensors` destination),
    # so an unvalidated `..` here writes outside the voices directory. Same rule
    # as every other write path: emotions go through `normalize_emotion`, and a
    # character id must already be its own slug. Reject, never sanitise.
    try:
        emotions = [normalize_emotion(e) for e in req.emotions]
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    if req.character_id is not None and req.character_id != voices._slug(req.character_id):
        raise HTTPException(400, "character_id is not a valid character id")
    # Recipe choices are keys into a server-side plan, and BOTH halves reach a
    # filename (`stem_{emotion}__{recipe}.wav`) — so both are validated the same
    # way the emotions above are: normalized/enumerated, never sanitised.
    chosen: dict[str, str] = {}
    for emo, rid in (req.recipes or {}).items():
        try:
            emo = normalize_emotion(emo)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        if rid not in RECIPE_ORDER:
            raise HTTPException(400, "unknown recipe")
        chosen[emo] = rid
    _admit()  # cloning loads the TTS model in a child process — the heaviest phase
    with _LOCK:
        job = JOBS.get(job_id)
        if not job:
            return job_expired()
        if job["status"] != "done":
            raise HTTPException(409, "scan not finished")
        if not req.character.strip() and not req.character_id:
            raise HTTPException(400, "character name required")
        statement = req.statement.strip()
        if not req.attested or not statement:
            raise HTTPException(422, "ownership attestation required to clone a voice")
        want_corpus = ((job.get("corpus") or {}).get("requested", False)
                       if req.corpus is None else bool(req.corpus))
        job["status"] = "committing"
        job["cancel"] = False
        job["committed"] = None
        job["corpus"] = {"requested": want_corpus, "captured": False,
                         "reason": None if want_corpus
                         else "corpus capture was not requested"}
        job["partial"] = {"emotions_done": 0, "emotions_total": len(emotions), "current": None}
        _persist(job)
    threading.Thread(
        target=_do_commit,
        args=(job_id, req.character.strip(), emotions, req.character_id, statement,
              chosen, want_corpus),
        daemon=True).start()
    return {"status": "committing"}


class RederiveReq(BaseModel):
    character_id: str
    # Which emotions to rebuild. Absent = every emotion the corpus holds audio
    # for, which is the point of the feature (one click, whole character).
    emotions: list[str] | None = None


def _valid_cid(character_id: str) -> str:
    cid = (character_id or "").strip()
    if not cid or cid != voices._slug(cid):
        raise HTTPException(400, "character_id is not a valid character id")
    return cid


@router.post(INGEST + "/rederive")
def start_rederive(req: RederiveReq) -> dict:
    """Rebuild a character's voices from its stored corpus — no upload, no cloud
    call, no new consent (the receipt stored with the audio is the consent).

    The three refusals are answered HERE, synchronously, so a caller learns "you
    have no corpus" as a 404 rather than as a job that fails a minute later:
      404 — nothing has ever been captured for this character;
      409 — the corpus is over its byte cap (prune or delete first), or holds no
            audio for the emotions asked for.
    Everything past that is a background job with the same poll surface as a
    commit: GET /v1/ingest/{job_id}, DELETE to cancel.
    """
    cid = _valid_cid(req.character_id)
    emotions: list[str] | None = None
    if req.emotions is not None:
        try:
            emotions = [normalize_emotion(e) for e in req.emotions]
        except ValueError as exc:
            raise HTTPException(400, str(exc))
    try:
        idx = ingest.load_corpus(cid)
    except errors.UserFacing as exc:
        raise HTTPException(400, str(exc))
    if not idx.get("clips"):
        raise HTTPException(
            404, "there is no corpus for this character — capture is opt-in, so "
                 "re-run an ingest with corpus enabled before rebuilding from it")
    used = ingest.corpus_bytes(idx)
    cap = SETTINGS.corpus_max_bytes
    if cap > 0 and used > cap:
        raise HTTPException(
            409, f"this character's corpus is {used} bytes, over its {cap}-byte "
                 "cap — delete recordings before rebuilding from it")
    sel = ingest.select_best(cid, emotions, idx)
    if not any(rows for rows in sel["picks"].values()):
        raise HTTPException(
            409, "nothing in this character's corpus matches what was asked "
                 "for, so there is nothing to rebuild")

    _admit()   # a rebuild loads the TTS model in a child, exactly like a commit
    job_id = uuid.uuid4().hex[:12]
    work_dir = WORK_ROOT / job_id
    work_dir.mkdir(parents=True, exist_ok=True)
    job = {
        "id": job_id, "status": "committing", "step": None, "mode": "rederive",
        "steps": [{**s, "state": "pending"} for s in STEPS_BY_MODE["rederive"]],
        "partial": {"emotions_done": 0,
                    "emotions_total": sum(1 for r in sel["picks"].values() if r),
                    "current": None},
        "speakers": None, "duration": 0, "result": None, "error": None,
        "note": None, "limits": None, "detection": None,
        "work_dir": str(work_dir), "created": time.time(),
        "clip_sha256": None, "cancel": False, "committed": None,
        "recipes": None, "recipe_plan": {},
        # A rebuild reads the corpus and never writes to it.
        "corpus": {"requested": False, "captured": False,
                   "reason": "a re-derivation reads the corpus, it never adds "
                             "to it", "corpus_rev": sel["corpus_rev"]},
        "character_id": cid}
    with _LOCK:
        JOBS[job_id] = job
        _persist(job)
    threading.Thread(target=_do_rederive, args=(job_id, cid, emotions),
                     daemon=True).start()
    return {"job_id": job_id, "mode": "rederive",
            "selection": sel["report"], "corpus_rev": sel["corpus_rev"]}


@router.get("/v1/characters/{character_id}/corpus")
def get_corpus(character_id: str) -> dict:
    """What audio of this person the box holds — clips, their segments, seconds,
    emotions, measured fidelity and the consent receipt each was kept under.

    Answers for a character with NO corpus too (empty, `totals.clips = 0`)
    rather than 404: "this box keeps nothing of yours" is the answer to the
    question, and a 404 would read as "we could not check".
    """
    cid = _valid_cid(character_id)
    try:
        return ingest.corpus_view(cid)
    except errors.UserFacing as exc:
        raise HTTPException(400, str(exc))


@router.delete("/v1/characters/{character_id}/corpus/{clip_sha}")
def delete_corpus_clip(character_id: str, clip_sha: str) -> dict:
    """Remove every segment and stem derived from ONE recording, and report what
    went. Deliberately not a 204: a deletion the user cannot see the shape of is
    a deletion they have to take on trust, and this is the surface that makes
    keeping the audio defensible in the first place.

    The Voices already cloned from that recording are NOT touched — they are
    embeddings the user asked for and owns; delete them through /v1/voices.
    """
    cid = _valid_cid(character_id)
    try:
        report = ingest.delete_clip(cid, clip_sha)
    except errors.UserFacing as exc:
        raise HTTPException(400, str(exc))
    if report.get("removed") is None:
        raise HTTPException(404, report.get("reason") or "no such recording")
    return report


@router.delete(INGEST + "/{job_id}")
def cancel_job(job_id: str):
    """Cancel a job (between emotions during commit, between phases otherwise),
    mark it 'cancelled' and tear down its workdir."""
    with _LOCK:
        job = JOBS.get(job_id)
        if not job:
            return job_expired()
        job["cancel"] = True
        job["status"] = "cancelled"
        work_dir = job["work_dir"]
        JOBS.pop(job_id, None)
        _SPEND.pop(job_id, None)
    shutil.rmtree(work_dir, ignore_errors=True)
    return {"status": "cancelled"}


# ── startup: rehydrate persisted jobs + launch the GC timer ───────────────────
_started = False


def start_background() -> None:
    """Rehydrate persisted jobs and start the GC sweeper. Called from the app
    lifespan — NOT at import.

    Doing this at import meant real disk work (scanning WORK_ROOT, rewriting
    state.json) ran before the app was ready and outside lifespan supervision,
    and every process that imported this module for any reason — a CLI, a test
    runner — silently spawned a GC thread that could delete another replica's
    workdirs. Tests in particular shared that live thread with the production
    module globals they patch. Idempotent.
    """
    global _started
    with _LOCK:
        if _started:
            return
        _started = True
    _rehydrate()
    threading.Thread(target=_gc_loop, daemon=True, name="ingest-gc").start()
