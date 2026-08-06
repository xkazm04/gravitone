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

import math
import re
from collections.abc import Iterable, Mapping
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

# The tag grammar, kept in step with ``normalize_emotion`` above.
#
# It used to be ``[a-zA-Z_]*`` — letters and underscores only — while
# ``normalize_emotion`` has always accepted DIGITS after the first character
# (``[a-z][a-z0-9_]{1,23}``). So an emotion named ``mode2`` was a legal slot to
# create, record and address by API, and no inline tag could reach it: ``[mode2]``
# simply did not match, fell through as ordinary text, and was SPOKEN OUT LOUD.
# The name now follows the same shape the slug does (leading letter/underscore,
# then letters, digits and underscores), and the empty alternative keeps ``[]``
# and ``[/]`` reading as a return to baseline. Every string the old pattern
# matched still matches.
#
# Mirrored in web/app/playground/_variants/shared.ts (``tagRe``/``TAGGABLE``);
# score.test.ts pins the two together.
_TAG_RE = re.compile(r"\[(/?)([a-zA-Z_][a-zA-Z0-9_]*|)\]")


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


# ── measured emotion space ────────────────────────────────────────────────────
# FALLBACK_CHAIN above is seven guesses about acoustic adjacency: hardcoded,
# identical for every speaker, and empty for every custom emotion. A `whisper`
# slot that was actually shouted still routes as quiet, because nothing ever
# listened to it.
#
# service/prosody.py listens. Where a Character's slots carry measured prosody,
# the walk below stops guessing and MEASURES: normalise the Character's own
# slots against each other (so a naturally loud speaker isn't globally "angry" —
# every comparison is in units of that speaker's own spread), then pick the
# available slot sitting nearest where the requested emotion is expected to be.
#
# What is deliberately NOT here yet: a fitted 2-D affect plane, coordinate
# addressing, coverage-as-area. Those need a corpus regression
# (voice-emotion-library.md M2 steps 2/5/6). Until then the expected position of
# a requested emotion comes from the declarative prior below, which is a stated
# heuristic rather than a measurement — the honest half of this feature is that
# the *Character's* side is measured, and the target side is labelled as a prior.
PROSODY_FIELDS: tuple[str, ...] = (
    "f0_mean", "f0_sd", "energy_rms", "rate_proxy", "spectral_tilt",
)

# Which DIRECTION each base-scale emotion lies in, relative to the Character's
# own average take. Sign and relative weight are the claim; absolute magnitude
# is NOT, because comparison is by direction (see _cosine_distance) — we can say
# honestly that an angry take is louder, higher and brighter than this speaker's
# average, and we cannot honestly say by how many standard deviations. Only
# fields we have a defensible opinion about are listed; an unlisted field simply
# doesn't vote.
#
# `baseline` deliberately has NO entry: it is the origin of this space, not a
# direction in it, so there is no vector to point at. A missed baseline request
# therefore takes the unchanged deterministic tail (and baseline is a mandatory
# slot, so it is not a miss in practice).
#
# Custom emotions have no entry either — exactly as they have no FALLBACK_CHAIN
# entry — and fall through to the deterministic tail. Giving them free fallback
# needs the affect plane (M2 step 5), not a bigger dict.
EMOTION_PROSODY_PRIOR: dict[str, dict[str, float]] = {
    "calm":     {"f0_sd": -0.6, "energy_rms": -0.5, "rate_proxy": -0.4},
    "happy":    {"f0_mean": 0.5, "f0_sd": 0.4, "energy_rms": 0.4,
                 "rate_proxy": 0.2},
    "excited":  {"f0_mean": 0.9, "f0_sd": 0.9, "energy_rms": 0.9,
                 "rate_proxy": 0.9, "spectral_tilt": 0.4},
    "sad":      {"f0_mean": -0.6, "f0_sd": -0.4, "energy_rms": -0.7,
                 "rate_proxy": -0.7, "spectral_tilt": -0.4},
    "angry":    {"f0_mean": 0.3, "f0_sd": 0.7, "energy_rms": 1.0,
                 "rate_proxy": 0.4, "spectral_tilt": 0.6},
    "whisper":  {"f0_mean": -0.3, "f0_sd": -0.5, "energy_rms": -1.2,
                 "rate_proxy": -0.2, "spectral_tilt": 0.2},
    "confused": {"f0_sd": 0.3, "energy_rms": -0.3, "rate_proxy": -0.5},
}

# Below this, a field is constant across the Character's slots and a z-score
# would be division by (almost) nothing — the field is dropped instead.
_MIN_SD = 1e-6


def prosody_vector(prosody: object) -> dict[str, float] | None:
    """The comparable half of a ``prosody.probe`` result, or None.

    Drops every field the probe could not measure (they arrive as ``None`` with
    a named ``reason``), so a partially-measured take still participates on the
    features it does have. ``energy_rms`` is converted to dB first: loudness is
    perceived on a log scale, and z-scoring raw linear RMS lets one loud take
    dominate the whole space. Returns None when nothing usable is present.
    """
    if not isinstance(prosody, Mapping):
        return None
    vec: dict[str, float] = {}
    for field in PROSODY_FIELDS:
        raw = prosody.get(field)
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            continue
        value = float(raw)
        if math.isnan(value) or math.isinf(value):
            continue
        if field == "energy_rms":
            if value <= 0.0:
                continue
            value = 20.0 * math.log10(value)
        vec[field] = value
    return vec or None


def _prosody_stats(vectors: Iterable[dict[str, float]]) -> dict[str, tuple[float, float]]:
    """Per-field (mean, population sd) over a Character's own vectors.

    This is the per-speaker normalisation the proposal calls for: without it the
    space mostly measures who the person is (F0 range, mic gain) rather than how
    they performed. Fields present in fewer than two vectors, or with no spread,
    are omitted — there is no meaningful z-score for them.
    """
    columns: dict[str, list[float]] = {}
    for vec in vectors:
        for field, value in vec.items():
            columns.setdefault(field, []).append(value)
    stats: dict[str, tuple[float, float]] = {}
    for field, values in columns.items():
        if len(values) < 2:
            continue
        mean = sum(values) / len(values)
        var = sum((v - mean) ** 2 for v in values) / len(values)
        sd = math.sqrt(var)
        if sd <= _MIN_SD:
            continue
        stats[field] = (mean, sd)
    return stats


def _z(vec: dict[str, float], stats: dict[str, tuple[float, float]]) -> dict[str, float]:
    return {f: (v - stats[f][0]) / stats[f][1] for f, v in vec.items() if f in stats}


def _cosine_distance(a: dict[str, float], b: dict[str, float]) -> float | None:
    """1 - cosine similarity over the fields BOTH sides have an opinion about.

    DIRECTION, not magnitude, and that choice is the whole difference between a
    working feature and a useless one. Straight Euclidean distance in z-space
    collapses onto the Character's most AVERAGE slot: z-scores run to about
    +/-1.3 while any honest prior sits below 1, so the take nearest the origin
    wins nearly every comparison and the answer is always "the middle one".
    Comparing directions asks the question we can actually answer — "which of
    this speaker's takes leans the way `excited` leans?" — and it means the
    priors above never have to claim a magnitude we don't know.

    Range [0, 2]: 0 = same direction, 1 = unrelated, 2 = exactly opposite.
    None when there is no shared field, or when either side has no direction at
    all (a slot sitting exactly on the Character's average).
    """
    shared = [f for f in PROSODY_FIELDS if f in a and f in b]
    if not shared:
        return None
    dot = sum(a[f] * b[f] for f in shared)
    norm_a = math.sqrt(sum(a[f] ** 2 for f in shared))
    norm_b = math.sqrt(sum(b[f] ** 2 for f in shared))
    if norm_a <= _MIN_SD or norm_b <= _MIN_SD:
        return None
    return 1.0 - max(-1.0, min(1.0, dot / (norm_a * norm_b)))


def _scale_rank(emotion: str) -> int:
    """Position in EMOTION_SCALE, or one past the end for custom emotions."""
    try:
        return EMOTION_SCALE.index(emotion)
    except ValueError:
        return len(EMOTION_SCALE)


def nearest_measured(emotion: str, available: Mapping[str, str],
                     prosody: Mapping[str, object] | None) -> str | None:
    """The available slot whose measured prosody sits nearest ``emotion``.

    ``prosody`` maps emotion -> that slot's stored ``prosody.probe`` dict for ONE
    Character (rows without one are simply absent). Returns None — meaning "no
    measured opinion, use the cold-start chain" — whenever the measurement can't
    carry the decision: no prior for the requested emotion (every custom one),
    fewer than two measured slots (no spread, so no space), or no field shared
    between the prior and the measured slots. Pure and deterministic: ties break
    on scale order then name, the same ordering ``deterministic_fallback`` uses.
    """
    prior = EMOTION_PROSODY_PRIOR.get(emotion)
    if not prior or not available or not isinstance(prosody, Mapping):
        return None
    measured = {}
    for slot in available:
        vec = prosody_vector(prosody.get(slot))
        if vec:
            measured[slot] = vec
    if len(measured) < 2:
        return None
    stats = _prosody_stats(measured.values())
    if not stats:
        return None
    scored = []
    for slot, vec in measured.items():
        dist = _cosine_distance(_z(vec, stats), prior)
        if dist is not None:
            # Round before comparing so two mathematically-equal candidates
            # can't be ordered by float noise.
            scored.append((round(dist, 9), _scale_rank(slot), slot))
    if not scored:
        return None
    return min(scored)[2]


def label_check(prosody_vec: object, declared_emotion: str,
                character_rows: Iterable[Mapping[str, object]]) -> dict | None:
    """Does this take sound like the emotion its uploader declared?

    Batch design C2's advisory half. ``prosody_vec`` is a fresh
    ``prosody.probe`` result; ``character_rows`` are that Character's existing
    registry rows (``{"emotion": ..., "prosody": {...}, ...}`` — extra keys
    ignored, rows without prosody skipped). Returns
    ``{"agrees": bool, "nearest": str, "distance": float}`` or None.

    Candidate labels are the Character's OWN measured slots (each an exemplar in
    its own voice) plus ``EMOTION_PROSODY_PRIOR`` for base-scale emotions it
    hasn't recorded yet. The new take is included in the normalisation sample,
    so a Character with a single prior slot still has a space to be placed in.

    Returns None — say nothing rather than guess — when there is nothing to
    compare against (no measured rows, no usable features) or when
    ``declared_emotion`` has no anchor at all (a custom emotion on a Character
    that has never recorded it): "agrees" would be meaningless, and per the
    batch design §2 an unmeasured thing shows nothing rather than a placeholder.

    ADVISORY ONLY. Nothing in the service may branch on ``agrees`` — it is a
    chip the studio shows, never a gate on a save.
    """
    candidate = prosody_vector(prosody_vec)
    if not candidate:
        return None

    rows: dict[str, list[dict[str, float]]] = {}
    for row in character_rows or ():
        if not isinstance(row, Mapping):
            continue
        slot = row.get("emotion")
        vec = prosody_vector(row.get("prosody"))
        if isinstance(slot, str) and slot and vec:
            rows.setdefault(slot, []).append(vec)
    if not rows:
        return None

    sample = [candidate] + [v for vecs in rows.values() for v in vecs]
    stats = _prosody_stats(sample)
    here = _z(candidate, stats)
    if not here:
        return None

    anchors: dict[str, dict[str, float]] = {}
    for slot, vecs in rows.items():
        # Several takes of one slot average into one exemplar, so the result
        # can't depend on which row happened to come first.
        merged = {f: sum(v[f] for v in vecs if f in v) / sum(1 for v in vecs if f in v)
                  for f in PROSODY_FIELDS if any(f in v for v in vecs)}
        zed = _z(merged, stats)
        if zed:
            anchors[slot] = zed
    for slot, prior in EMOTION_PROSODY_PRIOR.items():
        anchors.setdefault(slot, prior)
    if declared_emotion not in anchors:
        return None

    scored = []
    for slot, anchor in anchors.items():
        dist = _cosine_distance(here, anchor)
        if dist is not None:
            scored.append((round(dist, 9), _scale_rank(slot), slot))
    if not scored:
        return None
    distance, _rank, nearest = min(scored)
    return {"agrees": nearest == declared_emotion,
            "nearest": nearest,
            "distance": round(distance, 4)}


def derived_slots(available: Mapping[str, str],
                  derived: Iterable[str] | None) -> frozenset[str]:
    """Which of ``available``'s slots are DERIVED rather than recorded.

    Two ways to say it, because one caller cannot pass an argument. Normally
    ``derived`` is handed in explicitly. But ``service/app.py`` calls
    ``resolve(seg.emotion, emotion_map(cid), prosody=...)`` on three hot paths,
    and this batch may not edit that module — so ``voices.emotion_map`` returns
    an :class:`~service.voices.EmotionMap`, a dict that CARRIES its own
    ``derived`` set, and ``resolve`` reads it off the mapping when the keyword is
    absent. A plain ``dict`` has no such attribute, which is precisely why every
    existing caller and every existing test keeps the old behaviour byte for
    byte.

    Only emotions actually present in ``available`` count: a set naming a slot
    that isn't there cannot make a decision about it.
    """
    if derived is None:
        derived = getattr(available, "derived", None)
    if not derived:
        return frozenset()
    return frozenset(e for e in derived if e in available)


def resolve(emotion: str, available: dict[str, str], *,
            prosody: Mapping[str, object] | None = None,
            derived: Iterable[str] | None = None) -> tuple[str, str, bool]:
    """Map a requested emotion to an actual voice_id.

    Returns (voice_id, used_emotion, fell_back). ``available`` maps emotion ->
    voice_id for one Character. The walk is: exact RECORDED slot → exact DERIVED
    slot → MEASURED nearest slot (see :func:`nearest_measured`, only when
    ``prosody`` is supplied and can carry the decision) → adjacent emotions (in
    FALLBACK_CHAIN order) → baseline → deterministic scale-first voice. The
    second element is the TRUE emotion used; ``fell_back`` is True whenever it
    differs from what was requested — **and also when the slot that served it was
    derived**.

    That last clause is deliberate and is the only place ``fell_back`` is not
    literally ``used != emotion``. ``app.py`` records demand off this flag, and a
    derived slot is a computed stand-in for a recording nobody has made: if it
    counted as a hit, the moment Emotion Algebra filled a slot the appetite data
    for that slot would go silent and the coverage loop would stop asking for the
    real take. The per-segment report still names the emotion actually spoken,
    so nothing downstream mislabels the audio.

    ``prosody`` maps emotion -> that slot's stored ``prosody.probe`` dict for the
    same Character. Omit both keywords (the default) and behaviour is
    byte-for-byte what it was before measured mode or derived voices existed.
    """
    is_derived = derived_slots(available, derived)
    if emotion in available:
        return available[emotion], emotion, emotion in is_derived
    measured = nearest_measured(emotion, available, prosody)
    if measured is not None:
        return available[measured], measured, True
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
