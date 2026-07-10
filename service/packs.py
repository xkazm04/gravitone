"""Character Packs — portable, integrity-checked character bundles.

A Character is already a self-contained asset (N per-emotion .safetensors
embeddings + a _meta.json slice). A pack makes it portable: one `.gravichar`
zip that any Gravitone instance — including CPU-only Arm edge boxes — imports
instantly, without re-running the ingest pipeline.

Format ("gravichar/1"): zip containing
  manifest.json           — character meta + per-voice entries with sha256
  voices/<voice_id>.safetensors  (ZIP_STORED — embeddings don't compress)

Integrity: every voice file carries a sha256 the importer verifies.
Authenticity (optional): when TTS_PACK_SECRET is set, the exporter HMAC-signs
the canonical manifest; an importer with the same secret rejects mismatches.
Real keypair signing / a public gallery are follow-ups (docs/harness).
"""
from __future__ import annotations

import hashlib
import hmac
import io
import json
import os
import uuid
import zipfile
from datetime import datetime, timezone

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

from service.voices import (
    VOICES_DIR, Character, _load_meta, _save_meta, _slug, list_characters,
)

router = APIRouter(tags=["packs"])

FORMAT = "gravichar/1"
MAX_VOICES = 64
MAX_VOICE_BYTES = 200 * 1024 * 1024  # per embedding; typical is ~10 MB

PACK_SECRET = os.environ.get("TTS_PACK_SECRET", "")


def _canonical(manifest: dict) -> bytes:
    unsigned = {k: v for k, v in manifest.items() if k != "signature"}
    return json.dumps(unsigned, sort_keys=True, separators=(",", ":")).encode()


def _sign(manifest: dict) -> dict:
    if PACK_SECRET:
        manifest["signature"] = {
            "alg": "HMAC-SHA256",
            "value": hmac.new(PACK_SECRET.encode(), _canonical(manifest), hashlib.sha256).hexdigest(),
        }
    return manifest


@router.get("/v1/characters/{character_id}/pack")
def export_pack(character_id: str) -> Response:
    """Bundle one cloned Character into a downloadable .gravichar pack."""
    character = next((c for c in list_characters() if c.character_id == character_id), None)
    if character is None:
        raise HTTPException(404, "character not found")
    if character.category != "cloned":
        raise HTTPException(400, "built-in characters cannot be exported (no embedding files)")

    voices = []
    blobs: list[tuple[str, bytes]] = []
    for v in character.voices:
        path = VOICES_DIR / f"{v.voice_id}.safetensors"
        if not path.is_file():
            continue
        data = path.read_bytes()
        arcname = f"voices/{v.voice_id}.safetensors"
        blobs.append((arcname, data))
        voices.append({
            "file": arcname, "voice_id": v.voice_id, "emotion": v.emotion,
            "sample_seconds": v.sample_seconds, "created": v.created,
            "sha256": hashlib.sha256(data).hexdigest(),
        })
    if not voices:
        raise HTTPException(400, "character has no exportable voice files")

    manifest = _sign({
        "format": FORMAT,
        "exported_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "generator": "gravitone",
        "character": {
            "character_id": character.character_id, "name": character.name,
            "tags": character.tags, "lang": character.lang,
        },
        "license": "",   # creator fills in before publishing
        "creator": "",
        "voices": voices,
    })

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_STORED) as z:
        z.writestr("manifest.json", json.dumps(manifest, indent=2))
        for arcname, data in blobs:
            z.writestr(arcname, data)

    return Response(
        content=buf.getvalue(), media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{character.character_id}.gravichar"',
            "X-Pack-Format": FORMAT,
            "X-Pack-Voices": str(len(voices)),
        },
    )


@router.post("/v1/characters/import", response_model=Character, status_code=201)
async def import_pack(
    file: UploadFile = File(...),
    rename: str = Form(""),
) -> Character:
    """Import a .gravichar pack. Fresh voice_ids are minted (no file
    collisions); pass `rename` to import under a different character name
    when the id is already taken."""
    try:
        z = zipfile.ZipFile(io.BytesIO(await file.read()))
    except zipfile.BadZipFile:
        raise HTTPException(400, "not a valid .gravichar pack (bad zip)")

    try:
        manifest = json.loads(z.read("manifest.json"))
    except (KeyError, json.JSONDecodeError):
        raise HTTPException(400, "pack has no readable manifest.json")
    if manifest.get("format") != FORMAT:
        raise HTTPException(400, f"unsupported pack format (want {FORMAT})")

    # Authenticity — enforced only when both sides use a shared secret.
    sig = manifest.get("signature")
    if PACK_SECRET and sig:
        want = hmac.new(PACK_SECRET.encode(), _canonical(manifest), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(want, str(sig.get("value", ""))):
            raise HTTPException(400, "pack signature does not match this instance's TTS_PACK_SECRET")

    voices = manifest.get("voices") or []
    if not voices or len(voices) > MAX_VOICES:
        raise HTTPException(400, f"pack must contain 1-{MAX_VOICES} voices")

    src = manifest.get("character") or {}
    name = (rename.strip() or src.get("name") or "Imported character").strip()
    cid = _slug(name)

    meta = _load_meta()
    taken = {m.get("character_id") for m in meta["voices"].values()}
    if cid in taken:
        raise HTTPException(409, f"character '{cid}' already exists — pass rename=<new name>")

    # Verify every hash BEFORE writing anything; never trust member paths.
    staged: list[tuple[dict, bytes]] = []
    for v in voices:
        arcname = str(v.get("file", ""))
        try:
            data = z.read(arcname)
        except KeyError:
            raise HTTPException(400, f"pack is missing {arcname}")
        if len(data) > MAX_VOICE_BYTES:
            raise HTTPException(400, f"{arcname} exceeds the {MAX_VOICE_BYTES // 2**20} MB limit")
        if hashlib.sha256(data).hexdigest() != v.get("sha256"):
            raise HTTPException(400, f"integrity check failed for {arcname} — pack is corrupted or tampered")
        staged.append((v, data))

    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    created = datetime.now(timezone.utc).isoformat(timespec="seconds")
    for v, data in staged:
        emotion = str(v.get("emotion") or "baseline").strip().lower()
        voice_id = f"{cid}-{emotion}-{uuid.uuid4().hex[:6]}"
        (VOICES_DIR / f"{voice_id}.safetensors").write_bytes(data)
        meta["voices"][voice_id] = {
            "name": name, "character_id": cid, "emotion": emotion,
            "created": v.get("created") or created,
            "sample_seconds": v.get("sample_seconds"), "lang": src.get("lang", "EN"),
            "imported": {"from": src.get("character_id"), "at": created},
        }
    meta["characters"].setdefault(cid, {"name": name, "tags": list(src.get("tags") or [])})
    _save_meta(meta)

    imported = next((c for c in list_characters() if c.character_id == cid), None)
    if imported is None:  # should be impossible — files were just written
        raise HTTPException(500, "import wrote files but the character did not materialize")
    return imported
