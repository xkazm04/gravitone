"""Voice + Character management.

A **Voice** is one embedding (one speaker, one emotion). A **Character** groups
Voices of the same speaker across the emotion scale. See `service/emotions.py`
for the vocabulary and the metatag grammar.

Cloning runs in a `service.export_stems` child process so the (heavy) model load
is isolated from the serving workers — the SAME exporter the ingest commit uses,
which verifies each embedding by loading it back. Metadata lives in
`voices/_meta.json`.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import tempfile
import threading
import time
import uuid
import wave
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, ConfigDict

from service import errors, export_stems
from service.atomicio import file_lock
from service.config import SETTINGS
from service.demand import all_demand, demand_for
from service.emotions import (
    BASELINE, EMOTION_SCALE, deterministic_fallback, normalize_emotion,
)

router = APIRouter(tags=["voices"])

logger = logging.getLogger("gravitone")

VOICES_DIR = Path(SETTINGS.voices_dir)
META_PATH = VOICES_DIR / "_meta.json"

BUILTIN = [
    ("alba", "EN"), ("anna", "EN"), ("vera", "EN"), ("charles", "EN"), ("paul", "EN"),
    ("george", "EN"), ("mary", "EN"), ("jane", "EN"), ("michael", "EN"), ("eve", "EN"),
    ("cosette", "EN"), ("marius", "EN"), ("javert", "EN"), ("jean", "EN"), ("fantine", "EN"),
    ("eponine", "EN"), ("azelma", "EN"), ("bill_boerst", "EN"), ("peter_yearsley", "EN"),
    ("stuart_bell", "EN"), ("caro_davy", "EN"), ("giovanni", "IT"), ("lola", "ES"),
    ("juergen", "DE"), ("rafael", "PT"), ("estelle", "FR"),
]

# Built-in ids are ordinary first names, so a user WILL pick one for a clone.
# See reject_builtin_collision / _build_characters for how that is handled.
BUILTIN_IDS = frozenset(vid for vid, _ in BUILTIN)


class Voice(BaseModel):
    voice_id: str
    character_id: str
    emotion: str
    name: str  # display name of the voice ("Alba · excited")
    category: str  # cloned | premade
    lang: str = "EN"
    created: str | None = None
    sample_seconds: float | None = None
    # True when a consent receipt is stored for this voice (ingest flow).
    # Pre-existing / built-in voices report False (never migrated).
    consent: bool = False


class Character(BaseModel):
    character_id: str
    name: str
    category: str
    tags: list[str] = []
    lang: str = "EN"
    voices: list[Voice] = []
    emotions: list[str] = []  # which slots are filled
    coverage: int = 0
    total: int = len(EMOTION_SCALE)
    created: str | None = None
    # Unmet requests per emotion (fallback telemetry) — "record this next" heat.
    demand: dict[str, int] = {}
    # Emotions this Character adds beyond the base scale ("sarcastic", "asmr").
    custom_emotions: list[str] = []
    # The Character's effective palette: base scale + its custom emotions.
    scale: list[str] = list(EMOTION_SCALE)
    # Pack-import provenance, if this Character came from a .gravichar import:
    # {"from": <source character_id>, "at": <iso timestamp>}. None otherwise.
    imported: dict | None = None


class VoiceList(BaseModel):
    """ElevenLabs-shaped envelope for GET /v1/voices.

    ElevenLabs clients (and the official SDK) read `.voices` off the response,
    so the list is wrapped in an object rather than returned bare. Each Voice
    already carries the EL-compatible fields (voice_id, name, category) plus
    Gravitone's own (character_id, emotion, lang, …) — purely additive."""
    voices: list[Voice]


class ModelLanguage(BaseModel):
    language_id: str
    name: str


class Model(BaseModel):
    """ElevenLabs-shaped model description for GET /v1/models."""
    model_id: str
    name: str
    can_do_text_to_speech: bool = True
    can_do_voice_conversion: bool = False
    can_be_finetuned: bool = False
    can_use_style: bool = False
    can_use_speaker_boost: bool = False
    serves_pro_voices: bool = False
    languages: list[ModelLanguage] = []
    description: str = ""


# Languages Gravitone's built-in voices cover (ISO code -> display name). Used
# to populate the GET /v1/models `languages` array.
_MODEL_LANGUAGES = {
    "EN": ("en", "English"), "IT": ("it", "Italian"), "ES": ("es", "Spanish"),
    "DE": ("de", "German"), "PT": ("pt", "Portuguese"), "FR": ("fr", "French"),
}


class EmotionReq(BaseModel):
    name: str


class VoicePatch(BaseModel):
    """The only thing a Voice can be re-slotted to is another emotion.

    `name` used to live here and was written into the voice's registry row —
    but EVERY read derives a Voice's display name from its CHARACTER row
    (`_cloned_voices`: f"{cname} · {emotion}"), and the PATCH response returned
    that derived name too. So the API accepted a rename, reported a name it had
    not changed, and nothing ever read the value again. Renaming is
    `PATCH /v1/characters/{id}` — one speaker, one name.

    Extras are FORBIDDEN rather than ignored: a client still sending
    `{"name": …}` gets a 422 that says the field is gone, instead of a silent
    200 that changes nothing (which is the bug this replaces).
    """
    model_config = ConfigDict(extra="forbid")

    emotion: str | None = None


class CharacterPatch(BaseModel):
    name: str | None = None
    tags: list[str] | None = None


# ── meta store ────────────────────────────────────────────────────────────────
class RegistryCorrupt(HTTPException):
    """``voices/_meta.json`` could not be parsed — the registry is UNUSABLE.

    Loud on purpose, and never repaired. :func:`_load_meta` used to answer a
    ``JSONDecodeError`` with an empty skeleton, so a damaged registry read as
    "you have no voices": every Character silently disappeared from the roster,
    and the next :func:`mutate_meta` then loaded that same empty skeleton,
    mutated it and saved it over the file — making the loss permanent.

    Refusing keeps the bytes. The operator is told (server log) exactly which
    file is damaged and that nothing has been written to it, so the JSON can be
    repaired or moved aside by hand. There is deliberately NO automatic
    recovery: quietly substituting a plausible registry is precisely how the
    data was lost, and this service cannot know which voices *should* be there.

    Modelled as an HTTPException because every caller is (directly or
    indirectly) serving a request, and 503 is the honest code: the store is
    temporarily unusable and a retry after repair will work.
    """

    def __init__(self, path: Path, cause: Exception) -> None:
        logger.error(
            "voice registry %s is not valid JSON (%s) — refusing to read or "
            "overwrite it. The damaged file has been left EXACTLY as it is; "
            "repair the JSON (or move it aside) and the service recovers.",
            path, cause)
        super().__init__(
            503,
            "the voice registry is unreadable; it has been left untouched "
            "rather than replaced — see the server log for the file to repair")


def _load_meta() -> dict:
    if not META_PATH.is_file():
        return {"voices": {}, "characters": {}}
    try:
        raw = json.loads(META_PATH.read_text("utf-8"))
    except json.JSONDecodeError as exc:
        # NOT an empty skeleton: that erased the roster and then got saved over
        # the real file by the next mutation. See RegistryCorrupt.
        raise RegistryCorrupt(META_PATH, exc) from exc
    if "voices" in raw or "characters" in raw:
        raw.setdefault("voices", {})
        raw.setdefault("characters", {})
        return raw
    # migrate flat {voice_id: {...}} -> character-aware layout
    voices, characters = {}, {}
    for vid, m in raw.items():
        cid = _slug(m.get("name", vid))
        voices[vid] = {**m, "character_id": cid, "emotion": BASELINE}
        characters.setdefault(cid, {"name": m.get("name", vid), "tags": m.get("tags", [])})
    return {"voices": voices, "characters": characters}


def _save_meta(meta: dict) -> None:
    """Atomically persist the registry.

    The JSON is written to a temp file in the SAME directory and then
    ``os.replace``d over ``_meta.json`` — an atomic rename on the local
    filesystem (POSIX and Windows). A crash mid-write can therefore never
    truncate the live registry: readers see either the old file or the new one,
    never a partial. Callers should mutate through :func:`mutate_meta` so the
    load→mutate→save cycle is serialized under ``_META_LOCK``.
    """
    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    data = json.dumps(meta, indent=2)
    fd, tmp = tempfile.mkstemp(dir=str(VOICES_DIR), prefix="._meta-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(data)
        os.replace(tmp, META_PATH)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# Serializes every read-modify-write of the registry. Re-entrant so a mutation
# fn may itself call back into the meta helpers without deadlocking. This is
# per-PROCESS; _META_LOCK_PATH below extends the exclusion across replicas.
_META_LOCK = threading.RLock()
_META_LOCK_PATH = VOICES_DIR / "._meta.lock"

# ── read cache ─────────────────────────────────────────────────────────────────
# emotion_map/list_characters/all_voices/get_voice all reduce to one assembled
# characters list, and they sit in the synthesis hot path (every /v1/speak,
# every emotion-addressed TTS call, once per character per /v1/performance).
# Assembling it means a JSON parse + a VOICES_DIR glob, so we memoize it on a
# cheap fingerprint: (meta mtime_ns, voices-dir mtime_ns, generation counter).
# mutate_meta bumps the counter; external writers (or tests) can call
# invalidate(). A stat-only fingerprint also catches writers that bypass
# mutate_meta (e.g. ingest's own _save_meta) via the changed mtime.
# Re-entrant: list_characters holds it across _build_characters, which calls
# back into _cached_demand (also lock-guarded) on the same thread.
_CACHE_LOCK = threading.RLock()
_cache_generation = 0
_chars_cache: list["Character"] | None = None
_chars_cache_key: tuple | None = None

# all_demand() is a JSON read per list too. It's telemetry decoration, so a
# short TTL is fine — staleness never affects synthesis correctness. Cached here
# (not in demand.py) to keep that module free of view-layer concerns.
_DEMAND_TTL = 2.0
_demand_cache: dict | None = None
_demand_cache_at = 0.0


def mutate_meta(fn):
    """Serialized, atomic registry mutation.

    Two layers of exclusion, because this service is deployed as N single-worker
    PROCESSES (service/replicas.py):
      * ``_META_LOCK`` serializes threads inside one process (and is re-entrant
        so a mutation fn may call back into the meta helpers).
      * ``file_lock(_META_LOCK_PATH)`` serializes the processes. Without it two
        replicas could load the same registry, each add a voice, and each save —
        ``os.replace`` keeps the file intact but one entry is silently lost.
        Same primitive as takes.py's ``.pick`` sentinel.

    Load the registry, hand it to ``fn`` for in-place mutation, then atomically
    save. Returns whatever ``fn`` returns. If ``fn`` raises, the save is skipped,
    so the previous file is left intact (crash safety). This is the ONE write
    path every mutating endpoint must use. On success it bumps the read-cache
    generation so the next read reassembles.
    """
    global _cache_generation
    with _META_LOCK, file_lock(_META_LOCK_PATH):
        meta = _load_meta()
        result = fn(meta)
        _save_meta(meta)
        _cache_generation += 1
        return result


def invalidate() -> None:
    """Force the next read to reassemble. For writers that don't go through
    mutate_meta (the stat fingerprint already covers most such cases)."""
    global _cache_generation
    _cache_generation += 1


def _registry_fingerprint() -> tuple:
    def _mtime(p: Path) -> int:
        try:
            return p.stat().st_mtime_ns
        except OSError:
            return -1
    return (_mtime(META_PATH), _mtime(VOICES_DIR), _cache_generation)


def _cached_demand() -> dict:
    """all_demand() behind a short TTL — telemetry, staleness is acceptable."""
    global _demand_cache, _demand_cache_at
    now = time.monotonic()
    with _CACHE_LOCK:
        if _demand_cache is not None and (now - _demand_cache_at) < _DEMAND_TTL:
            return _demand_cache
        _demand_cache = all_demand()
        _demand_cache_at = now
        return _demand_cache


def _slug(name: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", name.strip().lower()).strip("-")
    return s or "character"


def voice_file_path(voice_id: str, voices_dir: Path | None = None) -> Path:
    """Where a Voice's embedding lives — PROVEN to be inside the voices dir.

    Belt and braces against writing outside ``VOICES_DIR``. The first line of
    defence is validating the *inputs* a voice_id is built from
    (``emotions.normalize_emotion`` for the emotion, ``_slug`` for the character
    id) — that is what every caller must do, and what makes a hostile pack
    manifest a 400 rather than a sanitised surprise. This is the second line:
    the *resolved* destination is re-checked immediately before the write, so a
    future path-building bug still cannot escape the directory.

    ``voices_dir`` is explicit because ``packs``/``ingest`` bind their own
    ``VOICES_DIR`` at import; passing it keeps a test's patch honest.
    Raises ValueError when the id would resolve anywhere but directly inside it.
    """
    base = VOICES_DIR if voices_dir is None else voices_dir
    path = base / f"{voice_id}.safetensors"
    if path.resolve().parent != base.resolve():
        raise ValueError(
            f"refusing to write outside the voices directory (voice id {voice_id!r})")
    return path


def _wav_seconds(path: Path) -> float | None:
    try:
        with wave.open(str(path), "rb") as w:
            return round(w.getnframes() / float(w.getframerate()), 2)
    except Exception:  # noqa: BLE001
        return None


# ── assembly ──────────────────────────────────────────────────────────────────
def _cloned_voices(meta: dict) -> list[Voice]:
    out: list[Voice] = []
    if not VOICES_DIR.is_dir():
        return out
    for p in sorted(VOICES_DIR.glob("*.safetensors")):
        m = meta["voices"].get(p.stem, {})
        cid = m.get("character_id", _slug(m.get("name", p.stem)))
        emo = m.get("emotion", BASELINE)
        cname = meta["characters"].get(cid, {}).get("name", cid)
        out.append(Voice(
            voice_id=p.stem, character_id=cid, emotion=emo,
            name=f"{cname} · {emo}", category="cloned", lang=m.get("lang", "EN"),
            created=m.get("created"), sample_seconds=m.get("sample_seconds"),
            consent=bool(m.get("consent")),
        ))
    return out


def character_scale(cm: dict, voices_emotions: list[str] | None = None) -> tuple[list[str], list[str]]:
    """(effective scale, custom emotions) for one Character.

    Custom emotions come from the character's declared list plus any emotion a
    Voice already carries that isn't on the base scale — so a voice cloned
    straight through the API with `emotion=sarcastic` self-registers its slot.
    """
    custom: list[str] = []
    for e in list(cm.get("custom_emotions") or []) + list(voices_emotions or []):
        if e not in EMOTION_SCALE and e not in custom:
            custom.append(e)
    return list(EMOTION_SCALE) + custom, custom


def list_characters() -> list[Character]:
    """Assembled characters list, memoized on the registry fingerprint.

    Repeated calls with no intervening write (the synthesis hot path) reuse the
    cached list — one JSON parse + glob amortized across every read."""
    global _chars_cache, _chars_cache_key
    key = _registry_fingerprint()
    with _CACHE_LOCK:
        if _chars_cache is not None and _chars_cache_key == key:
            return _chars_cache
        chars = _build_characters()
        _chars_cache, _chars_cache_key = chars, key
        return chars


def reject_builtin_collision(character_id: str, name: str) -> None:
    """Refuse to create a cloned Character that would shadow a built-in.

    THE rule for built-in id collisions, shared by every creation path so they
    cannot disagree: **refuse up front, and let an already-created clone win in
    the roster.** Built-in ids are ordinary first names (mary, jane, paul…), so
    "clone my voice and call it Mary" is a name a real user picks; the roster
    assembly used to overwrite the clone with the built-in, and the Character
    vanished while its file and registry row stayed on disk.

    Refusing (rather than letting the new clone shadow the built-in) keeps the
    premade roster intact, and it is the honest answer: the id really is taken.
    The second half of the rule lives in :func:`_build_characters` — a cloned
    Character already on disk is NOT overwritten, so an install that predates
    this check still shows the collided Character and can delete it.

    Call before doing any work, so a refusal leaves no orphan embedding.
    """
    if character_id in BUILTIN_IDS:
        raise HTTPException(
            409,
            f"'{name}' collides with the built-in character '{character_id}' — "
            "pick a different name")


def slot_holder(meta: dict, character_id: str, emotion: str,
                *, exclude: str | None = None) -> str | None:
    """The voice_id already occupying (character_id, emotion), or None.

    `(character_id, emotion)` is the registry's primary key in everything but
    name: `emotion_map` (the synthesis lookup) and the manifest both reduce a
    Character's voices to ONE voice per emotion, so a second row for the same
    slot is a voice that exists in the roster and can never be spoken.
    Every write path resolves the slot through this one function.
    """
    for vid, m in meta["voices"].items():
        if vid == exclude:
            continue
        if m.get("character_id") == character_id and m.get("emotion") == emotion:
            return vid
    return None


def reject_slot_collision(meta: dict, character_id: str, emotion: str,
                          *, exclude: str | None = None) -> None:
    """409 if (character_id, emotion) is taken, NAMING the voice that holds it.

    The holder is in the message on purpose: "already has a 'sad' voice" leaves
    the user hunting through the roster for a Voice they may not remember
    recording, and there is no merge/rename flow to fall back on. With the id
    they can delete it (DELETE /v1/voices/{id}) or re-slot it.
    """
    holder = slot_holder(meta, character_id, emotion, exclude=exclude)
    if holder is not None:
        raise HTTPException(
            409,
            f"'{character_id}' already has a '{emotion}' voice ({holder}) — "
            "delete or re-slot that voice first")


def _by_emotion(voices: list[Voice]) -> dict[str, Voice]:
    """emotion -> the ONE Voice that serves it, for a Character's voice list.

    Pre-existing duplicate slots (rows written before uniqueness was enforced
    on every path) are TOLERATED, not crashed on, and resolved the same way
    everywhere: the first voice in the caller's order wins, the rest are logged.

    They are deliberately NOT dropped from the roster — a Voice that is invisible
    is also undeletable, which is exactly the failure the built-in collision
    rule repudiates. So the roster keeps showing both (coverage counts distinct
    emotions, so the count stays honest) while `emotion_map` and the manifest
    agree on which one actually speaks.
    """
    out: dict[str, Voice] = {}
    for v in voices:
        if v.emotion in out:
            logger.warning(
                "character '%s' has two voices for '%s' (%s and %s); %s serves the "
                "slot — delete one to resolve", v.character_id, v.emotion,
                out[v.emotion].voice_id, v.voice_id, out[v.emotion].voice_id)
            continue
        out[v.emotion] = v
    return out


def _build_characters() -> list[Character]:
    meta = _load_meta()
    chars: dict[str, Character] = {}

    for v in _cloned_voices(meta):
        cm = meta["characters"].get(v.character_id, {})
        c = chars.get(v.character_id)
        if c is None:
            # Pack-import provenance is stamped on each imported voice's meta
            # entry ({"from", "at"}); surface it at the Character level.
            imported = meta["voices"].get(v.voice_id, {}).get("imported")
            c = Character(
                character_id=v.character_id, name=cm.get("name", v.character_id),
                category="cloned", tags=cm.get("tags", []), lang=v.lang, created=v.created,
                imported=imported if isinstance(imported, dict) else None,
            )
            chars[v.character_id] = c
        c.voices.append(v)

    for vid, lang in BUILTIN:
        if vid in chars:
            # A cloned Character already owns this id. This loop used to assign
            # unconditionally, which SILENTLY DELETED that Character from the
            # roster — the clone returned 201, the .safetensors and the registry
            # row were both on disk, and the user could neither see nor delete
            # it. Cloned wins; the built-in yields. New collisions are refused
            # at creation (reject_builtin_collision), so this only fires for a
            # row created before that check existed — exactly the install that
            # needs the Character back to be able to delete it.
            logger.warning(
                "cloned character '%s' shadows the built-in of the same name; "
                "the built-in is unavailable until the clone is deleted", vid)
            continue
        cm = meta["characters"].get(vid, {})
        chars[vid] = Character(
            character_id=vid, name=cm.get("name", vid.replace("_", " ").title()),
            category="premade", tags=cm.get("tags", []), lang=lang,
            voices=[Voice(voice_id=vid, character_id=vid, emotion=BASELINE,
                          name=vid.replace("_", " ").title(), category="premade", lang=lang)],
        )

    demand = _cached_demand()
    for c in chars.values():
        cm = meta["characters"].get(c.character_id, {})
        scale, custom = character_scale(cm, [v.emotion for v in c.voices])
        c.scale, c.custom_emotions, c.total = scale, custom, len(scale)
        order = {e: i for i, e in enumerate(scale)}
        c.voices.sort(key=lambda v: order.get(v.emotion, 99))
        c.emotions = [v.emotion for v in c.voices]
        c.coverage = len(set(c.emotions))
        # only slots still missing carry heat — recording one clears it
        c.demand = {e: n for e, n in demand_for(c.character_id, demand).items()
                    if e not in c.emotions}
    return sorted(chars.values(), key=lambda c: (c.category != "cloned", c.name.lower()))


def find_character(character_id: str) -> Character | None:
    """One assembled Character by id, or None.

    The single lookup over the roster. Every endpoint used to hand-roll this
    linear scan (~8 copies), so lookup semantics and the 404 message drifted
    between them; change it here instead.
    """
    return next((c for c in list_characters() if c.character_id == character_id), None)


def get_character_or_404(character_id: str) -> Character:
    """find_character, raising the canonical 404 when it's absent."""
    c = find_character(character_id)
    if c is None:
        raise HTTPException(404, "character not found")
    return c


def emotion_map(character_id: str) -> dict[str, str]:
    """emotion -> voice_id for one Character (used by /v1/speak)."""
    c = find_character(character_id)
    return {e: v.voice_id for e, v in _by_emotion(c.voices).items()} if c else {}


# ── endpoints ─────────────────────────────────────────────────────────────────
@router.get("/v1/emotions")
def get_scale(character_id: str | None = None) -> list[str]:
    """The base scale, or one Character's effective palette (base + custom)."""
    if not character_id:
        return EMOTION_SCALE
    return get_character_or_404(character_id).scale


@router.post("/v1/characters/{character_id}/emotions", response_model=Character, status_code=201)
def add_custom_emotion(character_id: str, req: EmotionReq) -> Character:
    """Extend a Character's palette with a custom emotion slot (empty until a
    Voice is recorded for it). The tag grammar and API addressing accept it
    immediately; requests fall back to baseline until it's filled."""
    try:
        emotion = normalize_emotion(req.name)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    if emotion in EMOTION_SCALE:
        raise HTTPException(409, f"'{emotion}' is already on the base scale")

    def _mut(meta: dict) -> None:
        if not any(m.get("character_id") == character_id for m in meta["voices"].values()):
            raise HTTPException(404, "character not found (built-ins cannot be extended)")
        cm = meta["characters"].setdefault(character_id, {"name": character_id, "tags": []})
        custom = list(cm.get("custom_emotions") or [])
        if emotion in custom:
            raise HTTPException(409, f"'{emotion}' is already in this character's palette")
        custom.append(emotion)
        cm["custom_emotions"] = custom

    mutate_meta(_mut)

    return get_character_or_404(character_id)


@router.delete("/v1/characters/{character_id}/emotions/{emotion}", status_code=204)
def remove_custom_emotion(character_id: str, emotion: str) -> None:
    """Drop an empty custom slot. Refuses while a Voice still occupies it —
    delete the Voice first (never silently destroy an embedding)."""
    # Normalized through the SAME validator that admitted the slot, so the
    # path param can address exactly the rows add_custom_emotion can create.
    try:
        emotion = normalize_emotion(emotion)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    if emotion in EMOTION_SCALE:
        raise HTTPException(400, "base-scale emotions cannot be removed")

    def _mut(meta: dict) -> None:
        in_use = any(m.get("character_id") == character_id and m.get("emotion") == emotion
                     for m in meta["voices"].values())
        if in_use:
            raise HTTPException(409, f"a Voice is recorded for '{emotion}' — delete it first")
        cm = meta["characters"].get(character_id)
        if not cm or emotion not in (cm.get("custom_emotions") or []):
            raise HTTPException(404, "custom emotion not found")
        cm["custom_emotions"] = [e for e in cm["custom_emotions"] if e != emotion]

    mutate_meta(_mut)


@router.get("/v1/characters", response_model=list[Character])
def get_characters() -> list[Character]:
    return list_characters()


@router.get("/v1/characters/{character_id}", response_model=Character)
def get_character(character_id: str) -> Character:
    """One assembled Character by id. Lets the studio's detail page fetch a
    single character instead of downloading the whole roster to `.find()` one."""
    return get_character_or_404(character_id)


def all_voices() -> list[Voice]:
    """Flat list of every Voice across every Character (built-in + cloned)."""
    return [v for c in list_characters() for v in c.voices]


@router.get("/v1/voices", response_model=VoiceList)
def get_voices() -> VoiceList:
    """List available voices, ElevenLabs-shaped: `{"voices": [...]}`.

    (Was a bare JSON array — EL clients read `.voices`, so the array is now
    wrapped. The studio lists via /v1/characters, not this endpoint.)"""
    return VoiceList(voices=all_voices())


@router.get("/v1/voices/{voice_id}", response_model=Voice)
def get_voice(voice_id: str) -> Voice:
    """One voice by id (ElevenLabs GET /v1/voices/{voice_id})."""
    for v in all_voices():
        if v.voice_id == voice_id:
            return v
    raise HTTPException(404, {"status": "voice_not_found",
                             "message": f"voice '{voice_id}' not found"})


@router.get("/v1/models", response_model=list[Model])
def get_models() -> list[Model]:
    """Describe Gravitone's synthesis model, ElevenLabs GET /v1/models-shaped.

    A single static model — pocket-tts, CPU-only, expressive TTS. Returned as a
    bare list to match ElevenLabs (its /v1/models returns an array)."""
    langs = [ModelLanguage(language_id=code, name=name)
             for (code, name) in _MODEL_LANGUAGES.values()]
    return [Model(
        model_id="gravitone_pocket_v1",
        name="Gravitone Pocket TTS",
        can_do_text_to_speech=True,
        languages=langs,
        description="Arm-native, CPU-only expressive text-to-speech (pocket-tts). "
                    "Emotion lives in the reference voice; expression is tuned via "
                    "voice_settings (temperature, stability, quality).",
    )]


@router.get("/v1/characters/{character_id}/manifest")
def character_manifest(character_id: str) -> dict:
    """Validated performance manifest: exactly which emotions this Character
    can perform natively, and what every other request will fall back to.
    Clients check this before directing a script (/v1/performance)."""
    c = get_character_or_404(character_id)
    # Same one-voice-per-emotion reduction as emotion_map, so the manifest can
    # never advertise a voice_id the synthesis path wouldn't pick (a dict
    # comprehension here let the LAST duplicate win while emotion_map took the
    # first).
    native = {
        e: {"voice_id": v.voice_id, "sample_seconds": v.sample_seconds,
            "consent": v.consent}
        for e, v in _by_emotion(c.voices).items()
    }
    # Same deterministic pick resolve() uses, so the manifest can never
    # advertise a fallback the synthesis path wouldn't actually choose.
    fallback = deterministic_fallback(native)
    return {
        "character_id": c.character_id,
        "name": c.name,
        "category": c.category,
        "emotion_scale": c.scale,          # base + this Character's custom slots
        "custom_emotions": c.custom_emotions,
        "performable": native,
        "missing": [e for e in c.scale if e not in native],
        "fallback": fallback,
        "coverage": f"{c.coverage}/{c.total}",
        "demand": c.demand,  # unmet requests per missing emotion
        "addressing": {
            "tts": f"POST /v1/text-to-speech/{c.character_id}:{{emotion}}",
            "speak": "POST /v1/speak with [emotion]...[/emotion] metatags",
            "performance": "POST /v1/performance with lines[].character_id",
        },
    }


# NOT async: this handler runs ffmpeg and a `service.export_stems` child
# process (seconds). On the event loop that froze every concurrent
# synthesis response and stream; as a `def` handler FastAPI runs it in the
# anyio threadpool where blocking is correct.
@router.post("/v1/voices", response_model=Voice, status_code=201)
def create_voice(
    file: UploadFile = File(...),
    character: str = Form(...),
    emotion: str = Form(BASELINE),
    tags: str = Form(""),
    attested: str = Form(""),
    statement: str = Form(""),
) -> Voice:
    """Clone one Voice (a character in a given emotion) from a recording.
    A novel emotion name self-registers as a custom slot on this Character.

    Cloning requires an ownership attestation: `attested` must be "true" and
    `statement` non-empty. On success a consent receipt — the SAME shape ingest
    stamps ({consented_at, clip_sha256, statement}) — is written into the
    Voice's meta entry, so an API-cloned Voice carries provenance too."""
    if attested.strip().lower() != "true" or not statement.strip():
        raise HTTPException(422, "ownership attestation required to clone a voice")
    statement = statement.strip()
    try:
        emotion = normalize_emotion(emotion or BASELINE)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    cid = _slug(character)
    # Before any work: a name that slugs onto a built-in id is refused, so the
    # clone never gets made and no orphan embedding is left behind.
    reject_builtin_collision(cid, character.strip() or cid)

    holder = emotion_map(cid).get(emotion)
    if holder:  # fast fail; re-checked under the lock in _commit
        raise HTTPException(
            409, f"'{character}' already has a '{emotion}' voice ({holder}) — "
            "delete or re-slot that voice first")

    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    voice_id = f"{cid}-{emotion}-{uuid.uuid4().hex[:6]}"
    try:
        out_path = voice_file_path(voice_id)
    except ValueError as exc:  # unreachable: emotion + cid are both validated
        raise HTTPException(400, str(exc))

    with tempfile.TemporaryDirectory(prefix="gravitone-clone-") as td:
        tmp = Path(td)
        raw = tmp / f"raw-{file.filename or 'upload'}"
        raw_bytes = file.file.read()  # sync read — we're on the threadpool
        clip_sha256 = hashlib.sha256(raw_bytes).hexdigest()
        raw.write_bytes(raw_bytes)
        # Same canonical cleanup chain (denoise + loudnorm) as the ingest
        # pipeline — one filter for every clone path. Imported lazily to avoid a
        # module-load cycle (ingest imports voices).
        from service.ingest import clean_audio
        clean = tmp / "clean.wav"
        try:
            clean_audio(raw, clean)
        except RuntimeError as exc:
            raise HTTPException(400, f"could not decode audio: {str(exc)[-200:]}")
        seconds = _wav_seconds(clean)
        if seconds and seconds < 3:
            raise HTTPException(400, "recording too short — use at least 3 seconds (10–30s is best)")
        # The embedding is exported into the TEMP dir, not straight into
        # VOICES_DIR, and only moved into place once the registry row is
        # committed. The roster is glob-driven (`_cloned_voices`), so a
        # .safetensors sitting in VOICES_DIR with no registry row IS a
        # character: exporting first meant a failed commit (a file_lock
        # TimeoutError, an OSError in _save_meta, a 409 from the slot re-check)
        # left a phantom Character slugged from the voice id, which the user
        # never asked for. Staged here, that failure takes the file with it.
        staged = tmp / f"{voice_id}.safetensors"
        # The SAME exporter the ingest commit uses (service/export_stems.py):
        # one model load, and — the reason this path changed — a round-trip
        # load-back of the embedding it just wrote, with the proven
        # `pocket_tts export-voice` CLI kept as the fallback when anything in
        # that route fails. Spawning the CLI directly, as this endpoint used to,
        # verified nothing: a serializer or format mismatch registered a voice
        # that then failed at synthesis time, long after the user had left.
        # A clone that cannot be loaded back now fails the REQUEST, and (with
        # the staging above) leaves nothing registered.
        err = export_stems.export_batch(
            [{"emotion": emotion, "src": clean, "dst": staged}],
            language=SETTINGS.language, quantize=SETTINGS.quantize,
            spec_dir=tmp).get(emotion)
        if err is not None or not staged.is_file():
            # The exporter's error carries subprocess stderr — server internals.
            # Log it, hand the caller a request id (same leak posture as the
            # synthesis 500 in app.py).
            raise errors.sanitized_500(
                "clone", errors.tail(err or "exporter wrote no embedding"))

        created = datetime.now(timezone.utc).isoformat(timespec="seconds")

        def _commit(meta: dict) -> None:
            # Re-check the emotion slot UNDER the registry lock. The check at
            # the top of create_voice is a fast fail, but the multi-second clone
            # widens the window — a concurrent clone of the same
            # character+emotion could have committed since, and without this
            # re-check both would write (duplicate/orphaned embeddings for one
            # slot). Mirrors import_pack. The embedding is still staged in the
            # temp dir here, so this refusal has nothing to clean up.
            reject_slot_collision(meta, cid, emotion)
            meta["voices"][voice_id] = {
                "name": character.strip(), "character_id": cid, "emotion": emotion,
                "created": created, "sample_seconds": seconds, "lang": "EN",
                # Same consent-receipt shape ingest stamps (see ingest.commit).
                "consent": {
                    "consented_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    "clip_sha256": clip_sha256, "statement": statement},
            }
            cm = meta["characters"].setdefault(cid, {"name": character.strip(), "tags": []})
            for t in (t.strip().lower() for t in tags.split(",") if t.strip()):
                if t not in cm["tags"]:
                    cm["tags"].append(t)
            if emotion not in EMOTION_SCALE:  # novel emotion → custom slot
                custom = list(cm.get("custom_emotions") or [])
                if emotion not in custom:
                    custom.append(emotion)
                cm["custom_emotions"] = custom

        mutate_meta(_commit)

        # Registry first, file second — then publish the embedding the row
        # already promises. If THIS fails the row is retracted immediately, so
        # a failed clone never leaves the registry claiming a file that is not
        # there (and never leaves a file the registry has never heard of).
        try:
            shutil.move(str(staged), str(out_path))
        except OSError as exc:
            remove_voices([voice_id])
            raise errors.sanitized_500("clone", exc)

    return Voice(voice_id=voice_id, character_id=cid, emotion=emotion,
                 name=f"{character.strip()} · {emotion}", category="cloned",
                 created=created, sample_seconds=seconds, consent=True)


@router.patch("/v1/voices/{voice_id}", response_model=Voice)
def patch_voice(voice_id: str, patch: VoicePatch) -> Voice:
    """Re-slot a cloned Voice onto another emotion.

    This route used to be the ONLY way into the registry that skipped the
    module's own invariants: a bare `.strip().lower()` (so "Battle Cry" or
    "a.b" — names the metatag grammar can never address — landed in a row), no
    uniqueness check (so both of a Character's voices could claim 'sad', after
    which `emotion_map` spoke one and the roster counted the other), and no
    custom-slot registration. It now goes through exactly what `create_voice`
    goes through, under the same lock.
    """
    emotion: str | None = None
    if patch.emotion is not None:
        try:
            emotion = normalize_emotion(patch.emotion)
        except ValueError as exc:
            raise HTTPException(400, str(exc))

    def _mut(meta: dict) -> Voice:
        entry = meta["voices"].get(voice_id)
        if entry is None:
            raise HTTPException(404, "voice not found")
        if emotion is not None and emotion != entry.get("emotion"):
            cid = entry["character_id"]
            # Under the lock, excluding this voice (a no-op re-slot onto its own
            # emotion must not 409 against itself).
            reject_slot_collision(meta, cid, emotion, exclude=voice_id)
            entry["emotion"] = emotion
            if emotion not in EMOTION_SCALE:
                # Same self-registration create_voice does: a novel emotion
                # becomes a declared custom slot on the Character, so it
                # survives the Voice being deleted and shows up in /v1/emotions.
                cm = meta["characters"].setdefault(cid, {"name": cid, "tags": []})
                custom = list(cm.get("custom_emotions") or [])
                if emotion not in custom:
                    custom.append(emotion)
                cm["custom_emotions"] = custom
        cname = meta["characters"].get(entry["character_id"], {}).get("name", entry["character_id"])
        return Voice(voice_id=voice_id, character_id=entry["character_id"], emotion=entry["emotion"],
                     name=f"{cname} · {entry['emotion']}", category="cloned",
                     created=entry.get("created"), sample_seconds=entry.get("sample_seconds"))

    return mutate_meta(_mut)


def _unlink_then_forget(meta: dict, voice_ids: list[str]) -> tuple[list[str], list[str]]:
    """Delete embeddings, then drop ONLY the rows whose file is really gone.

    THE deletion ordering, in one place, for every path that removes a Voice
    (delete_voice, delete_character, remove_voices). Two rules:

      * **File first, row second.** The roster is glob-driven, so a
        .safetensors with no registry row is a phantom Character. Popping the
        row first and unlinking after meant a file that refused to unlink came
        back as a phantom the caller had already reported as deleted.
      * **A file that could not be deleted keeps its row.** The Voice is then
        still exactly what it was — visible, addressable, deletable again —
        instead of the registry disagreeing with the disk.

    Never raises: it runs inside a `mutate_meta` mutation fn, and raising there
    skips the save, which would throw away the deletions that DID succeed and
    leave the registry claiming files that are gone. Callers inspect the
    returned ``(removed, failed)`` and decide what to tell the user.
    """
    removed: list[str] = []
    failed: list[str] = []
    for vid in voice_ids:
        path = VOICES_DIR / f"{vid}.safetensors"
        try:
            path.unlink(missing_ok=True)  # already-missing counts as removed
        except OSError as exc:
            logger.warning("could not delete embedding %s: %s", path, exc)
            failed.append(vid)
            continue
        meta["voices"].pop(vid, None)
        removed.append(vid)
    return removed, failed


def remove_voices(voice_ids: list[str]) -> list[str]:
    """Delete specific cloned Voices — registry entries AND embedding files.

    The rollback primitive for a half-finished clone: a cancelled ingest commit
    has already registered the emotions it got through, and leaving them turns
    a cancel into "you now own a partial Character you never asked for".

    Only the ids passed in are touched, so a cancelled *extend* leaves the
    character's pre-existing Voices alone. A Character left with no Voices at
    all is dropped too — it was created by this same commit and an empty
    character is a ghost row in the roster. Missing ids are ignored (the point
    is to converge on "not registered", not to assert what was there).

    Returns the ids actually removed — file gone AND row gone. Best-effort by
    design: it runs on a teardown path, so a file that refuses to unlink is
    logged, not raised, and (per `_unlink_then_forget`) KEEPS its registry row.
    The old order — pop the rows, unlink after — meant such a file came back as
    a phantom Character while the caller had already logged "rolled back".
    """
    if not voice_ids:
        return []
    removed: list[str] = []

    def _mut(meta: dict) -> None:
        known = {vid: meta["voices"].get(vid, {}) for vid in dict.fromkeys(voice_ids)
                 if vid in meta["voices"]}
        gone, _failed = _unlink_then_forget(meta, list(known))
        removed.extend(gone)
        # Drop characters this rollback emptied (an extend keeps its own).
        for cid in {(known[vid] or {}).get("character_id") for vid in gone} - {None}:
            still_has = any(m.get("character_id") == cid for m in meta["voices"].values())
            if not still_has:
                meta["characters"].pop(cid, None)

    mutate_meta(_mut)
    return removed


@router.delete("/v1/voices/{voice_id}", status_code=204)
def delete_voice(voice_id: str) -> None:
    # A cloned Voice is EITHER half on its own: the embedding file (which the
    # glob-driven roster turns into a Character all by itself) or the registry
    # row. This used to 404 whenever the FILE was missing, before it looked at
    # the registry at all, so a row whose file vanished out-of-band — or was
    # left behind by a half-failed delete — could never be removed through the
    # API at all. Either half is enough to delete; neither is a 404.
    def _mut(meta: dict) -> tuple[list[str], list[str]]:
        if voice_id not in meta["voices"] and not (VOICES_DIR / f"{voice_id}.safetensors").is_file():
            raise HTTPException(404, "cloned voice not found (built-in voices cannot be deleted)")
        return _unlink_then_forget(meta, [voice_id])

    _removed, failed = mutate_meta(_mut)
    if failed:
        # The embedding is still there, and so is its registry row: the Voice is
        # unchanged rather than half-deleted. Say so instead of returning 204.
        raise errors.sanitized_500(
            "voice delete", f"could not delete embedding for {voice_id}")


@router.patch("/v1/characters/{character_id}", response_model=Character)
def patch_character(character_id: str, patch: CharacterPatch) -> Character:
    """Rename / retag a CLONED Character.

    Built-ins are refused, like every other mutating character route
    (`add_custom_emotion`, `delete_voice`, `delete_character`): the premade
    roster ships with the service, a rename would be a registry row shadowing a
    name other installs still call by its old one, and nothing could restore it
    except editing _meta.json by hand. The `setdefault` here also used to MINT a
    row for any id at all, so a typo'd id created a character with no voices —
    a ghost that the roster never shows and no route can delete.
    """
    if character_id in BUILTIN_IDS:
        raise HTTPException(409, f"'{character_id}' is a built-in character and cannot be renamed")

    def _mut(meta: dict) -> None:
        if not any(m.get("character_id") == character_id for m in meta["voices"].values()):
            raise HTTPException(404, "character not found (built-ins cannot be edited)")
        cm = meta["characters"].setdefault(character_id, {"name": character_id, "tags": []})
        if patch.name:
            cm["name"] = patch.name.strip()
        if patch.tags is not None:
            cm["tags"] = [t.strip().lower() for t in patch.tags if t.strip()]

    mutate_meta(_mut)
    return get_character_or_404(character_id)


@router.delete("/v1/characters/{character_id}", status_code=204)
def delete_character(character_id: str) -> None:
    def _mut(meta: dict) -> list[str]:
        ids = [vid for vid, m in meta["voices"].items() if m.get("character_id") == character_id]
        if not ids:
            raise HTTPException(404, "character has no cloned voices (built-ins cannot be deleted)")
        # A mid-loop unlink failure used to RAISE out of the mutation fn, which
        # skips the save: N-1 embeddings were already gone and the registry
        # still claimed all N. `_unlink_then_forget` never raises, so the rows
        # for the files that really went away are committed, the rows for the
        # files that survived stay accurate, and the failure is reported after
        # the save rather than instead of it.
        _removed, failed = _unlink_then_forget(meta, ids)
        if not failed:
            meta["characters"].pop(character_id, None)
        return failed

    failed = mutate_meta(_mut)
    if failed:
        # Partially deleted: the surviving Voices are still registered and still
        # usable. Never report 204 for that.
        raise errors.sanitized_500(
            "character delete",
            f"could not delete {len(failed)} embedding(s) for {character_id}")
