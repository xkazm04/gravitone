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
old jobs (and orphan workdirs) on a timer.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from service import ingest
from service.config import SETTINGS

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
_TTL = 60 * 30                     # jobs (and their workdirs) expire after 30 min
_GC_INTERVAL = 60 * 5             # background GC sweep cadence

# ── upload validation ─────────────────────────────────────────────────────────
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
MIN_CLIP_SECONDS = 3.0
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
    """Clip length via ffprobe; None when it can't be determined."""
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True)
    if r.returncode != 0:
        return None
    try:
        return float(r.stdout.decode(errors="ignore").strip())
    except ValueError:
        return None


# ── state persistence (all callers hold _LOCK) ────────────────────────────────
def _persist(job: dict) -> None:
    wd = Path(job["work_dir"])
    try:
        wd.mkdir(parents=True, exist_ok=True)
        tmp = wd / "state.json.tmp"
        tmp.write_text(json.dumps(job), "utf-8")
        tmp.replace(wd / "state.json")
    except OSError:
        pass


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
            try:
                sf.write_text(json.dumps(job), "utf-8")
            except OSError:
                pass
        JOBS[job["id"]] = job


def _gc_once() -> None:
    now = time.time()
    with _LOCK:
        for jid in [j for j, v in JOBS.items() if now - v.get("created", 0) > _TTL]:
            shutil.rmtree(JOBS[jid]["work_dir"], ignore_errors=True)
            JOBS.pop(jid, None)
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
        time.sleep(_GC_INTERVAL)
        try:
            _gc_once()
        except Exception:  # noqa: BLE001
            pass


# ── background phases ─────────────────────────────────────────────────────────
def _analyze(job_id: str, audio: Path) -> None:
    job = JOBS[job_id]
    analyze_fn = ingest.sovereign_analyze if job["mode"] == "sovereign" else ingest.analyze
    try:
        res = analyze_fn(
            audio, Path(job["work_dir"]),
            progress=lambda k, s: _mk_step(job, k, s),
            partial=lambda d: _partial(job, d))
        if not res.get("speakers"):
            raise RuntimeError("no speech detected in the clip")
        _update(job, speakers=res["speakers"], duration=res["duration"],
                status="awaiting_speaker")
    except Exception as exc:  # noqa: BLE001
        _update(job, status="error", error=str(exc)[:400])
    finally:
        audio.unlink(missing_ok=True)


def _label(job_id: str, target: str) -> None:
    job = JOBS[job_id]
    try:
        res = ingest.label_and_stem(
            Path(job["work_dir"]), target,
            progress=lambda k, s: _mk_step(job, k, s),
            partial=lambda d: _partial(job, d),
            mode=job["mode"])
        _update(job, result={"duration": job.get("duration", 0),
                             "speakers": [s["id"] for s in job.get("speakers", [])],
                             "mode": job["mode"], **res},
                status="done")
    except Exception as exc:  # noqa: BLE001
        _update(job, status="error", error=str(exc)[:400])


def _commit_progress(job: dict, done: int, total: int, current: str | None) -> None:
    with _LOCK:
        if job.get("cancel"):
            return
        job["partial"] = {"emotions_done": done, "emotions_total": total, "current": current}
        _persist(job)


def _do_commit(job_id: str, character: str, emotions: list[str], character_id: str | None) -> None:
    job = JOBS[job_id]
    total = len(emotions)

    def cancelled() -> bool:
        with _LOCK:
            return bool(job.get("cancel"))

    try:
        created = ingest.commit(
            Path(job["work_dir"]), character, emotions, character_id,
            progress=lambda done, cur: _commit_progress(job, done, total, cur),
            should_cancel=cancelled)
    except Exception as exc:  # noqa: BLE001
        _update(job, status="error", error=f"commit failed: {str(exc)[:300]}")
        return
    with _LOCK:
        if job.get("cancel"):
            return  # DELETE already set 'cancelled' and cleaned up
        job["committed"] = created
        job["partial"] = {"emotions_done": total, "emotions_total": total, "current": None}
        job["status"] = "committed"
        _persist(job)


# ── endpoints ─────────────────────────────────────────────────────────────────
@router.post("/scan")
async def start_scan(file: UploadFile = File(...), mode: str = Form("auto")) -> dict:
    if mode not in ("auto", "cloud", "sovereign"):
        raise HTTPException(400, "mode must be auto, cloud or sovereign")
    data = await file.read()
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

    dur = probe_duration(src)
    if dur is not None and dur < MIN_CLIP_SECONDS:
        shutil.rmtree(work_dir, ignore_errors=True)
        raise HTTPException(400, f"clip too short — record at least {MIN_CLIP_SECONDS:.0f} seconds of speech")

    job = {
        "id": job_id, "status": "running", "step": None, "mode": resolved,
        "steps": [{**s, "state": "pending"} for s in STEPS_BY_MODE[resolved]],
        "partial": {}, "speakers": None, "duration": 0, "result": None, "error": None,
        "work_dir": str(work_dir), "created": time.time(),
        "clip_sha256": hashlib.sha256(data).hexdigest(), "cancel": False,
        "committed": None}
    with _LOCK:
        JOBS[job_id] = job
        _persist(job)
    threading.Thread(target=_analyze, args=(job_id, src), daemon=True).start()
    return {"job_id": job_id, "mode": resolved}


_PUBLIC_KEYS = ("id", "status", "step", "steps", "partial", "speakers",
                "duration", "result", "error", "mode", "committed")


@router.get("/{job_id}")
def get_job(job_id: str):
    with _LOCK:
        job = JOBS.get(job_id)
        if not job:
            return JSONResponse({"status": "expired", "detail": "job not found or expired"},
                                status_code=404)
        return {k: job.get(k) for k in _PUBLIC_KEYS}


@router.get("/{job_id}/speaker-preview/{sid}")
def speaker_preview(job_id: str, sid: str) -> FileResponse:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    p = Path(job["work_dir"]) / f"speaker_{sid}.wav"
    if not p.is_file():
        raise HTTPException(404, "preview not found")
    return FileResponse(str(p), media_type="audio/wav")


class SpeakerReq(BaseModel):
    speaker_id: str


@router.post("/{job_id}/speaker")
def choose_speaker(job_id: str, req: SpeakerReq) -> dict:
    with _LOCK:
        job = JOBS.get(job_id)
        if not job:
            raise HTTPException(404, "job not found or expired")
        if job["status"] != "awaiting_speaker":
            raise HTTPException(409, "not awaiting speaker")
        job["status"] = "running"
        job["partial"] = {}
        _persist(job)
    threading.Thread(target=_label, args=(job_id, req.speaker_id), daemon=True).start()
    return {"status": "running"}


@router.get("/{job_id}/preview/{emotion}")
def preview(job_id: str, emotion: str) -> FileResponse:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    stem = Path(job["work_dir"]) / f"stem_{emotion}.wav"
    if not stem.is_file():
        raise HTTPException(404, "stem not found")
    return FileResponse(str(stem), media_type="audio/wav")


class CommitReq(BaseModel):
    character: str
    emotions: list[str]
    character_id: str | None = None


@router.post("/{job_id}/commit")
def commit(job_id: str, req: CommitReq):
    """Kick off cloning as a background phase and return immediately. Progress
    (emotions_done / total / current) streams via `partial`; the job ends
    'committed' or 'error'. Poll GET /{job} to follow it."""
    with _LOCK:
        job = JOBS.get(job_id)
        if not job:
            return JSONResponse({"status": "expired", "detail": "job not found or expired"},
                                status_code=404)
        if job["status"] != "done":
            raise HTTPException(409, "scan not finished")
        if not req.character.strip() and not req.character_id:
            raise HTTPException(400, "character name required")
        job["status"] = "committing"
        job["cancel"] = False
        job["committed"] = None
        job["partial"] = {"emotions_done": 0, "emotions_total": len(req.emotions), "current": None}
        _persist(job)
    threading.Thread(
        target=_do_commit,
        args=(job_id, req.character.strip(), req.emotions, req.character_id),
        daemon=True).start()
    return {"status": "committing"}


@router.delete("/{job_id}")
def cancel_job(job_id: str):
    """Cancel a job (between emotions during commit, between phases otherwise),
    mark it 'cancelled' and tear down its workdir."""
    with _LOCK:
        job = JOBS.get(job_id)
        if not job:
            return JSONResponse({"status": "expired", "detail": "job not found or expired"},
                                status_code=404)
        job["cancel"] = True
        job["status"] = "cancelled"
        work_dir = job["work_dir"]
        JOBS.pop(job_id, None)
    shutil.rmtree(work_dir, ignore_errors=True)
    return {"status": "cancelled"}


# ── startup: rehydrate persisted jobs + launch the GC timer ───────────────────
_rehydrate()
threading.Thread(target=_gc_loop, daemon=True).start()
