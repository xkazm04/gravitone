"""Scene segmentation and frame capture — the studio's eyes, locally.

The visual pipeline's unit of meaning is the SCENE, not the frame: voiceover
is written per short scene (5-30 s), and one representative frame per scene is
enough to know what is going on in it. Frame-by-frame harvesting exists to
solve lip sync, which is an explicit non-goal — so it is not built.

Everything here is ffmpeg/ffprobe subprocess work on a video file that is
already on disk (`ingest_url.download_video`). Nothing leaves the machine;
what the frames are FOR (the cloud vision pass in `vision.py`) is a separate,
key-gated decision made by the caller.

Doctrine notes, same as the rest of the service:
  * blocking subprocess calls — run this on a worker thread, never on the loop.
  * stderr from the tools is logged, never put in a response body.
  * degraded outcomes are named: a video whose scene detector found no cuts is
    ONE scene, not an error; a frame that failed to extract is a scene without
    a picture, not a failed job.
"""
from __future__ import annotations

import json
import logging
import os
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

logger = logging.getLogger("gravitone.frames")

#: Scene length bounds. Shorter than MIN_SCENE_S reads as a jump cut and is
#: merged into its neighbour; longer than MAX_SCENE_S is split, because a
#: narration plan needs a beat at least every half minute.
MIN_SCENE_S = float(os.environ.get("FRAMES_MIN_SCENE_S", "") or 5.0)
MAX_SCENE_S = float(os.environ.get("FRAMES_MAX_SCENE_S", "") or 30.0)

#: ffmpeg's scene-change score threshold (0-1). 0.3 is the community default
#: for hard cuts; lower splits on gentler transitions.
SCENE_THRESHOLD = float(os.environ.get("FRAMES_SCENE_THRESHOLD", "") or 0.3)

#: Extracted frame size/quality. 360 px tall is plenty for "what is going on
#: in this shot" and keeps the vision payloads small.
FRAME_HEIGHT = int(os.environ.get("FRAMES_HEIGHT", "") or 360)
FRAME_QUALITY = int(os.environ.get("FRAMES_JPEG_Q", "") or 3)

#: Wall-clock ceilings. Detection decodes the whole video once (roughly
#: realtime at 480p on CPU); capture seeks by keyframe and is near-instant.
DETECT_TIMEOUT_S = float(os.environ.get("FRAMES_DETECT_TIMEOUT", "") or 600)
CAPTURE_TIMEOUT_S = float(os.environ.get("FRAMES_CAPTURE_TIMEOUT", "") or 30)

_run = subprocess.run  # the test seam, same convention as ingest_url

_PTS_RE = re.compile(r"pts_time:\s*([0-9]+(?:\.[0-9]+)?)")


class FramesError(RuntimeError):
    """A named, user-safe failure — the message carries no tool output."""


@dataclass
class Scene:
    """One scene: where it sits, and (after capture) its one picture."""
    i: int
    start: float
    end: float
    frame: Path | None = None
    #: why there is no picture, when there is none. Never a silent None.
    frame_error: str | None = None

    @property
    def dur(self) -> float:
        return round(self.end - self.start, 3)

    def public(self) -> dict:
        """The JSON shape jobs persist and serve. Paths stay on the box —
        the route that serves a frame addresses it by scene index."""
        return {"i": self.i, "start": round(self.start, 2),
                "end": round(self.end, 2), "dur": self.dur,
                "has_frame": self.frame is not None,
                "frame_error": self.frame_error}


def probe_video(video: Path) -> dict:
    """Duration + geometry via ffprobe. Raises `FramesError` when the file is
    not something ffmpeg can read as video."""
    cmd = ["ffprobe", "-v", "error", "-select_streams", "v:0",
           "-show_entries", "stream=width,height,avg_frame_rate:format=duration",
           "-of", "json", str(video)]
    try:
        r = _run(cmd, capture_output=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as exc:
        logger.error("ffprobe failed for %s: %s", video.name, exc)
        raise FramesError("this video could not be inspected")
    if r.returncode != 0:
        logger.warning("ffprobe refused %s: %s", video.name,
                       (r.stderr or b"")[-400:])
        raise FramesError("this file does not contain a readable video stream")
    try:
        meta = json.loads(r.stdout or b"{}")
        stream = (meta.get("streams") or [{}])[0]
        duration = float((meta.get("format") or {}).get("duration") or 0.0)
    except (ValueError, TypeError, IndexError):
        raise FramesError("this video's details could not be read")
    if duration <= 0:
        raise FramesError("this video reports no duration")
    return {"duration": round(duration, 3),
            "width": int(stream.get("width") or 0),
            "height": int(stream.get("height") or 0)}


def detect_scenes(video: Path, *, duration: float | None = None,
                  min_s: float = MIN_SCENE_S, max_s: float = MAX_SCENE_S,
                  threshold: float = SCENE_THRESHOLD,
                  should_cancel: Callable[[], bool] | None = None) -> list[Scene]:
    """Cut timestamps → scenes bounded to [min_s, max_s].

    A video with no detected cuts is ONE scene (split to max_s) — a static
    talking-head video is a perfectly good subject that simply has no cuts.
    """
    if duration is None:
        duration = probe_video(video)["duration"]
    cuts = _detect_cuts(video, threshold=threshold)
    if should_cancel and should_cancel():
        return []
    bounds = _coalesce([0.0, *cuts, float(duration)], min_s=min_s, max_s=max_s)
    return [Scene(i=i, start=round(a, 3), end=round(b, 3))
            for i, (a, b) in enumerate(zip(bounds, bounds[1:]))]


def _detect_cuts(video: Path, *, threshold: float) -> list[float]:
    cmd = ["ffmpeg", "-hide_banner", "-nostats", "-i", str(video),
           "-vf", f"select='gt(scene,{threshold})',showinfo",
           "-f", "null", "-"]
    try:
        r = _run(cmd, capture_output=True, timeout=DETECT_TIMEOUT_S)
    except (OSError, subprocess.TimeoutExpired) as exc:
        logger.error("scene detection failed for %s: %s", video.name, exc)
        raise FramesError("scene detection took too long or could not run")
    if r.returncode != 0:
        logger.warning("scene detection refused %s: %s", video.name,
                       (r.stderr or b"")[-400:])
        raise FramesError("this video could not be scanned for scene changes")
    err = (r.stderr or b"").decode("utf-8", "replace")
    return sorted({float(m) for m in _PTS_RE.findall(err)})


def _coalesce(bounds: list[float], *, min_s: float, max_s: float) -> list[float]:
    """Boundaries → boundaries honouring the scene length contract.

    Merge first (drop any cut that would leave a fragment under `min_s`),
    then split (insert even boundaries into any stretch over `max_s`). Order
    matters: splitting first would re-create the fragments merging removes.
    """
    uniq = sorted({round(b, 3) for b in bounds})
    if len(uniq) < 2:
        return uniq
    merged = [uniq[0]]
    for b in uniq[1:-1]:
        if b - merged[-1] >= min_s and uniq[-1] - b >= min_s:
            merged.append(b)
    merged.append(uniq[-1])
    out: list[float] = [merged[0]]
    for a, b in zip(merged, merged[1:]):
        span = b - a
        if span > max_s:
            pieces = int(span // max_s) + (1 if span % max_s else 0)
            step = span / pieces
            out.extend(round(a + step * k, 3) for k in range(1, pieces))
        out.append(b)
    return out


def capture_frames(video: Path, scenes: list[Scene], dest: Path, *,
                   height: int = FRAME_HEIGHT, quality: int = FRAME_QUALITY,
                   should_cancel: Callable[[], bool] | None = None) -> list[Scene]:
    """One JPEG per scene, at its midpoint. Mutates and returns `scenes`.

    A frame that fails to extract degrades THAT scene (`frame_error` names it)
    and the loop continues — one unreadable stretch of video must not cost the
    caller every other scene's picture.
    """
    dest.mkdir(parents=True, exist_ok=True)
    for s in scenes:
        if should_cancel and should_cancel():
            break
        mid = s.start + (s.end - s.start) / 2.0
        out = dest / f"scene_{s.i:03d}.jpg"
        cmd = ["ffmpeg", "-y", "-v", "error", "-ss", f"{mid:.3f}",
               "-i", str(video), "-frames:v", "1", "-q:v", str(quality),
               "-vf", f"scale=-2:{height}", str(out)]
        try:
            r = _run(cmd, capture_output=True, timeout=CAPTURE_TIMEOUT_S)
        except (OSError, subprocess.TimeoutExpired) as exc:
            logger.warning("frame capture failed at %.1fs of %s: %s",
                           mid, video.name, exc)
            s.frame_error = "frame extraction timed out"
            continue
        if r.returncode != 0 or not out.is_file() or out.stat().st_size == 0:
            logger.warning("frame capture refused at %.1fs of %s: %s",
                           mid, video.name, (r.stderr or b"")[-300:])
            out.unlink(missing_ok=True)
            s.frame_error = "no frame could be read at this scene's midpoint"
            continue
        s.frame = out
    return scenes
