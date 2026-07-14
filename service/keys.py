"""API key management — issue / rotate / revoke, copy-once secrets.

Keys gate access to the TTS API for OTHER apps/use-cases. The full secret is
shown exactly once (on create/rotate); only a SHA-256 hash + a display prefix
are stored. `validate_key` is available for enforcing access on the TTS
endpoints (kept advisory by default so the local playground proxy still works).
"""
from __future__ import annotations

import hashlib
import json
import logging
import secrets
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from service.atomicio import atomic_write_text
from service.config import SETTINGS

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/keys", tags=["keys"])

KEYS_PATH = Path(SETTINGS.voices_dir).parent / "api_keys.json"

# The key store is a single JSON file mutated by concurrent authenticated
# requests. Serialize every read-modify-write under one process-wide lock so
# interleaved writes can't truncate/corrupt it. `last_used` bumps are hot (one
# per authenticated request) but low-value, so they are debounced: the
# in-memory view is always current, but the file is only rewritten when the
# persisted timestamp is stale by more than _LAST_USED_DEBOUNCE_S.
_STORE_LOCK = threading.Lock()
_LAST_USED_DEBOUNCE_S = 60.0
_LAST_USED: dict[str, str] = {}        # kid -> current iso timestamp (in-memory)
_LAST_PERSIST: dict[str, float] = {}   # kid -> monotonic time of last file write
# tts=synthesize, voices=manage, clone=upload,
# performance=multi-character scripts (/v1/performance — the premium tier)
SCOPES = ["tts", "voices", "clone", "performance"]


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
            # Atomic writes (below) prevent our own writes from ever truncating
            # this file, so a corrupt store means external damage. Log LOUDLY —
            # returning {} silently would let the next create_key overwrite the
            # (recoverable) file and permanently erase every surviving key.
            logger.error("api_keys.json is corrupt and could not be parsed; "
                         "treating as empty — inspect/restore %s before issuing keys", KEYS_PATH)
            return {}
    return {}


def _save(data: dict) -> None:
    # Atomic temp-file + os.replace: a crash or an interleaved replica write can
    # no longer truncate api_keys.json (which _load would then read as {}).
    atomic_write_text(KEYS_PATH, json.dumps(data, indent=2))


def _hash(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def _new_secret() -> tuple[str, str]:
    body = secrets.token_hex(20)
    secret = f"gvt_{body}"
    prefix = f"gvt_{body[:6]}…"
    return secret, prefix


def _public(k: dict) -> ApiKey:
    # Prefer the in-memory last_used so a debounced (not-yet-persisted) bump is
    # still reflected to callers.
    last_used = _LAST_USED.get(k["id"], k.get("last_used"))
    return ApiKey(
        id=k["id"], name=k["name"], prefix=k["prefix"], scopes=k["scopes"],
        created=k["created"], last_used=last_used, revoked=k.get("revoked", False),
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
    with _STORE_LOCK:
        data = _load()
        data[kid] = {
            "id": kid, "name": req.name.strip() or "Untitled key", "prefix": prefix,
            "hash": _hash(secret), "scopes": req.scopes or ["tts"], "created": created,
            "last_used": None, "revoked": False,
        }
        _save(data)
        entry = data[kid]
    return ApiKeyWithSecret(**_public(entry).model_dump(), secret=secret)


@router.post("/{kid}/rotate", response_model=ApiKeyWithSecret)
def rotate_key(kid: str) -> ApiKeyWithSecret:
    secret, prefix = _new_secret()
    with _STORE_LOCK:
        data = _load()
        if kid not in data:
            raise HTTPException(404, "key not found")
        # Rotating must NEVER silently resurrect a revoked key.
        if data[kid].get("revoked"):
            raise HTTPException(409, "cannot rotate a revoked key")
        data[kid]["hash"] = _hash(secret)
        data[kid]["prefix"] = prefix
        _save(data)
        entry = data[kid]
    return ApiKeyWithSecret(**_public(entry).model_dump(), secret=secret)


@router.delete("/{kid}", status_code=204)
def delete_key(kid: str) -> None:
    with _STORE_LOCK:
        data = _load()
        if kid not in data:
            raise HTTPException(404, "key not found")
        del data[kid]
        _save(data)
        _LAST_USED.pop(kid, None)
        _LAST_PERSIST.pop(kid, None)


def validate_key(secret: str | None, scope: str = "tts") -> bool:
    """True if `secret` is an active key with `scope`. Bumps last_used
    (in-memory always; persisted at most once per _LAST_USED_DEBOUNCE_S)."""
    if not secret:
        return False
    h = _hash(secret)
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with _STORE_LOCK:
        data = _load()
        for kid, k in data.items():
            # Constant-time hash compare — same timing-side-channel reasoning as
            # the root-key check in service/auth.py.
            if (secrets.compare_digest(str(k.get("hash") or ""), h)
                    and not k.get("revoked") and scope in k.get("scopes", [])):
                _LAST_USED[kid] = now_iso  # in-memory view is always current
                k["last_used"] = now_iso
                last = _LAST_PERSIST.get(kid)
                if last is None or (time.monotonic() - last) > _LAST_USED_DEBOUNCE_S:
                    _save(data)
                    _LAST_PERSIST[kid] = time.monotonic()
                return True
    return False
