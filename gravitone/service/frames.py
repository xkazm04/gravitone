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
import tempfile
import time
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

#: Wall-clock ceilings. Detection decodes what it is asked to analyse once
#: (roughly realtime at 480p on CPU); capture seeks by keyframe and is
#: near-instant. A single constant ceiling made a long video RACE the clock
#: instead of failing predictably, so detection's budget is now derived from
#: the length it was asked to analyse: SPEED_FACTOR wall-clock seconds per
#: video second, floored so a short video still gets room to start ffmpeg, and
#: capped by DETECT_TIMEOUT_S so nothing ever waits longer than it used to.
DETECT_TIMEOUT_S = float(os.environ.get("FRAMES_DETECT_TIMEOUT", "") or 600)
DETECT_MIN_TIMEOUT_S = float(os.environ.get("FRAMES_DETECT_MIN_TIMEOUT", "")
                             or 120)
DETECT_SPEED_FACTOR = float(os.environ.get("FRAMES_DETECT_SPEED_FACTOR", "")
                            or 4.0)
#: How often the detect pass looks up to ask "still wanted?".
DETECT_POLL_S = float(os.environ.get("FRAMES_DETECT_POLL", "") or 0.5)
CAPTURE_TIMEOUT_S = float(os.environ.get("FRAMES_CAPTURE_TIMEOUT", "") or 30)

#: Visual signature: the same captured frame, also written out as a tiny
#: grayscale raster (SIG_GRID²  bytes) by a SECOND output of the SAME ffmpeg
#: invocation. No new dependency and no extra process — the pixels are already
#: decoded, we just ask for a thumbnail of them too, and the arithmetic over
#: 256 bytes is plain Python.
SIG_GRID = int(os.environ.get("FRAMES_SIG_GRID", "") or 16)

#: When two consecutive frames count as THE SAME SHOT. Deliberately mean:
#: a false reuse narrates a scene from the wrong picture, a missed reuse costs
#: one vision call, so the thresholds are set to pay. Both must hold —
#: average difference under SIG_MEAN_MAX of 255 (≈1%, i.e. grain and a small
#: talking head's motion), and at most SIG_CELL_MAX cells moving more than
#: SIG_CELL_DELTA (so a whole new object entering a corner blocks reuse even
#: when the frame average barely moves).
SIG_MEAN_MAX = float(os.environ.get("FRAMES_SIG_MEAN_MAX", "") or 3.0)
SIG_CELL_DELTA = int(os.environ.get("FRAMES_SIG_CELL_DELTA", "") or 24)
SIG_CELL_MAX = int(os.environ.get("FRAMES_SIG_CELL_MAX", "") or 4)

_run = subprocess.run  # the test seam, same convention as ingest_url
#: detection's own seam. It cannot use `_run`: a blocking `subprocess.run`
#: cannot be interrupted, and a cancelled job must not wait out a pass nobody
#: wants any more.
_popen = subprocess.Popen

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
    #: the tiny grayscale raster this scene's frame reduces to. On-box only.
    signature: bytes | None = field(default=None, repr=False)
    #: the index of the earlier scene whose frame is the SAME SHOT as this
    #: one, when there is one. A downstream pass may describe this scene by
    #: inheriting that one's description instead of buying a new look — but
    #: only if it says so; an inherited description is not an observation.
    repeat_of: int | None = None

    @property
    def dur(self) -> float:
        return round(self.end - self.start, 3)

    def public(self) -> dict:
        """The JSON shape jobs persist and serve. Paths stay on the box —
        the route that serves a frame addresses it by scene index."""
        return {"i": self.i, "start": round(self.start, 2),
                "end": round(self.end, 2), "dur": self.dur,
                "has_frame": self.frame is not None,
                "frame_error": self.frame_error,
                "repeat_of": self.repeat_of}


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

    `duration` is a BUDGET, not a hint: detection analyses only that many
    seconds of the file. The caller's ceiling (voiceover's MAX_SECONDS) is
    already folded into it, and every scene past it would be discarded by
    `_coalesce` anyway — so decoding a three-hour upload to find cuts in
    footage nobody will narrate is pure waste, and it is that waste that made
    a long video race a constant timeout.

    Cancelling kills the pass: `should_cancel` is polled while ffmpeg runs,
    not only after it returns, and a cancelled detection returns no scenes.
    """
    if duration is None:
        duration = probe_video(video)["duration"]
    cuts = _detect_cuts(video, threshold=threshold, limit_s=float(duration),
                        should_cancel=should_cancel)
    if cuts is None or (should_cancel and should_cancel()):
        return []
    bounds = _coalesce([0.0, *cuts, float(duration)], min_s=min_s, max_s=max_s)
    return [Scene(i=i, start=round(a, 3), end=round(b, 3))
            for i, (a, b) in enumerate(zip(bounds, bounds[1:]))]


def detect_budget_s(analysed_s: float | None) -> float:
    """Wall-clock a detect pass over `analysed_s` seconds of video may take."""
    if not analysed_s or analysed_s <= 0:
        return DETECT_TIMEOUT_S
    return max(DETECT_MIN_TIMEOUT_S,
               min(DETECT_TIMEOUT_S, analysed_s * DETECT_SPEED_FACTOR))


class _DetectTimeout(Exception):
    """Internal: the pass outlived its budget and was killed."""


def _detect_cuts(video: Path, *, threshold: float,
                 limit_s: float | None = None,
                 should_cancel: Callable[[], bool] | None = None
                 ) -> list[float] | None:
    """Cut timestamps, or None when the caller cancelled mid-pass."""
    cmd = ["ffmpeg", "-hide_banner", "-nostats", "-i", str(video)]
    if limit_s and limit_s > 0:
        cmd += ["-t", f"{limit_s:.3f}"]
    cmd += ["-vf", f"select='gt(scene,{threshold})',showinfo",
            "-f", "null", "-"]
    budget = detect_budget_s(limit_s)
    try:
        got = _watch(cmd, budget_s=budget, should_cancel=should_cancel)
    except _DetectTimeout:
        logger.error("scene detection outlived %.0fs on %.0fs of %s",
                     budget, limit_s or 0.0, video.name)
        raise FramesError(
            f"scene detection did not finish within {budget:.0f} seconds on "
            f"the first {limit_s or 0.0:.0f} seconds of this video — it is "
            "too heavy to scan on this box")
    except OSError as exc:
        logger.error("scene detection could not run for %s: %s",
                     video.name, exc)
        raise FramesError("scene detection could not be started")
    if got is None:
        logger.info("scene detection abandoned for %s (cancelled)", video.name)
        return None
    rc, err = got
    if rc != 0:
        logger.warning("scene detection refused %s: %s", video.name,
                       err[-400:])
        raise FramesError("this video could not be scanned for scene changes")
    text = err.decode("utf-8", "replace")
    return sorted({float(m) for m in _PTS_RE.findall(text)})


def _watch(cmd: list[str], *, budget_s: float,
           should_cancel: Callable[[], bool] | None
           ) -> tuple[int, bytes] | None:
    """Run `cmd`, polling for cancellation, and KILL it when it is not wanted
    or has outlived `budget_s`. Returns (returncode, stderr) or None when the
    caller cancelled. Raises `_DetectTimeout` on the budget.

    stderr goes to a temp file rather than a pipe on purpose: showinfo writes
    one line per cut, and a pipe nobody drains while polling is a deadlock.
    """
    with tempfile.TemporaryFile() as err:
        proc = _popen(cmd, stdin=subprocess.DEVNULL,
                      stdout=subprocess.DEVNULL, stderr=err)
        deadline = time.monotonic() + budget_s
        while True:
            try:
                proc.wait(timeout=DETECT_POLL_S)
                break
            except subprocess.TimeoutExpired:
                pass
            if should_cancel and should_cancel():
                _kill(proc)
                return None
            if time.monotonic() >= deadline:
                _kill(proc)
                raise _DetectTimeout()
        err.seek(0)
        return proc.returncode, err.read()


def _kill(proc) -> None:
    """Stop a pass we no longer want, and do not leave a zombie behind."""
    try:
        proc.kill()
        proc.wait(timeout=10)
    except Exception:  # noqa: BLE001 - a dead process is the goal, not a crash
        logger.warning("could not reap the scene detection process")


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

    The same invocation also emits a tiny grayscale raster of the frame on
    stdout; `mark_repeats` uses it to tell consecutive scenes that are the
    same shot from ones that are not.
    """
    dest.mkdir(parents=True, exist_ok=True)
    for s in scenes:
        if should_cancel and should_cancel():
            break
        mid = s.start + (s.end - s.start) / 2.0
        out = dest / f"scene_{s.i:03d}.jpg"
        cmd = ["ffmpeg", "-y", "-v", "error", "-ss", f"{mid:.3f}",
               "-i", str(video), "-frames:v", "1", "-q:v", str(quality),
               "-vf", f"scale=-2:{height}", str(out),
               # second output, same decode: the signature raster
               "-frames:v", "1", "-vf", f"scale={SIG_GRID}:{SIG_GRID}",
               "-pix_fmt", "gray", "-f", "rawvideo", "-"]
        try:
            r = _run(cmd, capture_output=True, timeout=CAPTURE_TIMEOUT_S)
        except (OSError, subprocess.TimeoutExpired) as exc:
            logger.warning("frame capture failed at %.1fs of %s: %s",
                           mid, video.name, exc)
            s.frame_error = "frame extraction timed out"
            continue
        # A written, non-empty JPEG is a usable picture even if the second
        # output upset the tool — the picture is the product, the signature is
        # an optimisation, and losing the optimisation must not lose the shot.
        if not out.is_file() or out.stat().st_size == 0:
            logger.warning("frame capture refused at %.1fs of %s: %s",
                           mid, video.name, (r.stderr or b"")[-300:])
            out.unlink(missing_ok=True)
            s.frame_error = "no frame could be read at this scene's midpoint"
            continue
        if r.returncode != 0:
            logger.warning("frame capture at %.1fs of %s wrote a picture but "
                           "returned %s: %s", mid, video.name, r.returncode,
                           (r.stderr or b"")[-300:])
        s.frame = out
        s.signature = _signature(getattr(r, "stdout", None))
    return mark_repeats(scenes)


# ── same shot, or a new one ───────────────────────────────────────────────────

def _signature(raw: bytes | None) -> bytes | None:
    """The raster ffmpeg wrote on stdout, or None when there isn't one.

    None is not "identical" and not "different" — it is "unknown", and every
    caller treats unknown as a reason to pay for a fresh look.
    """
    want = SIG_GRID * SIG_GRID
    if not raw or len(raw) < want:
        return None
    return bytes(raw[:want])


def frames_similar(a: bytes | None, b: bytes | None) -> bool:
    """Whether two signatures are the same shot. Unknown is never the same."""
    if not a or not b or len(a) != len(b):
        return False
    total = 0
    loud = 0
    for x, y in zip(a, b):
        d = x - y if x > y else y - x
        total += d
        if d > SIG_CELL_DELTA:
            loud += 1
            if loud > SIG_CELL_MAX:
                return False
    return total / len(a) <= SIG_MEAN_MAX


def mark_repeats(scenes: list[Scene]) -> list[Scene]:
    """Stamp `repeat_of` on every scene that shows the same shot as the last
    scene that did NOT repeat. Mutates and returns `scenes`.

    Compared against the ANCHOR rather than the immediate predecessor on
    purpose: chaining "each 1% different from the last" over thirty scenes
    drifts a long way from the picture whose description would be inherited.
    A scene with no signature breaks the run and becomes the next anchor
    candidate — unknown is never a match.
    """
    anchor: Scene | None = None
    for s in scenes:
        s.repeat_of = None
        if s.frame is None or s.signature is None:
            anchor = None
            continue
        if anchor is not None and frames_similar(anchor.signature, s.signature):
            s.repeat_of = anchor.i
        else:
            anchor = s
    return scenes
