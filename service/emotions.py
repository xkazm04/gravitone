"""Characters, Voices and the emotion scale.

Vocabulary (single source of truth for both the service and the web app):

  * **Voice**     — one embedding = one speaker in ONE emotion (a .safetensors).
  * **Character** — a group of Voices: the same speaker across the emotion scale.
  * **Emotion**   — a slot on the template scale below. `baseline` is mandatory;
                    every other slot is optional and filled one at a time.

Pocket TTS has no emotion/style conditioner — expression lives entirely in the
reference audio (see tts_model.get_state_for_audio_prompt: the prompt "captures
the acoustic characteristics (speaker voice, style, prosody)"). So an emotion is
literally *a different recording of the same person*. That is why Characters
group Voices rather than parameterising one.

Metatag grammar (used by POST /v1/speak):

    Hello there. [excited]This is amazing![/excited] [sad]But now I'm sad.

  * `[emotion]` switches the active emotion.
  * `[/emotion]` (or `[/]`) returns to baseline.
  * An unclosed tag applies until the next tag or end of text.
  * Unknown emotions, or emotions the Character lacks, FALL BACK to baseline and
    are reported per-segment so the UI can show what actually happened.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

BASELINE = "baseline"

# Base scale every Character starts with. Order is the display order.
# Characters may extend this with CUSTOM emotions ("sarcastic", "battle_cry")
# — the tag grammar and the slot model never cared about the vocabulary, so a
# custom emotion is a first-class slot: record a Voice, address it via the API,
# fall back to baseline when absent. See voices.py::character_scale.
EMOTION_SCALE: list[str] = [
    BASELINE,
    "calm",
    "happy",
    "excited",
    "sad",
    "angry",
    "whisper",
    "confused",
]

_EMOTION_RE = re.compile(r"^[a-z][a-z0-9_]{1,23}$")


def normalize_emotion(name: str) -> str:
    """Canonical form of a (possibly custom) emotion name, or ValueError.
    Lowercase, snake_case, 2-24 chars — the same shape the tag grammar and
    voice_id slugs can carry safely."""
    slug = re.sub(r"[\s-]+", "_", (name or "").strip().lower())
    if not _EMOTION_RE.match(slug):
        raise ValueError(
            "emotion must be 2-24 chars, start with a letter, and use only "
            "lowercase letters, digits and underscores"
        )
    return slug

_TAG_RE = re.compile(r"\[(/?)([a-zA-Z_]*)\]")


@dataclass
class Segment:
    """A run of text to be spoken with one emotion."""
    text: str
    emotion: str  # what the author asked for


def parse_segments(text: str) -> list[Segment]:
    """Split metatagged text into (text, requested-emotion) runs."""
    segments: list[Segment] = []
    current = BASELINE
    pos = 0

    def push(chunk: str, emotion: str) -> None:
        chunk = chunk.strip()
        if chunk:
            segments.append(Segment(text=chunk, emotion=emotion))

    for m in _TAG_RE.finditer(text):
        push(text[pos : m.start()], current)
        closing, name = m.group(1), m.group(2).lower()
        current = BASELINE if closing or not name else name
        pos = m.end()

    push(text[pos:], current)
    return segments or [Segment(text=text.strip(), emotion=BASELINE)]


# Nearest-emotion fallback. When a Character lacks the requested emotion we no
# longer collapse straight to baseline — we first try acoustically adjacent
# emotions (an [excited] line on a Character that only has `happy` should read
# happy, not neutral). Each entry lists a requested emotion's neighbours in
# preference order; resolve() tries them, then baseline, then a deterministic
# scale-ordered pick. Custom emotions have no entry and fall through to that
# baseline/deterministic tail. Keep chains short and one-directional per pair so
# a walk can't loop.
FALLBACK_CHAIN: dict[str, list[str]] = {
    "excited": ["happy"],       # high-arousal positive → its calmer sibling
    "happy": ["excited"],       # positive → its higher-energy sibling
    "sad": ["calm"],            # low-arousal negative → the nearest low-arousal read
    "calm": ["baseline"],       # calm is already close to neutral
    "angry": ["excited"],       # share high arousal; excited is the nearest energy match
    "whisper": ["calm"],        # quiet, low-energy delivery
    "confused": ["calm"],       # hesitant/soft → calm before neutral
}


def deterministic_fallback(available: dict[str, object]) -> str | None:
    """The emotion to fall back to when nothing better matches.

    The available emotion earliest in ``EMOTION_SCALE`` order (so ``baseline``
    wins when present); unknown/custom emotions sort last, then alphabetically.
    Fully deterministic — no reliance on dict iteration order. ``available`` may
    be any mapping keyed by emotion. Returns the chosen emotion, or None when
    empty. Shared by :func:`resolve` and voices.character_manifest so the two
    can never disagree.
    """
    if not available:
        return None
    order = {e: i for i, e in enumerate(EMOTION_SCALE)}
    return min(available, key=lambda e: (order.get(e, len(EMOTION_SCALE)), e))


def resolve(emotion: str, available: dict[str, str]) -> tuple[str, str, bool]:
    """Map a requested emotion to an actual voice_id.

    Returns (voice_id, used_emotion, fell_back). ``available`` maps emotion ->
    voice_id for one Character. On a miss the walk is: adjacent emotions (in
    FALLBACK_CHAIN order) → baseline → deterministic scale-first voice. The
    second element is the TRUE emotion used; ``fell_back`` is True whenever it
    differs from what was requested.
    """
    if emotion in available:
        return available[emotion], emotion, False
    for neighbour in FALLBACK_CHAIN.get(emotion, ()):
        if neighbour in available:
            return available[neighbour], neighbour, True
    # baseline is index 0 of EMOTION_SCALE, so deterministic_fallback returns it
    # when present and otherwise the earliest available slot — one code path for
    # both the "baseline" and "deterministic first" steps.
    used = deterministic_fallback(available)
    if used is None:  # no voices at all — callers guard this, so it's unreachable
        raise KeyError(emotion)
    return available[used], used, True
