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
from service.emotions import BASELINE, EMOTION_SCALE

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
        ))
    return out


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
        order = {e: i for i, e in enumerate(EMOTION_SCALE)}
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
def get_scale() -> list[str]:
    return EMOTION_SCALE


@router.get("/v1/characters", response_model=list[Character])
def get_characters() -> list[Character]:
    return list_characters()


@router.get("/v1/voices", response_model=list[Voice])
def get_voices() -> list[Voice]:
    return [v for c in list_characters() for v in c.voices]


@router.get("/v1/characters/{character_id}/manifest")
def character_manifest(character_id: str) -> dict:
    """Validated performance manifest: exactly which emotions this Character
    can perform natively, and what every other request will fall back to.
    Clients check this before directing a script (/v1/performance)."""
    for c in list_characters():
        if c.character_id != character_id:
            continue
        native = {
            v.emotion: {"voice_id": v.voice_id, "sample_seconds": v.sample_seconds}
            for v in c.voices
        }
        fallback = BASELINE if BASELINE in native else next(iter(native), None)
        return {
            "character_id": c.character_id,
            "name": c.name,
            "category": c.category,
            "emotion_scale": EMOTION_SCALE,
            "performable": native,
            "missing": [e for e in EMOTION_SCALE if e not in native],
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
    """Clone one Voice (a character in a given emotion) from a recording."""
    emotion = emotion.strip().lower() or BASELINE
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
        clean = tmp / "clean.wav"
        ff = subprocess.run(
            ["ffmpeg", "-y", "-i", str(raw), "-af", "highpass=f=80,loudnorm",
             "-ac", "1", "-ar", "24000", str(clean)], capture_output=True)
        if ff.returncode != 0 or not clean.is_file():
            raise HTTPException(400, f"could not decode audio: {ff.stderr.decode(errors='ignore')[:200]}")
        seconds = _wav_seconds(clean)
        if seconds and seconds < 3:
            raise HTTPException(400, "recording too short — use at least 5 seconds (10–30s is best)")
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
