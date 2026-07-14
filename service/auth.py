"""Central API-key enforcement for every Gravitone router.

Two kinds of credential, both sent as `xi-api-key` (ElevenLabs-compatible)
or `Authorization: Bearer <key>`:

  * The ROOT key — `TTS_API_KEY` from the environment / `.env`. Unlimited:
    passes every scope check including key management. This is the key the
    local web studio and operators use.
  * MANAGED keys — issued via `/v1/keys` (service/keys.py), hashed at rest,
    scoped to a subset of {tts, voices, clone}. Never valid for `admin`.

Enforcement is ON whenever `TTS_API_KEY` is set. If it is empty the service
stays fully open (the pre-auth local-dev behaviour), so bare checkouts and
the load-test harness keep working without ceremony.
"""
from __future__ import annotations

import secrets

from fastapi import Header, HTTPException, Request

from service.config import SETTINGS
from service.keys import validate_key


def _extract_secret(xi_api_key: str | None, authorization: str | None) -> str | None:
    if xi_api_key:
        return xi_api_key
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip() or None
    return None


def _authorize(secret: str | None, scope: str) -> None:
    if not SETTINGS.api_key:
        return  # open mode — no root key configured
    # Constant-time compare: the root key is the crown-jewel credential, so a
    # short-circuiting `==` would leak it byte-by-byte via response timing.
    if secret is not None and secrets.compare_digest(secret.encode(), SETTINGS.api_key.encode()):
        return  # root key — unlimited
    if scope != "admin" and validate_key(secret, scope):
        return  # managed key with the required scope
    raise HTTPException(
        status_code=401,
        detail=f"invalid or missing API key (scope '{scope}' required); "
               "send it as xi-api-key or Authorization: Bearer",
    )


def require_scope(scope: str):
    """Dependency: the caller must present the root key or a managed key
    holding `scope`. Use scope="admin" for root-key-only surfaces."""

    async def dep(
        xi_api_key: str | None = Header(default=None, alias="xi-api-key"),
        authorization: str | None = Header(default=None),
    ) -> None:
        _authorize(_extract_secret(xi_api_key, authorization), scope)

    return dep


def require_read_write(read_scope: str, write_scope: str):
    """Dependency: GET/HEAD/OPTIONS need `read_scope`, everything else needs
    `write_scope`. Lets a tts-scoped key list voices (ElevenLabs drop-in
    clients do this) without granting it voice management."""

    async def dep(
        request: Request,
        xi_api_key: str | None = Header(default=None, alias="xi-api-key"),
        authorization: str | None = Header(default=None),
    ) -> None:
        scope = read_scope if request.method in ("GET", "HEAD", "OPTIONS") else write_scope
        _authorize(_extract_secret(xi_api_key, authorization), scope)

    return dep
