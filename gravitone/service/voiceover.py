"""Silent-video voiceover — scenes in, a narrated video out.

The creator feature: a video with no usable audio (screen capture, drone
footage, b-roll) plus one Character = a finished narration track and a muxed
mp4. The pipeline thinks in SCENES (frames.py's 5-30 s beats): Qwen describes
each scene's one frame, the text brain writes one narration line per scene
against a spoken-word budget, the engine speaks each line in the Character's
own emotion stems, and the track is assembled at scene starts.

What this module is: the PURE middle of that pipeline — planning, budgeting,
track assembly, muxing — written so tests can run all of it without a model,
an engine or a network. voiceover_api.py owns the job registry, the doors and
the threads.

Honesty contract (the part the studio renders): every line carries its FIT —
how many seconds it speaks vs the scene it sits in. A line that spills into
the next scene says so; a line clipped by the end of the video says so.
Nothing is silently stretched: Pocket TTS has no rate control, and pretending
otherwise is the named anti-shape (`X-Ignored-Settings` exists for a reason).
"""
from __future__ import annotations

import io
import json
import logging
import subprocess
import wave
from pathlib import Path
from typing import Callable

import numpy as np

from service.emotions import BASELINE, normalize_emotion

logger = logging.getLogger("gravitone.voiceover")

#: Spoken-word budget per scene-second. ~2.3 words/s is a calm narration
#: pace; the budget is a CEILING the writer is told, not a guarantee the
#: synthesis is bent to.
WORDS_PER_SECOND = 2.3

#: The engine's native output. build_track allocates at this rate.
RATE = 24000

MUX_TIMEOUT_S = 300

_run = subprocess.run  # test seam, house convention


class VoiceoverError(RuntimeError):
    """Named, user-safe."""


# ── the writer ────────────────────────────────────────────────────────────────

def script_prompt(scenes: list[dict], *, emotions: list[str],
                  style: str = "", language: str = "") -> str:
    """The one prompt the text brain answers with the whole narration plan.

    One call for the whole video, not one per scene: narration needs an arc
    (what was already said shapes what comes next), and a per-scene call would
    hand the model amnesia between every beat.
    """
    lines = []
    for s in scenes:
        dur = float(s.get("dur") or (float(s["end"]) - float(s["start"])))
        budget = words_budget(dur)
        desc = s.get("description") or {}
        bits = [f"scene {s['i']}: {s['start']:.0f}-{s['end']:.0f}s "
                f"(budget: at most {budget} words)"]
        for k in ("setting", "action", "people", "mood", "caption"):
            if desc.get(k):
                bits.append(f"{k}: {desc[k]}")
        if not desc:
            bits.append("(no picture could be read for this scene)")
        lines.append("; ".join(bits))
    style_line = f"Style brief from the creator: {style}\n" if style else ""
    lang_line = (f"Write the narration in {language}.\n" if language else "")
    return (
        "You are writing a voiceover for a video, one narration line per "
        "scene. You know each scene only from the description below.\n"
        f"{style_line}{lang_line}"
        "Rules:\n"
        "- Respect each scene's word budget — narration must breathe; going "
        "over the budget makes the audio spill into the next scene.\n"
        "- A scene may be left silent (empty text) when silence serves the "
        "story better.\n"
        f"- Each line carries one emotion from exactly this list: "
        f"{', '.join(emotions)}. Use the plain one for most lines.\n"
        "- No stage directions, no markdown, no quotation marks around the "
        "narration itself.\n\n"
        "Scenes:\n" + "\n".join(lines) + "\n\n"
        "Answer ONLY with JSON: {\"lines\": [{\"scene\": <int>, "
        "\"text\": <string, may be empty>, \"emotion\": <string>}]} — one "
        "entry per scene, same order."
    )


def words_budget(dur_s: float) -> int:
    return max(3, int(dur_s * WORDS_PER_SECOND))


def clean_script(raw: dict, scenes: list[dict], *,
                 emotions: list[str]) -> list[dict]:
    """The model's plan → exactly one validated line per scene.

    Missing scenes become silence (not an error: the model was told silence
    is allowed, so an absent entry is read as choosing it). Unknown emotions
    fall to baseline HERE, visibly (`emotion_fell_back`), rather than deep in
    synthesis where the substitution would look like a stem fallback.
    """
    allowed = {e for e in emotions}
    by_scene: dict[int, dict] = {}
    for m in (raw.get("lines") or []):
        if isinstance(m, dict) and isinstance(m.get("scene"), int):
            by_scene.setdefault(m["scene"], m)
    out: list[dict] = []
    for s in scenes:
        m = by_scene.get(s["i"], {})
        text = " ".join(str(m.get("text") or "").split())
        want = str(m.get("emotion") or BASELINE).strip().lower()
        try:
            want = normalize_emotion(want)
        except Exception:  # noqa: BLE001 - an invented emotion is a fallback, not a crash
            want = BASELINE
        fell = want not in allowed
        out.append({"scene": s["i"], "text": text,
                    "emotion": want if not fell else BASELINE,
                    "emotion_requested": want if fell else None,
                    "budget_words": words_budget(
                        float(s.get("dur") or (s["end"] - s["start"]))),
                    "words": len(text.split())})
    return out


# ── the voice ─────────────────────────────────────────────────────────────────

def synthesize_lines(lines: list[dict], *,
                     speak: Callable[[str, str], tuple[bytes, float]],
                     resolve_voice: Callable[[str], tuple[str, str, bool]],
                     should_cancel: Callable[[], bool] | None = None,
                     progress: Callable[[int, int], None] | None = None) -> list[dict]:
    """Speak every non-silent line. Serial on purpose: the engine pool is the
    process's real parallelism and a bulk job must not starve interactive
    requests by flooding the admission queue.

    `speak(voice_id, text) -> (wav_bytes, seconds)`;
    `resolve_voice(emotion) -> (voice_id, used_emotion, fell_back)`.
    Mutates and returns `lines`: adds `wav`, `seconds`, `emotion_used`,
    `stem_fallback` (the Character lacked the stem), or `error` per line —
    one refused line degrades that scene to silence, named, and the job
    continues.
    """
    todo = [l for l in lines if l["text"]]
    for n, line in enumerate(todo):
        if should_cancel and should_cancel():
            break
        if progress:
            progress(n, len(todo))
        voice_id, used, fell_back = resolve_voice(line["emotion"])
        line["voice_id"] = voice_id
        line["emotion_used"] = used
        line["stem_fallback"] = bool(fell_back)
        try:
            wav, seconds = speak(voice_id, line["text"])
        except Exception as exc:  # noqa: BLE001 - one line must not cost the video
            logger.warning("voiceover line for scene %s failed: %r",
                           line["scene"], exc)
            line["error"] = "this line could not be synthesized"
            continue
        line["wav"] = wav
        line["seconds"] = round(seconds, 3)
    return lines


# ── the track ─────────────────────────────────────────────────────────────────

def build_track(lines: list[dict], scenes: list[dict], *,
                video_seconds: float, rate: int = RATE) -> tuple[bytes, list[dict]]:
    """Place every spoken line at its scene's start; return (wav, fit report).

    The track is EXACTLY the video's length: a line that runs past the end of
    the video is clipped and its fit says so. A line longer than its scene is
    NOT clipped — it spills into the next scene (that is how human narration
    behaves) and the spill is measured. Overlapping spill is mixed, not
    truncated, then soft-clipped back into range.
    """
    total = int(round(video_seconds * rate))
    track = np.zeros(total, dtype=np.float64)
    by_scene = {s["i"]: s for s in scenes}
    fit: list[dict] = []
    for line in lines:
        entry = {"scene": line["scene"], "text": line["text"],
                 "emotion": line.get("emotion_used") or line["emotion"],
                 "stem_fallback": line.get("stem_fallback", False),
                 "seconds": line.get("seconds"),
                 "budget_seconds": None, "spill_seconds": 0.0,
                 "clipped_seconds": 0.0, "silent": not line["text"],
                 "error": line.get("error")}
        s = by_scene.get(line["scene"])
        if s is not None:
            entry["budget_seconds"] = round(
                float(s.get("dur") or (s["end"] - s["start"])), 2)
        if not line.get("wav") or s is None:
            fit.append(entry)
            continue
        samples = _wav_to_float(line["wav"], rate)
        start = int(round(float(s["start"]) * rate))
        end = min(start + len(samples), total)
        if end <= start:
            entry["clipped_seconds"] = entry["seconds"] or 0.0
            fit.append(entry)
            continue
        track[start:end] += samples[:end - start]
        clipped = (len(samples) - (end - start)) / rate
        if clipped > 0.01:
            entry["clipped_seconds"] = round(clipped, 2)
        spoken = (end - start) / rate
        budget = entry["budget_seconds"] or spoken
        if spoken > budget + 0.05:
            entry["spill_seconds"] = round(spoken - budget, 2)
        fit.append(entry)
    peak = float(np.max(np.abs(track))) if total else 0.0
    if peak > 1.0:  # spill overlaps can sum past full scale; keep it honest audio
        track /= peak
    pcm = (np.clip(track, -1.0, 1.0) * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue(), fit


def _wav_to_float(wav_bytes: bytes, rate: int) -> np.ndarray:
    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        if w.getframerate() != rate or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise VoiceoverError("the engine answered in an unexpected audio "
                                 "format")
        raw = w.readframes(w.getnframes())
    return np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0


# ── the mux ───────────────────────────────────────────────────────────────────

def mux(video: Path, track_wav: Path, out_mp4: Path) -> None:
    """Video stream copied, narration encoded to AAC — the only transcode is
    the one that cannot be avoided (wav does not travel in mp4)."""
    cmd = ["ffmpeg", "-y", "-v", "error", "-i", str(video), "-i", str(track_wav),
           "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
           "-c:a", "aac", "-b:a", "128k", str(out_mp4)]
    try:
        r = _run(cmd, capture_output=True, timeout=MUX_TIMEOUT_S)
    except (OSError, subprocess.TimeoutExpired) as exc:
        logger.error("mux failed for %s: %s", video.name, exc)
        raise VoiceoverError("the narrated video could not be assembled")
    if r.returncode != 0 or not out_mp4.is_file() or out_mp4.stat().st_size == 0:
        logger.warning("mux refused %s: %s", video.name, (r.stderr or b"")[-400:])
        out_mp4.unlink(missing_ok=True)
        raise VoiceoverError("the narrated video could not be assembled — "
                             "the video stream may not sit in an mp4 container")


# ── the public summary ────────────────────────────────────────────────────────

def summarize(fit: list[dict]) -> dict:
    spoken = [f for f in fit if not f["silent"] and not f.get("error")]
    return {
        "scenes": len(fit),
        "spoken": len(spoken),
        "silent": sum(1 for f in fit if f["silent"]),
        "failed": sum(1 for f in fit if f.get("error")),
        "stem_fallbacks": sum(1 for f in fit if f.get("stem_fallback")),
        "spilling": sum(1 for f in fit if f["spill_seconds"]),
        "clipped": sum(1 for f in fit if f["clipped_seconds"]),
        "narration_seconds": round(sum(f["seconds"] or 0.0 for f in spoken), 1),
    }


def dump_script(path: Path, lines: list[dict]) -> None:
    """Persist the plan without the audio bytes — the artifact a studio
    script editor round-trips."""
    slim = [{k: v for k, v in l.items() if k != "wav"} for l in lines]
    path.write_text(json.dumps(slim, ensure_ascii=False, indent=1), "utf-8")
