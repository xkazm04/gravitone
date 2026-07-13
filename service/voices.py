"""Voice + Character management.

A **Voice** is one embedding (one speaker, one emotion). A **Character** groups
Voices of the same speaker across the emotion scale. See `service/emotions.py`
for the vocabulary and the metatag grammar.

Cloning runs `pocket-tts export-voice` in a subprocess so the (heavy) model load
is isolated from the serving workers. Metadata lives in `voices/_meta.json`.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
import uuid
import wave
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from service.config import SETTINGS
from service.demand import all_demand, demand_for
from service.emotions import BASELINE, EMOTION_SCALE, normalize_emotion

router = APIRouter(tags=["voices"])

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
    name: str | None = None
    emotion: str | None = None


class CharacterPatch(BaseModel):
    name: str | None = None
    tags: list[str] | None = None


# ── meta store ────────────────────────────────────────────────────────────────
def _load_meta() -> dict:
    if not META_PATH.is_file():
        return {"voices": {}, "characters": {}}
    try:
        raw = json.loads(META_PATH.read_text("utf-8"))
    except json.JSONDecodeError:
        return {"voices": {}, "characters": {}}
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
    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    META_PATH.write_text(json.dumps(meta, indent=2), "utf-8")


def _slug(name: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", name.strip().lower()).strip("-")
    return s or "character"


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
    meta = _load_meta()
    chars: dict[str, Character] = {}

    for v in _cloned_voices(meta):
        cm = meta["characters"].get(v.character_id, {})
        c = chars.get(v.character_id)
        if c is None:
            c = Character(
                character_id=v.character_id, name=cm.get("name", v.character_id),
                category="cloned", tags=cm.get("tags", []), lang=v.lang, created=v.created,
            )
            chars[v.character_id] = c
        c.voices.append(v)

    for vid, lang in BUILTIN:
        cm = meta["characters"].get(vid, {})
        chars[vid] = Character(
            character_id=vid, name=cm.get("name", vid.replace("_", " ").title()),
            category="premade", tags=cm.get("tags", []), lang=lang,
            voices=[Voice(voice_id=vid, character_id=vid, emotion=BASELINE,
                          name=vid.replace("_", " ").title(), category="premade", lang=lang)],
        )

    demand = all_demand()
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


def emotion_map(character_id: str) -> dict[str, str]:
    """emotion -> voice_id for one Character (used by /v1/speak)."""
    for c in list_characters():
        if c.character_id == character_id:
            return {v.emotion: v.voice_id for v in c.voices}
    return {}


# ── endpoints ─────────────────────────────────────────────────────────────────
@router.get("/v1/emotions")
def get_scale(character_id: str | None = None) -> list[str]:
    """The base scale, or one Character's effective palette (base + custom)."""
    if not character_id:
        return EMOTION_SCALE
    for c in list_characters():
        if c.character_id == character_id:
            return c.scale
    raise HTTPException(404, "character not found")


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

    meta = _load_meta()
    if not any(m.get("character_id") == character_id for m in meta["voices"].values()):
        raise HTTPException(404, "character not found (built-ins cannot be extended)")
    cm = meta["characters"].setdefault(character_id, {"name": character_id, "tags": []})
    custom = list(cm.get("custom_emotions") or [])
    if emotion in custom:
        raise HTTPException(409, f"'{emotion}' is already in this character's palette")
    custom.append(emotion)
    cm["custom_emotions"] = custom
    _save_meta(meta)

    for c in list_characters():
        if c.character_id == character_id:
            return c
    raise HTTPException(404, "character not found")


@router.delete("/v1/characters/{character_id}/emotions/{emotion}", status_code=204)
def remove_custom_emotion(character_id: str, emotion: str) -> None:
    """Drop an empty custom slot. Refuses while a Voice still occupies it —
    delete the Voice first (never silently destroy an embedding)."""
    emotion = emotion.strip().lower()
    if emotion in EMOTION_SCALE:
        raise HTTPException(400, "base-scale emotions cannot be removed")
    meta = _load_meta()
    in_use = any(m.get("character_id") == character_id and m.get("emotion") == emotion
                 for m in meta["voices"].values())
    if in_use:
        raise HTTPException(409, f"a Voice is recorded for '{emotion}' — delete it first")
    cm = meta["characters"].get(character_id)
    if not cm or emotion not in (cm.get("custom_emotions") or []):
        raise HTTPException(404, "custom emotion not found")
    cm["custom_emotions"] = [e for e in cm["custom_emotions"] if e != emotion]
    _save_meta(meta)


@router.get("/v1/characters", response_model=list[Character])
def get_characters() -> list[Character]:
    return list_characters()


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
    for c in list_characters():
        if c.character_id != character_id:
            continue
        native = {
            v.emotion: {"voice_id": v.voice_id, "sample_seconds": v.sample_seconds,
                        "consent": v.consent}
            for v in c.voices
        }
        fallback = BASELINE if BASELINE in native else next(iter(native), None)
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
    raise HTTPException(404, "character not found")


@router.post("/v1/voices", response_model=Voice, status_code=201)
async def create_voice(
    file: UploadFile = File(...),
    character: str = Form(...),
    emotion: str = Form(BASELINE),
    tags: str = Form(""),
) -> Voice:
    """Clone one Voice (a character in a given emotion) from a recording.
    A novel emotion name self-registers as a custom slot on this Character."""
    try:
        emotion = normalize_emotion(emotion or BASELINE)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    cid = _slug(character)
    meta = _load_meta()

    if emotion in emotion_map(cid):
        raise HTTPException(409, f"'{character}' already has a '{emotion}' voice")

    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    voice_id = f"{cid}-{emotion}-{uuid.uuid4().hex[:6]}"
    out_path = VOICES_DIR / f"{voice_id}.safetensors"

    with tempfile.TemporaryDirectory(prefix="gravitone-clone-") as td:
        tmp = Path(td)
        raw = tmp / f"raw-{file.filename or 'upload'}"
        raw.write_bytes(await file.read())
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
        ex = subprocess.run(
            [sys.executable, "-m", "pocket_tts", "export-voice", str(clean), str(out_path)],
            capture_output=True)
        if ex.returncode != 0 or not out_path.is_file():
            raise HTTPException(500, f"clone failed: {ex.stderr.decode(errors='ignore')[-400:]}")

    created = datetime.now(timezone.utc).isoformat(timespec="seconds")
    meta["voices"][voice_id] = {
        "name": character.strip(), "character_id": cid, "emotion": emotion,
        "created": created, "sample_seconds": seconds, "lang": "EN",
    }
    cm = meta["characters"].setdefault(cid, {"name": character.strip(), "tags": []})
    for t in (t.strip().lower() for t in tags.split(",") if t.strip()):
        if t not in cm["tags"]:
            cm["tags"].append(t)
    if emotion not in EMOTION_SCALE:  # novel emotion → custom slot on this Character
        custom = list(cm.get("custom_emotions") or [])
        if emotion not in custom:
            custom.append(emotion)
        cm["custom_emotions"] = custom
    _save_meta(meta)

    return Voice(voice_id=voice_id, character_id=cid, emotion=emotion,
                 name=f"{character.strip()} · {emotion}", category="cloned",
                 created=created, sample_seconds=seconds)


@router.patch("/v1/voices/{voice_id}", response_model=Voice)
def patch_voice(voice_id: str, patch: VoicePatch) -> Voice:
    meta = _load_meta()
    entry = meta["voices"].get(voice_id)
    if entry is None:
        raise HTTPException(404, "voice not found")
    if patch.emotion:
        entry["emotion"] = patch.emotion.strip().lower()
    if patch.name:
        entry["name"] = patch.name.strip()
    _save_meta(meta)
    cname = meta["characters"].get(entry["character_id"], {}).get("name", entry["character_id"])
    return Voice(voice_id=voice_id, character_id=entry["character_id"], emotion=entry["emotion"],
                 name=f"{cname} · {entry['emotion']}", category="cloned",
                 created=entry.get("created"), sample_seconds=entry.get("sample_seconds"))


@router.delete("/v1/voices/{voice_id}", status_code=204)
def delete_voice(voice_id: str) -> None:
    path = VOICES_DIR / f"{voice_id}.safetensors"
    if not path.is_file():
        raise HTTPException(404, "cloned voice not found (built-in voices cannot be deleted)")
    path.unlink()
    meta = _load_meta()
    meta["voices"].pop(voice_id, None)
    _save_meta(meta)


@router.patch("/v1/characters/{character_id}", response_model=Character)
def patch_character(character_id: str, patch: CharacterPatch) -> Character:
    meta = _load_meta()
    cm = meta["characters"].setdefault(character_id, {"name": character_id, "tags": []})
    if patch.name:
        cm["name"] = patch.name.strip()
    if patch.tags is not None:
        cm["tags"] = [t.strip().lower() for t in patch.tags if t.strip()]
    _save_meta(meta)
    for c in list_characters():
        if c.character_id == character_id:
            return c
    raise HTTPException(404, "character not found")


@router.delete("/v1/characters/{character_id}", status_code=204)
def delete_character(character_id: str) -> None:
    meta = _load_meta()
    ids = [vid for vid, m in meta["voices"].items() if m.get("character_id") == character_id]
    if not ids:
        raise HTTPException(404, "character has no cloned voices (built-ins cannot be deleted)")
    for vid in ids:
        (VOICES_DIR / f"{vid}.safetensors").unlink(missing_ok=True)
        meta["voices"].pop(vid, None)
    meta["characters"].pop(character_id, None)
    _save_meta(meta)
