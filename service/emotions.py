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


def resolve(emotion: str, available: dict[str, str]) -> tuple[str, str, bool]:
    """Map a requested emotion to an actual voice_id.

    Returns (voice_id, used_emotion, fell_back).
    `available` maps emotion -> voice_id for one Character.
    """
    if emotion in available:
        return available[emotion], emotion, False
    baseline = available.get(BASELINE)
    if baseline is None:  # character with no baseline: take any voice
        any_emotion, any_id = next(iter(available.items()))
        return any_id, any_emotion, True
    return baseline, BASELINE, True
