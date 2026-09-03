"""API key management — issue / rotate / revoke, copy-once secrets.

Keys gate access to the TTS API for OTHER apps/use-cases. The full secret is
shown exactly once (on create/rotate); only a SHA-256 hash + a display prefix
are stored. `validate_key` is available for enforcing access on the TTS
endpoints (kept advisory by default so the local playground proxy still works).

Three properties this module owes the rest of the service:

  * **Revocation is a first-class state.** ``POST /v1/keys/{kid}/revoke`` flips
    ``revoked`` — the key stops authenticating immediately, can never be
    rotated back into service, and STAYS in the store so "which key was this?"
    remains answerable after an incident. ``DELETE`` still exists, but it
    destroys the audit identity and is the wrong tool for a leak.
  * **Cross-PROCESS exclusion.** The service ships as N single-worker replicas
    (``service/replicas.py``, ``SO_REUSEPORT``), so a ``threading.Lock``
    serializes nothing between them: ``os.replace`` prevents a torn file, not a
    lost update. EVERY read-modify-write goes through :func:`_mutate`, which
    takes ``atomicio.file_lock`` alongside the thread lock — the same pairing
    ``voices.mutate_meta`` uses.
  * **The hot path does not touch the disk.** ``validate_key`` runs on every
    authenticated request; it reads through an in-memory index keyed on the
    store's ``(mtime_ns, size)`` fingerprint plus a local write generation, so
    a write by ANOTHER replica is still picked up on the next call. The file
    stays authoritative — the index is a cache with a cheap validity check,
    never a second source of truth.
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

from service.atomicio import atomic_write_text, file_lock
from service.config import SETTINGS
from service.errors import sanitized_500

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/keys", tags=["keys"])

KEYS_PATH = Path(SETTINGS.voices_dir).parent / "api_keys.json"

# The key store is a single JSON file mutated by concurrent authenticated
# requests — and by concurrent replica PROCESSES. Serialize every
# read-modify-write under the thread lock (threads in this process) AND
# `file_lock` (the other replicas); see `_mutate`. `last_used` bumps are hot
# (one per authenticated request) but low-value, so they are debounced: the
# in-memory view is always current, but the file is only rewritten when the
# persisted timestamp is stale by more than _LAST_USED_DEBOUNCE_S.
#
# Re-entrant so a mutation callback may call back into the store helpers
# without deadlocking (same reasoning as voices._META_LOCK).
_STORE_LOCK = threading.RLock()
_LAST_USED_DEBOUNCE_S = 60.0
_LAST_USED: dict[str, str] = {}        # kid -> current iso timestamp (in-memory)
_LAST_PERSIST: dict[str, float] = {}   # kid -> monotonic time of last file write
# tts=synthesize, voices=manage, clone=upload,
# performance=multi-character scripts (/v1/performance — the premium tier),
# stt=transcribe (/v1/speech-to-text), convai=hold a spoken conversation
# (/v1/convai/... — it both listens and speaks, so it is neither of the two).
SCOPES = ["tts", "voices", "clone", "performance", "stt", "convai"]


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
    global _index_generation
    atomic_write_text(KEYS_PATH, json.dumps(data, indent=2))
    # Our own write invalidates the read index immediately, without waiting for
    # the stat fingerprint to disagree (filesystems with coarse mtime could
    # otherwise hide a same-tick rewrite of the same size).
    _index_generation += 1


def _lock_path() -> Path:
    """Cross-process mutex file for the key store.

    Derived from KEYS_PATH at CALL time, not bound at import: the tests (and a
    relocated TTS_VOICES_DIR) repoint KEYS_PATH, and a lock next to a different
    file would exclude nothing.
    """
    return KEYS_PATH.with_name(KEYS_PATH.name + ".lock")


def _mutate(fn):
    """The ONE write path. Load → let ``fn`` mutate in place → atomically save.

    Held locks, both required (see the module docstring):
      * ``_STORE_LOCK`` — the threads of THIS process.
      * ``file_lock(_lock_path())`` — the other replica processes. Without it
        two replicas load the same store, each add/rotate a key, and each save;
        ``os.replace`` keeps the file intact but one change is silently lost.

    If ``fn`` raises (e.g. the 404/409 HTTPExceptions below) the save is
    skipped, so the previous file is left intact. Returns ``fn``'s return value.
    """
    try:
        with _STORE_LOCK, file_lock(_lock_path()):
            data = _load()
            result = fn(data)
            _save(data)
            return result
    except TimeoutError as exc:
        # Another replica is wedged holding the lock. Fail loudly but without
        # leaking internals (service/errors.py is the one error voice).
        raise sanitized_500("key store update", exc) from exc


# ── validation index ───────────────────────────────────────────────────────────
# validate_key runs on EVERY authenticated request. Re-reading + JSON-parsing
# the whole store per request put disk I/O in the auth hot path, so reads go
# through this index. Validity check = (store path, mtime_ns, size, local write
# generation): a write by another replica changes mtime/size and is picked up on
# the very next call; our own writes bump the generation. Cheap enough (one
# stat) that it is still an honest read-through, not a stale mirror.
_INDEX_LOCK = threading.RLock()
_index_generation = 0
_index_entries: list[tuple[str, str, tuple[str, ...], bool]] | None = None
_index_key: tuple | None = None


def _store_fingerprint() -> tuple:
    try:
        st = KEYS_PATH.stat()
        stamp: tuple = (st.st_mtime_ns, st.st_size)
    except OSError:
        stamp = (-1, -1)  # no store yet — itself a valid, cacheable state
    return (str(KEYS_PATH), *stamp, _index_generation)


def _index() -> list[tuple[str, str, tuple[str, ...], bool]]:
    """(kid, hash, scopes, revoked) per key, rebuilt only when the store moved."""
    global _index_entries, _index_key
    key = _store_fingerprint()
    with _INDEX_LOCK:
        if _index_entries is not None and _index_key == key:
            return _index_entries
        entries = []
        # Rebuild under _STORE_LOCK too: on Windows `os.replace` onto a path
        # that another thread currently has open fails with PermissionError, so
        # an index rebuild racing a _save in this process would break the
        # writer. (Cheap — a rebuild only happens after a write.)
        with _STORE_LOCK:
            store = _load()
        for k in store.values():
            if not isinstance(k, dict) or not k.get("id"):
                continue
            entries.append((str(k["id"]), str(k.get("hash") or ""),
                            tuple(k.get("scopes") or []), bool(k.get("revoked"))))
        _index_entries, _index_key = entries, key
        return entries


def invalidate_index() -> None:
    """Force the next validate to reload. For writers that bypass ``_mutate``
    (tests, recovery tooling); the stat fingerprint already covers most cases."""
    global _index_generation
    _index_generation += 1


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

    def _add(data: dict) -> dict:
        data[kid] = {
            "id": kid, "name": req.name.strip() or "Untitled key", "prefix": prefix,
            "hash": _hash(secret), "scopes": req.scopes or ["tts"], "created": created,
            "last_used": None, "revoked": False,
        }
        return data[kid]

    entry = _mutate(_add)
    return ApiKeyWithSecret(**_public(entry).model_dump(), secret=secret)


@router.post("/{kid}/rotate", response_model=ApiKeyWithSecret)
def rotate_key(kid: str) -> ApiKeyWithSecret:
    secret, prefix = _new_secret()

    def _rotate(data: dict) -> dict:
        if kid not in data:
            raise HTTPException(404, "key not found")
        # Rotating must NEVER silently resurrect a revoked key.
        if data[kid].get("revoked"):
            raise HTTPException(409, "cannot rotate a revoked key")
        data[kid]["hash"] = _hash(secret)
        data[kid]["prefix"] = prefix
        return data[kid]

    entry = _mutate(_rotate)
    return ApiKeyWithSecret(**_public(entry).model_dump(), secret=secret)


@router.post("/{kid}/revoke", response_model=ApiKey)
def revoke_key(kid: str) -> ApiKey:
    """Kill a key without destroying its audit identity.

    This — not DELETE — is the answer to a leaked credential: the key stops
    authenticating on the very next request, keeps appearing in ``GET /v1/keys``
    with ``revoked: true`` (so "what was this key allowed to do, and when was it
    last used?" is still answerable), and can never be rotated back into service
    (``/rotate`` 409s). Idempotent: revoking a revoked key succeeds unchanged.
    """
    def _revoke(data: dict) -> dict:
        if kid not in data:
            raise HTTPException(404, "key not found")
        data[kid]["revoked"] = True
        return data[kid]

    entry = _mutate(_revoke)
    # Deliberately NOT clearing _LAST_USED/_LAST_PERSIST: last_used is audit
    # evidence and must survive revocation. The debounced persist path re-checks
    # `revoked` before writing, so a bump in flight cannot un-revoke the key.
    logger.info("api key %s revoked", kid)
    return _public(entry)


@router.delete("/{kid}", status_code=204)
def delete_key(kid: str) -> None:
    def _delete(data: dict) -> None:
        if kid not in data:
            raise HTTPException(404, "key not found")
        del data[kid]

    _mutate(_delete)
    _LAST_USED.pop(kid, None)
    _LAST_PERSIST.pop(kid, None)


class _NotPersistable(Exception):
    """Internal: the key vanished/was revoked between the index read and the
    write, so `_mutate` must skip the save."""


def _persist_last_used(kid: str, now_iso: str) -> None:
    """Write the debounced last_used bump, re-reading the store under the locks.

    The bump was computed from the (cached) index, so by the time we get here
    the key may have been deleted or revoked — possibly by another replica.
    Re-check under the lock: a `last_used` write must never resurrect a key the
    operator just killed.
    """
    def _bump(data: dict) -> None:
        entry = data.get(kid)
        if entry is None or entry.get("revoked"):
            raise _NotPersistable()
        entry["last_used"] = now_iso

    try:
        _mutate(_bump)
    except _NotPersistable:
        _LAST_USED.pop(kid, None)
        _LAST_PERSIST.pop(kid, None)
        return
    _LAST_PERSIST[kid] = time.monotonic()


def key_recognized(secret: str | None) -> bool:
    """True if `secret` matches ANY active (non-revoked) key, scope aside.

    Exists so auth can answer 403 (real key, missing scope) instead of a
    blanket 401 — the distinction a key-prover needs. Same constant-time,
    no-early-break scan discipline as validate_key; does NOT bump last_used
    (recognition is not use).
    """
    if not secret:
        return False
    h = _hash(secret)
    found = False
    for kid, khash, scopes, revoked in _index():
        if secrets.compare_digest(khash, h) and not revoked:
            found = True
    return found


def validate_key(secret: str | None, scope: str = "tts") -> bool:
    """True if `secret` is an active (non-revoked) key with `scope`. Bumps
    last_used (in-memory always; persisted at most once per
    _LAST_USED_DEBOUNCE_S).

    Reads through the in-memory index — no disk read on the common path. The
    scan is linear and does NOT break early: `compare_digest` is constant time
    per key, and running the whole (tiny, in-memory) list keeps the total time
    independent of WHICH key matched. Same timing-side-channel reasoning as the
    root-key check in service/auth.py.
    """
    if not secret:
        return False
    h = _hash(secret)
    matched: str | None = None
    for kid, khash, scopes, revoked in _index():
        if secrets.compare_digest(khash, h) and not revoked and scope in scopes:
            matched = kid
    if matched is None:
        return False
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    _LAST_USED[matched] = now_iso  # in-memory view is always current
    last = _LAST_PERSIST.get(matched)
    if last is None or (time.monotonic() - last) > _LAST_USED_DEBOUNCE_S:
        _persist_last_used(matched, now_iso)
    return True
