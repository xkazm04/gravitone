"""HTTP surface for the Character-ingestion flow.

  POST /v1/ingest/scan            (multipart file) → { job_id }   [starts async scan]
  GET  /v1/ingest/{job}           → { status, steps[], result }   [poll]
  GET  /v1/ingest/{job}/preview/{emotion}  → stem wav             [listen before accept]
  POST /v1/ingest/{job}/commit    { character, emotions[], character_id? } → created voices

Scan runs on a background thread; stem wavs live in a per-job temp dir until the
job is committed or expires. In-memory job store — fine for a single-node POC.
"""
from __future__ import annotations

import shutil
import tempfile
import threading
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from service import ingest

router = APIRouter(prefix="/v1/ingest", tags=["ingest"])

STEPS = [
    {"key": "transcribe", "label": "Transcribe & diarize"},
    {"key": "isolate", "label": "Isolate voice"},
    {"key": "label", "label": "Detect emotions"},
    {"key": "stem", "label": "Build emotion stems"},
]

JOBS: dict[str, dict] = {}
_TTL = 60 * 30  # 30 min


def _gc() -> None:
    now = time.time()
    for jid in [j for j, v in JOBS.items() if now - v["created"] > _TTL]:
        shutil.rmtree(JOBS[jid]["work_dir"], ignore_errors=True)
        JOBS.pop(jid, None)


def _run(job_id: str, audio: Path) -> None:
    job = JOBS[job_id]

    def progress(key: str, state: str) -> None:
        for s in job["steps"]:
            if s["key"] == key:
                s["state"] = state
        job["step"] = key

    try:
        res = ingest.scan(audio, Path(job["work_dir"]), progress=progress)
        job["result"] = res
        job["status"] = "done"
    except Exception as exc:  # noqa: BLE001
        job["status"] = "error"
        job["error"] = str(exc)[:400]
    finally:
        audio.unlink(missing_ok=True)


@router.post("/scan")
async def start_scan(file: UploadFile = File(...)) -> dict:
    _gc()
    job_id = uuid.uuid4().hex[:12]
    work_dir = Path(tempfile.mkdtemp(prefix=f"gvt-ingest-{job_id}-"))
    src = work_dir / f"src-{file.filename or 'upload'}"
    src.write_bytes(await file.read())
    JOBS[job_id] = {
        "id": job_id, "status": "running", "step": None,
        "steps": [{**s, "state": "pending"} for s in STEPS],
        "result": None, "error": None, "work_dir": str(work_dir), "created": time.time(),
    }
    threading.Thread(target=_run, args=(job_id, src), daemon=True).start()
    return {"job_id": job_id}


@router.get("/{job_id}")
def get_job(job_id: str) -> dict:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "job not found or expired")
    return {"id": job["id"], "status": job["status"], "step": job["step"],
            "steps": job["steps"], "result": job["result"], "error": job["error"]}


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
    character_id: str | None = None  # set to EXTEND an existing character


@router.post("/{job_id}/commit")
def commit(job_id: str, req: CommitReq) -> dict:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "job not found or expired")
    if job["status"] != "done":
        raise HTTPException(409, "scan not finished")
    if not req.character.strip() and not req.character_id:
        raise HTTPException(400, "character name required")
    try:
        created = ingest.commit(Path(job["work_dir"]), req.character.strip(),
                                req.emotions, req.character_id)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, f"commit failed: {exc}")
    # keep the job around (user may commit more emotions / extend), gc handles TTL
    return {"created": created}
