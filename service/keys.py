"""API key management — issue / rotate / revoke, copy-once secrets.

Keys gate access to the TTS API for OTHER apps/use-cases. The full secret is
shown exactly once (on create/rotate); only a SHA-256 hash + a display prefix
are stored. `validate_key` is available for enforcing access on the TTS
endpoints (kept advisory by default so the local playground proxy still works).
"""
from __future__ import annotations

import hashlib
import json
import secrets
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from service.config import SETTINGS

router = APIRouter(prefix="/v1/keys", tags=["keys"])

KEYS_PATH = Path(SETTINGS.voices_dir).parent / "api_keys.json"
SCOPES = ["tts", "voices", "clone"]  # tts=synthesize, voices=manage, clone=upload


class ApiKey(BaseModel):
    id: str
    name: str
    prefix: str  # e.g. "gvt_1a2b…" (display only)
    scopes: list[str]
    created: str
    last_used: str | None = None
    revoked: bool = False


class ApiKeyWithSecret(ApiKey):
    secret: str  # full key — returned ONCE on create/rotate


class CreateKey(BaseModel):
    name: str
    scopes: list[str] = ["tts"]


def _load() -> dict:
    if KEYS_PATH.is_file():
        try:
            return json.loads(KEYS_PATH.read_text("utf-8"))
        except json.JSONDecodeError:
            return {}
    return {}


def _save(data: dict) -> None:
    KEYS_PATH.parent.mkdir(parents=True, exist_ok=True)
    KEYS_PATH.write_text(json.dumps(data, indent=2), "utf-8")


def _hash(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def _new_secret() -> tuple[str, str]:
    body = secrets.token_hex(20)
    secret = f"gvt_{body}"
    prefix = f"gvt_{body[:6]}…"
    return secret, prefix


def _public(k: dict) -> ApiKey:
    return ApiKey(
        id=k["id"], name=k["name"], prefix=k["prefix"], scopes=k["scopes"],
        created=k["created"], last_used=k.get("last_used"), revoked=k.get("revoked", False),
    )


@router.get("/scopes")
def scopes() -> list[str]:
    return SCOPES


@router.get("", response_model=list[ApiKey])
def list_keys() -> list[ApiKey]:
    data = _load()
    return sorted((_public(k) for k in data.values()), key=lambda k: k.created, reverse=True)


@router.post("", response_model=ApiKeyWithSecret, status_code=201)
def create_key(req: CreateKey) -> ApiKeyWithSecret:
    bad = [s for s in req.scopes if s not in SCOPES]
    if bad:
        raise HTTPException(400, f"unknown scopes: {bad}")
    secret, prefix = _new_secret()
    kid = uuid.uuid4().hex[:12]
    created = datetime.now(timezone.utc).isoformat(timespec="seconds")
    data = _load()
    data[kid] = {
        "id": kid, "name": req.name.strip() or "Untitled key", "prefix": prefix,
        "hash": _hash(secret), "scopes": req.scopes or ["tts"], "created": created,
        "last_used": None, "revoked": False,
    }
    _save(data)
    return ApiKeyWithSecret(**_public(data[kid]).model_dump(), secret=secret)


@router.post("/{kid}/rotate", response_model=ApiKeyWithSecret)
def rotate_key(kid: str) -> ApiKeyWithSecret:
    data = _load()
    if kid not in data:
        raise HTTPException(404, "key not found")
    secret, prefix = _new_secret()
    data[kid]["hash"] = _hash(secret)
    data[kid]["prefix"] = prefix
    data[kid]["revoked"] = False
    _save(data)
    return ApiKeyWithSecret(**_public(data[kid]).model_dump(), secret=secret)


@router.delete("/{kid}", status_code=204)
def delete_key(kid: str) -> None:
    data = _load()
    if kid not in data:
        raise HTTPException(404, "key not found")
    del data[kid]
    _save(data)


def validate_key(secret: str | None, scope: str = "tts") -> bool:
    """True if `secret` is an active key with `scope`. Updates last_used."""
    if not secret:
        return False
    h = _hash(secret)
    data = _load()
    for k in data.values():
        if k.get("hash") == h and not k.get("revoked") and scope in k.get("scopes", []):
            k["last_used"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
            _save(data)
            return True
    return False
