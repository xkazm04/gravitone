"""Re-voice — replace the speech in an analyzed video, line by line.

Ability A of the studio: a video whose dialogue is known (the ingest scan
transcribed and diarized it; the scene hand-off carries text + absolute
start/end per line) is re-performed by cloned Characters and muxed back
under the original picture.

THE problem this module owns is FIT. Pocket TTS has no rate control (the
`speed` setting is deliberately inert service-wide), so a re-spoken line
almost never lands exactly in its slot. The fit ladder, in order of how
little it costs the performance:

  1. VERBATIM   — the line fits its slot (within tolerance). Most lines.
  2. ATEMPO     — ffmpeg's pitch-preserving time-stretch, capped hard at
                  ±ATEMPO_MAX (beyond ~8-10% narration audibly degrades).
  3. REWRITE    — the text brain shortens the line to a word budget while
                  keeping its meaning; re-spoken, then atempo may fine-trim.
                  Only when the caller allowed rewriting — a rewritten line
                  is not the transcript any more, and the fit report carries
                  the new text so nothing changes silently.
  4. SPILL      — it still doesn't fit; it is placed anyway and the overrun
                  is MEASURED. An honest spill beats a chipmunk.

Every line's outcome is named in the fit report (`method`, `atempo`,
`rewritten_text`, `spill_seconds`) — the studio renders this per line and
punch-in is the repair loop for the ones the user dislikes.

What v1 does NOT do, stated: the original background (music, ambience) is
dropped — the output carries the new speech only. Recovering the bed needs
source separation, which is a different project. The API says this in
`limits` on every job.
"""
from __future__ import annotations

import io
import logging
import subprocess
import wave
from typing import Callable

logger = logging.getLogger("gravitone.revoice")

#: Beyond ~8-10% a time-stretched voice is audibly wrong. Hard cap, both
#: directions (slow-down is capped too: stretching a short line to "fill"
#: its slot sounds worse than the silence it replaces).
ATEMPO_MAX = 1.08

#: A line within 5% of its slot is a fit — that error is smaller than the
#: diarizer's own boundary noise.
TOLERANCE = 0.05

ATEMPO_TIMEOUT_S = 60

_run = subprocess.run  # test seam, house convention


class RevoiceError(RuntimeError):
    """Named, user-safe."""


def atempo(wav_bytes: bytes, factor: float) -> bytes:
    """Pitch-preserving time-stretch by `factor` (>1 = faster/shorter).

    ffmpeg over pipes — no temp files, the wav goes in and out of memory.
    `atempo` accepts 0.5-100 per instance; the caller's cap keeps us far
    inside that, so no filter chaining is needed.
    """
    if not 0.5 <= factor <= 2.0:
        raise RevoiceError(f"atempo factor {factor:.3f} is outside sanity")
    rate, channels = _wav_geometry(wav_bytes)
    # RAW pcm out, not wav out: ffmpeg cannot seek pipe:1 to fix the RIFF
    # sizes, so a piped wav carries a lying 0xFFFFFFFF header and every
    # duration read downstream is garbage. We re-wrap the honest header here.
    cmd = ["ffmpeg", "-v", "error", "-f", "wav", "-i", "pipe:0",
           "-af", f"atempo={factor:.4f}",
           "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"]
    try:
        r = _run(cmd, input=wav_bytes, capture_output=True,
                 timeout=ATEMPO_TIMEOUT_S)
    except (OSError, subprocess.TimeoutExpired) as exc:
        logger.error("atempo failed: %s", exc)
        raise RevoiceError("time-stretching failed on this box")
    if r.returncode != 0 or not r.stdout:
        logger.warning("atempo refused: %s", (r.stderr or b"")[-300:])
        raise RevoiceError("this line could not be time-stretched")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(bytes(r.stdout))
    return buf.getvalue()


def _wav_geometry(wav_bytes: bytes) -> tuple[int, int]:
    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        return w.getframerate(), w.getnchannels()


def wav_seconds(wav_bytes: bytes) -> float:
    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        return w.getnframes() / float(w.getframerate())


def fit_line(text: str, budget_s: float, *,
             speak: Callable[[str], tuple[bytes, float]],
             rewrite: Callable[[str, int], str] | None = None,
             atempo_max: float = ATEMPO_MAX,
             tolerance: float = TOLERANCE) -> dict:
    """One line through the fit ladder. Returns
    ``{wav, seconds, method, atempo, rewritten_text, spill_seconds}``.

    `speak(text) -> (wav, seconds)` is the engine seam;
    `rewrite(text, max_words) -> shorter_text` is the brain seam, or None
    when the caller forbade rewriting (then the ladder skips to spill).
    """
    wav, seconds = speak(text)
    out = {"wav": wav, "seconds": round(seconds, 3), "method": "verbatim",
           "atempo": None, "rewritten_text": None, "spill_seconds": 0.0}
    ceiling = budget_s * (1 + tolerance)
    if seconds <= ceiling:
        return out

    factor = seconds / budget_s
    if factor <= atempo_max:
        try:
            squeezed = atempo(wav, factor)
            out.update(wav=squeezed, seconds=round(wav_seconds(squeezed), 3),
                       method="atempo", atempo=round(factor, 3))
            return out
        except RevoiceError:
            pass  # fall through the ladder; the spill report tells the truth

    if rewrite is not None:
        # Aim UNDER budget: the rewrite is approximate, and a rewrite that
        # lands slightly short is a fit while one slightly long needs atempo
        # AGAIN. ~2.8 words/s is spoken-dialogue pace (faster than the
        # narration budget on purpose — dialogue is denser than voiceover).
        max_words = max(2, int(budget_s * 2.8))
        try:
            shorter = " ".join(str(rewrite(text, max_words) or "").split())
        except Exception as exc:  # noqa: BLE001 - the brain is optional here
            logger.warning("rewrite failed, keeping verbatim: %r", exc)
            shorter = ""
        if shorter and shorter != text:
            wav2, seconds2 = speak(shorter)
            out2 = {"wav": wav2, "seconds": round(seconds2, 3),
                    "method": "rewrite", "atempo": None,
                    "rewritten_text": shorter, "spill_seconds": 0.0}
            if seconds2 <= ceiling:
                return out2
            factor2 = seconds2 / budget_s
            if factor2 <= atempo_max:
                try:
                    squeezed = atempo(wav2, factor2)
                    out2.update(wav=squeezed,
                                seconds=round(wav_seconds(squeezed), 3),
                                method="rewrite+atempo",
                                atempo=round(factor2, 3))
                    return out2
                except RevoiceError:
                    pass
            # the rewrite helped but still spills — keep whichever spills less
            if seconds2 < seconds:
                out = out2

    out["spill_seconds"] = round(max(0.0, out["seconds"] - budget_s), 2)
    if out["method"] in ("verbatim", "rewrite"):
        out["method"] = "spill" if out["method"] == "verbatim" else "rewrite"
    return out


# ── the direction pass ────────────────────────────────────────────────────────

def direction_prompt(lines: list[dict], emotions_by_char: dict[str, list[str]]) -> str:
    """One brain call assigns an emotion to every line from its text and
    position in the dialogue — the "composed emotional scale". Text is NOT
    the model's to change here; that only ever happens in the fit ladder,
    where it is reported."""
    listing = []
    for l in lines:
        opts = emotions_by_char.get(l["character_id"], ["baseline"])
        listing.append(f"line {l['i']} [{l['character_id']}] "
                       f"(emotions available: {', '.join(sorted(opts))}): "
                       f"“{l['text'][:300]}”")
    return (
        "You are directing the emotional read of re-performed dialogue. For "
        "each line pick ONE emotion from that line's own available list — "
        "judge from what is said and how the conversation flows. Prefer "
        "baseline unless the text clearly carries the emotion.\n\n"
        + "\n".join(listing) + "\n\n"
        "Answer ONLY with JSON: {\"lines\": [{\"i\": <int>, "
        "\"emotion\": <string>}]} — one entry per line."
    )


def apply_direction(lines: list[dict], plan: dict,
                    emotions_by_char: dict[str, list[str]]) -> None:
    """Stamp the plan onto the lines; anything invented falls to baseline,
    visibly (`emotion_requested`), same contract as voiceover's writer."""
    by_i = {m["i"]: m for m in (plan.get("lines") or [])
            if isinstance(m, dict) and isinstance(m.get("i"), int)}
    for l in lines:
        want = str((by_i.get(l["i"]) or {}).get("emotion")
                   or "baseline").strip().lower()
        allowed = set(emotions_by_char.get(l["character_id"], ["baseline"]))
        if want in allowed:
            l["emotion"] = want
            l["emotion_requested"] = None
        else:
            l["emotion"] = "baseline"
            l["emotion_requested"] = want if want != "baseline" else None


def rewrite_prompt(text: str, max_words: int) -> str:
    return (
        f"Shorten this spoken line to at most {max_words} words while keeping "
        "its meaning, register and voice. It will be lip-agnostic dubbing, so "
        "natural speech matters more than word-for-word fidelity. Answer with "
        f"ONLY the shortened line, no quotes.\n\nLine: {text}"
    )
