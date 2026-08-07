"""Re-voice jobs — the stateless door and the phase thread.

The door takes the source URL and the LINES (character_id, text, start, end)
rather than an ingest job id, deliberately:

  * the studio already holds the scene (GET /v1/ingest/{job}/scene hands it
    over, with timing since the sovereign-transcription work), and the user
    EDITS it there — the edited script is the real input, not the job;
  * ingest jobs are replica-affine and TTL'd; a re-voice should not die
    because the scan that produced its Characters aged out an hour ago.

Same job discipline as voiceover_api (def handlers, one phase thread, 429
admission, TTL GC, authored failures) — the registries stay separate because
their lifecycles are: a narration is one render, a re-voice may be re-run
line by line as the user punches in.

Steps: fetch → direct → speak → mux. `direct` is the brain assigning one
emotion per line from the Character's real stems (skippable, `direct:false`);
`speak` runs every line through revoice.fit_line's ladder and the fit report
is the product as much as the mp4 is.
"""
from __future__ import annotations

import json
import logging
import shutil
import threading
import time
import uuid
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from service import brain as brain_mod
from service import errors, frames, ingest_url, revoice, voiceover
from service.config import REPO_ROOT, _int, _str
from service.emotions import resolve
from service.voiceover_api import _engine_speak
from service.voices import emotion_map, prosody_map

logger = logging.getLogger("gravitone.revoice")

router = APIRouter()
RV = "/v1/revoice"

WORK_DIR = Path(_str("REVOICE_WORK_DIR", str(REPO_ROOT / "revoice_jobs")))
MAX_ACTIVE = _int("REVOICE_MAX_JOBS", 1)
MAX_LINES = _int("REVOICE_MAX_LINES", 200)
MAX_SECONDS = float(_str("REVOICE_MAX_SECONDS", "") or 900)

_TTL_S = 30 * 60
_RUNNING_TTL_S = 120 * 60

JOBS: dict[str, dict] = {}
_LOCK = threading.Lock()

STEPS = (("fetch", "fetching the video"),
         ("direct", "composing the emotional read"),
         ("speak", "re-performing every line"),
         ("mux", "assembling the re-voiced video"))

_PUBLIC_KEYS = ("id", "status", "step", "steps", "partial", "error", "source",
                "brain", "result", "limits", "options")

#: Stated on every job: what this pipeline does NOT preserve.
_LIMIT_BED = ("the original background (music, ambience) is not carried over "
              "— the output holds the new speech only; recovering the bed "
              "needs source separation, which this box does not do")


# ── registry plumbing (mirrors voiceover_api; small enough that sharing a
#    base would couple two lifecycles for ~60 lines of dict bookkeeping) ─────

def _new_job(source: dict, lines: list[dict], options: dict) -> dict:
    job_id = uuid.uuid4().hex[:12]
    wd = WORK_DIR / job_id
    wd.mkdir(parents=True, exist_ok=True)
    job = {"id": job_id, "status": "running", "step": "fetch",
           "steps": [{"key": k, "label": l, "state": "pending"}
                     for k, l in STEPS],
           "partial": {}, "error": None, "source": source, "lines": lines,
           "options": options, "brain": None, "result": None,
           "limits": [_LIMIT_BED],
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
            if (done and idle > _TTL_S) or age > _RUNNING_TTL_S:
                doomed.append(JOBS.pop(job["id"]))
    for job in doomed:
        shutil.rmtree(job["work_dir"], ignore_errors=True)


def _active() -> int:
    with _LOCK:
        return sum(1 for j in JOBS.values() if j["status"] == "running")


# ── the phase thread ──────────────────────────────────────────────────────────

_AUTHORED = (revoice.RevoiceError, voiceover.VoiceoverError,
             frames.FramesError, brain_mod.BrainError,
             ingest_url.LinkRefusal, errors.UserFacing)


def _run_job(job: dict) -> None:
    wd = Path(job["work_dir"])
    cancelled = lambda: bool(job.get("cancel"))  # noqa: E731
    lines = job["lines"]
    try:
        # ── fetch ─────────────────────────────────────────────────────────
        _step(job, "fetch", "active")
        video = ingest_url.download_video(job["source"]["url"], wd)
        meta = frames.probe_video(video)
        video_seconds = min(float(meta["duration"]), MAX_SECONDS)
        _partial(job, {"video": {"seconds": meta["duration"],
                                 "width": meta["width"],
                                 "height": meta["height"]}})
        _step(job, "fetch", "done")
        if cancelled():
            raise _Cancelled()

        # ── direct ────────────────────────────────────────────────────────
        _step(job, "direct", "active")
        emaps = {cid: emotion_map(cid)
                 for cid in {l["character_id"] for l in lines}}
        by_char = {cid: sorted(m) for cid, m in emaps.items()}
        mind = None
        if job["options"]["direct"] or job["options"]["rewrite"]:
            mind = brain_mod.make_brain()
            _update(job, brain=mind.describe())
        if job["options"]["direct"] and mind is not None:
            plan = mind.complete_json(
                revoice.direction_prompt(lines, by_char))
            revoice.apply_direction(lines, plan, by_char)
        else:
            for l in lines:
                l.setdefault("emotion", "baseline")
                l["emotion_requested"] = None
        _partial(job, {"directed": sum(1 for l in lines
                                       if l["emotion"] != "baseline")})
        _step(job, "direct", "done")
        if cancelled():
            raise _Cancelled()

        # ── speak (the fit ladder, per line) ─────────────────────────────
        _step(job, "speak", "active")
        pmaps = {cid: prosody_map(cid) for cid in emaps}
        fit_report: list[dict] = []
        for n, l in enumerate(lines):
            if cancelled():
                raise _Cancelled()
            _partial(job, {"spoken_done": n, "spoken_total": len(lines)})
            emap = emaps[l["character_id"]]
            voice_id, used, fell_back = resolve(l["emotion"], emap,
                                                prosody=pmaps[l["character_id"]])
            budget = float(l["end"]) - float(l["start"])
            rewriter = None
            if job["options"]["rewrite"] and mind is not None:
                rewriter = (lambda text, max_words, _m=mind:
                            _m.complete(revoice.rewrite_prompt(text, max_words),
                                        temperature=0.3))
            try:
                fitted = revoice.fit_line(
                    l["text"], budget,
                    speak=lambda t, _v=voice_id: _engine_speak(_v, t),
                    rewrite=rewriter)
            except Exception as exc:  # noqa: BLE001 - one line must not cost the video
                logger.warning("revoice line %s failed: %r", l["i"], exc)
                fit_report.append({"i": l["i"], "character_id": l["character_id"],
                                   "error": "this line could not be re-performed",
                                   "method": None, "budget_seconds": round(budget, 2)})
                continue
            l["wav"] = fitted["wav"]
            l["seconds"] = fitted["seconds"]
            fit_report.append({
                "i": l["i"], "character_id": l["character_id"],
                "emotion": used, "stem_fallback": bool(fell_back),
                "emotion_requested": l.get("emotion_requested"),
                "budget_seconds": round(budget, 2),
                "seconds": fitted["seconds"], "method": fitted["method"],
                "atempo": fitted["atempo"],
                "rewritten_text": fitted["rewritten_text"],
                "spill_seconds": fitted["spill_seconds"], "error": None})
        _step(job, "speak", "done")

        # ── mux ───────────────────────────────────────────────────────────
        _step(job, "mux", "active")
        placements = [{"i": l["i"], "start": float(l["start"]),
                       "end": float(l["end"])} for l in lines]
        track_lines = [{"scene": l["i"], "text": l["text"],
                        "emotion": l.get("emotion", "baseline"),
                        "wav": l.get("wav"), "seconds": l.get("seconds")}
                       for l in lines]
        track, _ = voiceover.build_track(track_lines, placements,
                                         video_seconds=video_seconds)
        (wd / "track.wav").write_bytes(track)
        (wd / "fit.json").write_text(json.dumps(fit_report), "utf-8")
        voiceover.mux(video, wd / "track.wav", wd / "revoiced.mp4")
        _step(job, "mux", "done")
        methods = [f.get("method") for f in fit_report]
        _update(job, status="done", result={
            "fit": fit_report,
            "summary": {
                "lines": len(fit_report),
                "verbatim": methods.count("verbatim"),
                "atempo": methods.count("atempo"),
                "rewritten": (methods.count("rewrite")
                              + methods.count("rewrite+atempo")),
                "spilling": sum(1 for f in fit_report
                                if f.get("spill_seconds")),
                "failed": sum(1 for f in fit_report if f.get("error")),
            }})
    except _Cancelled:
        logger.info("revoice job %s: abandoned (cancelled)", job["id"])
    except _AUTHORED as exc:
        _update(job, status="error", error=str(exc))
    except Exception as exc:  # noqa: BLE001 - the boundary; sanitize and log
        logger.exception("revoice job %s failed", job["id"])
        _update(job, status="error",
                error=errors.sanitize_detail("re-voicing this video", exc))


class _Cancelled(Exception):
    pass


# ── the door ──────────────────────────────────────────────────────────────────

class RevoiceLine(BaseModel):
    character_id: str
    text: str = Field(..., min_length=1, max_length=2000)
    start: float = Field(..., ge=0)
    end: float = Field(..., gt=0)
    emotion: str | None = None  # honoured when direct:false


class RevoiceReq(BaseModel):
    url: str
    lines: list[RevoiceLine] = Field(..., min_length=1, max_length=200)
    #: brain assigns one emotion per line (the composed emotional scale)
    direct: bool = True
    #: brain may shorten lines that cannot fit their slot (reported per line)
    rewrite: bool = True


@router.post(RV)
def start(req: RevoiceReq):
    """Re-voice a video from its (possibly edited) scene lines."""
    _gc()
    bad = [l for l in req.lines if l.end <= l.start]
    if bad:
        return JSONResponse(status_code=422, content={"detail": (
            "every line needs end > start — re-voicing places lines by "
            "their absolute timing (scan the video again if the scene "
            "carried none)")})
    missing = sorted({l.character_id for l in req.lines
                      if not emotion_map(l.character_id)})
    if missing:
        return JSONResponse(status_code=404, content={"detail": (
            f"unknown character(s): {', '.join(missing)}")})
    if req.direct or req.rewrite:
        try:
            brain_mod.make_brain()
        except brain_mod.BrainError as exc:
            return JSONResponse(status_code=400, content={"detail": str(exc)})
    try:
        url = ingest_url.guard_link(req.url)
        info = ingest_url.probe(url)
    except ingest_url.LinkRefusal as exc:
        return JSONResponse(status_code=exc.status,
                            content={"detail": exc.message})
    if info.duration is not None and info.duration > MAX_SECONDS:
        last = max(l.end for l in req.lines)
        if last > MAX_SECONDS:
            return JSONResponse(status_code=422, content={"detail": (
                f"lines reach {last:.0f}s but this box re-voices at most "
                f"the first {MAX_SECONDS:.0f} seconds of a video")})
    if _active() >= MAX_ACTIVE:
        return JSONResponse(status_code=429, headers={"Retry-After": "60"},
                            content={"detail": (
                                "this box is already re-voicing a video — "
                                "try again when it finishes")})
    lines = [{"i": i, "character_id": l.character_id, "text": l.text.strip(),
              "start": l.start, "end": l.end,
              "emotion": (l.emotion or "baseline")}
             for i, l in enumerate(req.lines)]
    job = _new_job({"kind": "url", "url": url, "title": info.title},
                   lines, {"direct": req.direct, "rewrite": req.rewrite})
    threading.Thread(target=_run_job, args=(job,),
                     name=f"revoice-{job['id']}", daemon=True).start()
    return {"job_id": job["id"], "source": job["source"],
            "lines": len(lines)}


# ── reading a job ─────────────────────────────────────────────────────────────

def _public(job: dict) -> dict:
    return {k: job.get(k) for k in _PUBLIC_KEYS}


@router.get(RV + "/{job_id}")
def status(job_id: str):
    job = _get(job_id)
    if job is None:
        return errors.job_expired()
    return _public(job)


def _artifact(job_id: str, name: str, media_type: str, missing: str):
    job = _get(job_id)
    if job is None:
        return errors.job_expired()
    path = Path(job["work_dir"]) / name
    if not path.is_file():
        return JSONResponse(status_code=409, content={"detail": missing})
    return FileResponse(path, media_type=media_type)


@router.get(RV + "/{job_id}/video")
def video(job_id: str):
    return _artifact(job_id, "revoiced.mp4", "video/mp4",
                     "the re-voiced video is not finished")


@router.get(RV + "/{job_id}/track")
def track(job_id: str):
    return _artifact(job_id, "track.wav", "audio/wav",
                     "the re-voiced track is not finished")


@router.delete(RV + "/{job_id}")
def cancel(job_id: str):
    job = _get(job_id)
    if job is None:
        return errors.job_expired()
    with _LOCK:
        job["cancel"] = True
        running = job["status"] == "running"
        if running:
            job["status"] = "cancelled"
        else:
            JOBS.pop(job_id, None)
    if not running:
        shutil.rmtree(job["work_dir"], ignore_errors=True)
    return {"status": "cancelled"}
