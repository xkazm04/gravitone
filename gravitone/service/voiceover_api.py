"""Voiceover jobs — the doors, the registry, the phase thread.

`voiceover.py` is the pure pipeline; this module gives it the same job
discipline ingest has, scaled to its simpler life:

  * JOBS is per-process and REPLICA-AFFINE, like ingest's (see
    deploy/README.md "Ingest is replica-affine"): poll the replica that
    answered the POST. Unlike ingest there is no restart rehydration — a
    voiceover is a render, not an hour of a user's curation; re-running it
    costs a click, so the honest TTL answer after a restart is "expired".
  * every handler is `def` (threadpool), the phase work runs on ONE thread
    per job, and admission is a bounded counter that answers 429 — never a
    queue.
  * failures reach the client as authored sentences; everything else is
    sanitized through `errors.sanitize_detail` and logged against the job.

The visual pass is key-gated CLOUD (frames leave the box for Qwen); the door
refuses up front when the key is missing rather than letting a job die three
minutes in. The text brain may be the local Claude CLI — `brain.make_brain`
decides, and its `describe()` is stamped on the job so a result always says
which mind wrote it.
"""
from __future__ import annotations

import json
import logging
import shutil
import sys
import threading
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from service import brain as brain_mod
from service import errors, frames, ingest_url, vision, voiceover
from service.config import REPO_ROOT, _int, _str
from service.emotions import resolve
from service.ingest import Spend
from service.voices import emotion_map, prosody_map

logger = logging.getLogger("gravitone.voiceover")

router = APIRouter()
VO = "/v1/voiceover"

WORK_DIR = Path(_str("VOICEOVER_WORK_DIR", str(REPO_ROOT / "voiceover_jobs")))
MAX_ACTIVE = _int("VOICEOVER_MAX_JOBS", 1)
MAX_SECONDS = float(_str("VOICEOVER_MAX_SECONDS", "") or 900)
MIN_SECONDS = 5.0
LINE_TIMEOUT_S = float(_str("VOICEOVER_LINE_TIMEOUT", "") or 120)

_TTL_S = 30 * 60          # idle terminal jobs
_RUNNING_TTL_S = 120 * 60  # a wedged run must not hold its slot forever

JOBS: dict[str, dict] = {}
_LOCK = threading.Lock()

STEPS = (("fetch", "fetching the video"),
         ("scenes", "cutting it into scenes"),
         ("look", "reading one frame per scene"),
         ("write", "writing the narration"),
         ("speak", "speaking it"),
         ("mux", "assembling the narrated video"))

_PUBLIC_KEYS = ("id", "status", "step", "steps", "partial", "error", "source",
                "character_id", "style", "language", "brain", "result",
                "limits")


# ── registry plumbing ─────────────────────────────────────────────────────────

def _new_job(source: dict, character_id: str, style: str,
             language: str) -> dict:
    job_id = uuid.uuid4().hex[:12]
    wd = WORK_DIR / job_id
    wd.mkdir(parents=True, exist_ok=True)
    job = {"id": job_id, "status": "running", "step": "fetch",
           "steps": [{"key": k, "label": l, "state": "pending"}
                     for k, l in STEPS],
           "partial": {}, "error": None, "source": source,
           "character_id": character_id, "style": style, "language": language,
           "brain": None, "result": None, "limits": [],
           "work_dir": str(wd), "cancel": False,
           "created": time.time(), "touched": time.time()}
    with _LOCK:
        JOBS[job_id] = job
    return job


def _get(job_id: str) -> dict | None:
    _gc()
    with _LOCK:
        job = JOBS.get(job_id)
        if job is not None:
            job["touched"] = time.time()
        return job


def _public(job: dict) -> dict:
    return {k: job.get(k) for k in _PUBLIC_KEYS}


def _update(job: dict, **fields) -> None:
    with _LOCK:
        job.update(fields)
        job["touched"] = time.time()


def _step(job: dict, key: str, state: str) -> None:
    with _LOCK:
        for s in job["steps"]:
            if s["key"] == key:
                s["state"] = state
        if state == "active":
            job["step"] = key


def _partial(job: dict, d: dict) -> None:
    with _LOCK:
        job["partial"].update(d)


def _gc() -> None:
    now = time.time()
    doomed: list[dict] = []
    with _LOCK:
        for job in list(JOBS.values()):
            idle = now - job["touched"]
            age = now - job["created"]
            done = job["status"] in ("done", "error", "cancelled")
            # `touched` keeps a watched job alive; `created` bounds a wedged
            # run even when a poller keeps touching it — a job that has been
            # "running" for two hours is not going to finish.
            if (done and idle > _TTL_S) or age > _RUNNING_TTL_S:
                doomed.append(JOBS.pop(job["id"]))
    for job in doomed:
        shutil.rmtree(job["work_dir"], ignore_errors=True)


def _active() -> int:
    with _LOCK:
        return sum(1 for j in JOBS.values() if j["status"] == "running")


def _busy() -> JSONResponse:
    return JSONResponse(status_code=429, headers={"Retry-After": "60"},
                        content={"detail": (
                            "this box is already narrating a video — try "
                            "again when it finishes")})


# ── the engine seam ───────────────────────────────────────────────────────────

def _engine_speak(voice_id: str, text: str) -> tuple[bytes, float]:
    """Same sys.modules seam as ingest._engine_synthesize, same reason: this
    module is imported BY app.py, and a test process has no engine at all."""
    app = sys.modules.get("service.app")
    engine = getattr(app, "ENGINE", None) if app is not None else None
    # `ready` is a PROPERTY on TtsEngine (engine.py) but tests hand in doubles
    # with a method — accept both, refuse neither silently.
    ready = getattr(engine, "ready", False) if engine is not None else False
    if engine is None or not (ready() if callable(ready) else bool(ready)):
        raise voiceover.VoiceoverError(
            "no synthesis engine is running in this process")
    j = engine.submit(voice_id, text)
    r = j.future.result(timeout=LINE_TIMEOUT_S)
    return r.wav_bytes, r.audio_seconds


# ── the phase thread ──────────────────────────────────────────────────────────

_AUTHORED = (voiceover.VoiceoverError, frames.FramesError, vision.VisionError,
             brain_mod.BrainError, ingest_url.LinkRefusal, errors.UserFacing)


def _run_job(job: dict) -> None:
    wd = Path(job["work_dir"])
    cancelled = lambda: bool(job.get("cancel"))  # noqa: E731
    try:
        mind = brain_mod.make_brain()
        _update(job, brain=mind.describe())

        # ── fetch ─────────────────────────────────────────────────────────
        _step(job, "fetch", "active")
        src = job["source"]
        if src["kind"] == "url":
            video = ingest_url.download_video(
                src["url"], wd, trim_seconds=(MAX_SECONDS
                                              if src.get("trimmed") else None))
        else:
            video = Path(src["path"])
        meta = frames.probe_video(video)
        video_seconds = min(float(meta["duration"]), MAX_SECONDS)
        _partial(job, {"video": {"seconds": meta["duration"],
                                 "width": meta["width"],
                                 "height": meta["height"]}})
        _step(job, "fetch", "done")
        if cancelled():
            raise _Cancelled()

        # ── scenes ────────────────────────────────────────────────────────
        _step(job, "scenes", "active")
        scene_objs = frames.detect_scenes(video, duration=video_seconds,
                                          should_cancel=cancelled)
        frames.capture_frames(video, scene_objs, wd / "frames",
                              should_cancel=cancelled)
        scenes = [dict(s.public(), frame=(str(s.frame) if s.frame else None))
                  for s in scene_objs]
        (wd / "scenes.json").write_text(json.dumps(
            [s.public() for s in scene_objs]), "utf-8")
        _partial(job, {"scenes": len(scenes),
                       "frames": sum(1 for s in scenes if s["frame"])})
        _step(job, "scenes", "done")
        if cancelled():
            raise _Cancelled()

        # ── look ──────────────────────────────────────────────────────────
        _step(job, "look", "active")
        spend = Spend()
        described = vision.describe_scenes(scenes, context=src.get("title", ""),
                                           spend=spend, should_cancel=cancelled)
        for s, d in zip(scenes, described):
            s["description"] = d
        blind = sum(1 for d in described if d is None)
        if blind == len(scenes):
            raise voiceover.VoiceoverError(
                "none of this video's scenes could be described — the vision "
                "pass failed for all of them; see the service log")
        if blind:
            job["limits"].append(f"{blind} of {len(scenes)} scenes could not "
                                 "be described and were narrated blind")
        _partial(job, {"described": len(scenes) - blind,
                       "spend": spend.snapshot()})
        _step(job, "look", "done")
        if cancelled():
            raise _Cancelled()

        # ── write ─────────────────────────────────────────────────────────
        _step(job, "write", "active")
        emotions = sorted(emotion_map(job["character_id"]))
        prompt = voiceover.script_prompt(scenes, emotions=emotions,
                                         style=job["style"],
                                         language=job["language"])
        plan = mind.complete_json(prompt)
        lines = voiceover.clean_script(plan, scenes, emotions=emotions)
        _partial(job, {"lines": sum(1 for l in lines if l["text"]),
                       "words": sum(l["words"] for l in lines)})
        _step(job, "write", "done")
        if cancelled():
            raise _Cancelled()

        # ── speak ─────────────────────────────────────────────────────────
        _step(job, "speak", "active")
        emap = emotion_map(job["character_id"])
        pmap = prosody_map(job["character_id"])
        voiceover.synthesize_lines(
            lines, speak=_engine_speak,
            resolve_voice=lambda emo: resolve(emo, emap, prosody=pmap),
            should_cancel=cancelled,
            progress=lambda n, total: _partial(
                job, {"spoken_done": n, "spoken_total": total}))
        _step(job, "speak", "done")
        if cancelled():
            raise _Cancelled()

        # ── mux ───────────────────────────────────────────────────────────
        _step(job, "mux", "active")
        track, fit = voiceover.build_track(lines, scenes,
                                           video_seconds=video_seconds)
        (wd / "track.wav").write_bytes(track)
        voiceover.dump_script(wd / "script.json", lines)
        voiceover.mux(video, wd / "track.wav", wd / "narrated.mp4")
        _step(job, "mux", "done")
        _update(job, status="done",
                result={"summary": voiceover.summarize(fit), "fit": fit})
    except _Cancelled:
        logger.info("voiceover job %s: abandoned (cancelled)", job["id"])
    except _AUTHORED as exc:
        _update(job, status="error", error=str(exc))
    except Exception as exc:  # noqa: BLE001 - the boundary; sanitize and log
        logger.exception("voiceover job %s failed", job["id"])
        _update(job, status="error",
                error=errors.sanitize_detail("narrating this video", exc))


class _Cancelled(Exception):
    pass


# ── the doors ─────────────────────────────────────────────────────────────────

def _refuse_unready(character_id: str) -> JSONResponse | None:
    """Everything that would kill the job minutes in, checked at the door."""
    if not vision.available():
        return JSONResponse(status_code=400, content={"detail": (
            "the visual pass needs QWEN_API_KEY (or DASHSCOPE_API_KEY) — "
            "voiceover reads the video's frames through Qwen")})
    try:
        brain_mod.make_brain()
    except brain_mod.BrainError as exc:
        return JSONResponse(status_code=400, content={"detail": str(exc)})
    if not emotion_map(character_id):
        return JSONResponse(status_code=404, content={"detail": (
            f"unknown character '{character_id}'")})
    return None


class FromUrlReq(BaseModel):
    url: str
    character_id: str
    style: str = Field("", max_length=2000)
    language: str = Field("", max_length=40)


@router.post(VO + "/from-url")
def from_url(req: FromUrlReq):
    """Narrate a linked video. `def` on purpose: the probe shells out."""
    _gc()
    refused = _refuse_unready(req.character_id)
    if refused is not None:
        return refused
    try:
        url = ingest_url.guard_link(req.url)
        info = ingest_url.probe(url)
    except ingest_url.LinkRefusal as exc:
        return JSONResponse(status_code=exc.status,
                            content={"detail": exc.message})
    if info.duration is None:
        return JSONResponse(status_code=422, content={"detail": (
            "couldn't read how long that video is")})
    if info.duration < MIN_SECONDS:
        return JSONResponse(status_code=422, content={"detail": (
            f"that video is under {MIN_SECONDS:.0f} seconds — there is "
            "nothing to narrate")})
    if _active() >= MAX_ACTIVE:
        return _busy()
    trimmed = info.duration > MAX_SECONDS
    job = _new_job({"kind": "url", "url": url, "title": info.title,
                    "trimmed": trimmed,
                    "clip_seconds": min(info.duration, MAX_SECONDS)},
                   req.character_id, req.style, req.language)
    threading.Thread(target=_run_job, args=(job,),
                     name=f"voiceover-{job['id']}", daemon=True).start()
    return {"job_id": job["id"], "source": job["source"]}


@router.post(VO + "/upload")
def upload(video: UploadFile = File(...), character_id: str = Form(...),
           style: str = Form(""), language: str = Form("")):
    """Narrate the creator's own footage. Streamed to disk under the video
    byte cap — never read whole into memory."""
    _gc()
    refused = _refuse_unready(character_id)
    if refused is not None:
        return refused
    if _active() >= MAX_ACTIVE:
        return _busy()
    job = _new_job({"kind": "upload",
                    "title": video.filename or "uploaded video"},
                   character_id, style, language)
    wd = Path(job["work_dir"])
    dst = wd / "upload-src.bin"
    cap = ingest_url.VIDEO_MAX_BYTES
    written = 0
    with dst.open("wb") as out:
        while True:
            chunk = video.file.read(1 << 20)
            if not chunk:
                break
            written += len(chunk)
            if written > cap:
                out.close()
                shutil.rmtree(wd, ignore_errors=True)
                with _LOCK:
                    JOBS.pop(job["id"], None)
                return JSONResponse(status_code=413, content={"detail": (
                    f"that file is over the {cap // (1024 * 1024)} MB "
                    "ceiling for uploaded video")})
            out.write(chunk)
    job["source"]["path"] = str(dst)
    threading.Thread(target=_run_job, args=(job,),
                     name=f"voiceover-{job['id']}", daemon=True).start()
    return {"job_id": job["id"], "source": {"kind": "upload",
                                            "title": job["source"]["title"]}}


# ── reading a job ─────────────────────────────────────────────────────────────

@router.get(VO + "/{job_id}")
def status(job_id: str):
    job = _get(job_id)
    if job is None:
        return errors.job_expired()
    return _public(job)


def _artifact(job_id: str, name: str, media_type: str,
              missing: str) -> FileResponse | JSONResponse:
    job = _get(job_id)
    if job is None:
        return errors.job_expired()
    path = Path(job["work_dir"]) / name
    if not path.is_file():
        return JSONResponse(status_code=409, content={"detail": missing})
    return FileResponse(path, media_type=media_type)


@router.get(VO + "/{job_id}/video")
def video(job_id: str):
    return _artifact(job_id, "narrated.mp4", "video/mp4",
                     "the narrated video is not finished")


@router.get(VO + "/{job_id}/track")
def track(job_id: str):
    return _artifact(job_id, "track.wav", "audio/wav",
                     "the narration track is not finished")


@router.get(VO + "/{job_id}/script")
def script(job_id: str):
    return _artifact(job_id, "script.json", "application/json",
                     "the narration script has not been written yet")


@router.get(VO + "/{job_id}/frame/{i}")
def frame(job_id: str, i: int):
    job = _get(job_id)
    if job is None:
        return errors.job_expired()
    path = Path(job["work_dir"]) / "frames" / f"scene_{i:03d}.jpg"
    if not path.is_file():
        return JSONResponse(status_code=404, content={"detail": (
            "this scene has no readable frame")})
    return FileResponse(path, media_type="image/jpeg")


@router.delete(VO + "/{job_id}")
def cancel(job_id: str):
    job = _get(job_id)
    if job is None:
        return errors.job_expired()
    with _LOCK:
        job["cancel"] = True
        running = job["status"] == "running"
        if running:
            # the phase thread sees the flag at its next boundary and stops;
            # its workdir is reclaimed by _gc, not yanked from under it.
            job["status"] = "cancelled"
        else:
            JOBS.pop(job_id, None)
    if not running:
        shutil.rmtree(job["work_dir"], ignore_errors=True)
    return {"status": "cancelled"}
