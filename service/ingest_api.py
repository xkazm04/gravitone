"""HTTP surface for the Character-ingestion flow (with speaker selection).

  POST /v1/ingest/scan                      (file) → { job_id }  [analyze: transcribe+isolate]
  GET  /v1/ingest/{job}                     → { status, step, steps[], partial, speakers, result }
  GET  /v1/ingest/{job}/speaker-preview/{id}→ per-speaker sample wav
  POST /v1/ingest/{job}/speaker             { speaker_id }  [start label+stem for that speaker]
  GET  /v1/ingest/{job}/preview/{emotion}   → stem wav
  POST /v1/ingest/{job}/commit              { character, emotions[], character_id? } → voices

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
once; the phase-starting routes answer 429 above it.
"""
from __future__ import annotations

import hashlib
import json
import logging
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Callable

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from service import errors, ingest, voices
from service.config import SETTINGS
from service.errors import job_expired

logger = logging.getLogger("gravitone")

router = APIRouter(prefix="/v1/ingest", tags=["ingest"])

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
}

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
    upload behind a 10-minute scan reads as a hang."""
    with _LOCK:
        active = _active_count()
    if active >= MAX_ACTIVE_JOBS:
        raise HTTPException(
            429, f"{active} recordings are already being processed — "
                 "try again in a moment")


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
        _update(job, result={"duration": job.get("duration", 0),
                             "speakers": [s["id"] for s in job.get("speakers", [])],
                             "mode": job["mode"], **res},
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


def _do_commit(job_id: str, character: str, emotions: list[str], character_id: str | None,
               statement: str) -> None:
    job = _get_job(job_id)
    if job is None:  # cancelled between Thread.start() and here
        return
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


# ── endpoints ─────────────────────────────────────────────────────────────────
@router.post("/scan")
def start_scan(file: UploadFile = File(...), mode: str = Form("auto")) -> dict:
    # NOT async: the prologue writes up to 50 MB, runs ffprobe and hashes the
    # clip before handing off to the phase thread — all of that belongs on the
    # threadpool, not the event loop (every other route in this file is `def`).
    if mode not in ("auto", "cloud", "sovereign"):
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
        "committed": None}
    with _LOCK:
        JOBS[job_id] = job
        _persist(job)
    threading.Thread(target=_analyze, args=(job_id, src), daemon=True).start()
    return {"job_id": job_id, "mode": resolved}


_PUBLIC_KEYS = ("id", "status", "step", "steps", "partial", "speakers",
                "duration", "result", "error", "mode", "committed",
                # What analyze learned about THIS recording. A key the job dict
                # holds but this tuple omits is computed and then thrown away —
                # that is exactly what happened to these three.
                "note", "limits", "detection")


@router.get("/modes")
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


@router.get("/{job_id}")
def get_job(job_id: str):
    with _LOCK:
        job = JOBS.get(job_id)
        if not job:
            return job_expired()
        return {k: job.get(k) for k in _PUBLIC_KEYS}


@router.get("/{job_id}/speaker-preview/{sid}")
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


@router.post("/{job_id}/speaker")
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


@router.get("/{job_id}/preview/{emotion}")
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


@router.post("/{job_id}/commit")
def commit(job_id: str, req: CommitReq):
    """Kick off cloning as a background phase and return immediately. Progress
    (emotions_done / total / current) streams via `partial`; the job ends
    'committed' or 'error'. Poll GET /{job} to follow it."""
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
        job["status"] = "committing"
        job["cancel"] = False
        job["committed"] = None
        job["partial"] = {"emotions_done": 0, "emotions_total": len(req.emotions), "current": None}
        _persist(job)
    threading.Thread(
        target=_do_commit,
        args=(job_id, req.character.strip(), req.emotions, req.character_id, statement),
        daemon=True).start()
    return {"status": "committing"}


@router.delete("/{job_id}")
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
