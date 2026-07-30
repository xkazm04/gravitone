"""Central API-key enforcement for every Gravitone router.

Two kinds of credential, both sent as `xi-api-key` (ElevenLabs-compatible)
or `Authorization: Bearer <key>`:

  * The ROOT key — `TTS_API_KEY` from the environment / `.env`. Unlimited:
    passes every scope check including key management. This is the key the
    local web studio and operators use.
  * MANAGED keys — issued via `/v1/keys` (service/keys.py), hashed at rest,
    scoped to a subset of `keys.SCOPES` (that list is the only truth; it has
    grown since — `performance` is grantable). Never valid for `admin`.

Enforcement is ON whenever `TTS_API_KEY` is set. If it is empty the service
stays fully open (the pre-auth local-dev behaviour), so bare checkouts and
the load-test harness keep working without ceremony.
"""
from __future__ import annotations

import secrets

from fastapi import Header, HTTPException, Request

from service.config import SETTINGS
from service.keys import key_recognized, validate_key


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
    if scope != "admin" and key_recognized(secret):
        # A real, active key that simply lacks this scope. 403-not-401 is the
        # distinction the key-proving sweep measures: "wrong scope" must not be
        # indistinguishable from "no key at all".
        raise HTTPException(
            status_code=403,
            detail=f"key does not hold scope '{scope}'",
        )
    raise HTTPException(
        status_code=401,
        detail=f"invalid or missing API key (scope '{scope}' required); "
               "send it as xi-api-key or Authorization: Bearer",
    )


def require_scope(scope: str):
    """Dependency: the caller must present the root key or a managed key
    holding `scope`. Use scope="admin" for root-key-only surfaces.

    NOT async: validate_key reads (and debounce-rewrites) api_keys.json under a
    lock. As a coroutine dependency that file I/O ran on the event loop for
    EVERY authenticated request; `def` puts it on the anyio threadpool.
    """

    def dep(
        xi_api_key: str | None = Header(default=None, alias="xi-api-key"),
        authorization: str | None = Header(default=None),
    ) -> None:
        _authorize(_extract_secret(xi_api_key, authorization), scope)

    return dep


def authorize_headers(xi_api_key: str | None, authorization: str | None,
                      scope: str) -> None:
    """Raise the canonical 401 unless these headers carry `scope`.

    The same check `require_scope` makes, for the handful of endpoints whose
    policy is not "one dependency, one scope" — today `/metrics`, which also
    honours a loopback exemption for the replica supervisor's aggregator. One
    401 message for every surface: it is written once, here.
    """
    _authorize(_extract_secret(xi_api_key, authorization), scope)


def optional_scope(scope: str):
    """Dependency: reports WHETHER the caller holds `scope`, never 401s.

    For a surface with a public part and a privileged part. `/health` is the
    one: liveness must answer unauthenticated (orchestrator probes, the replica
    supervisor, the studio's poller), while the config/tuning detail is only
    for holders. In open mode (no TTS_API_KEY) this is True for everyone, so
    local dev sees the full body exactly as before.

    NOT async — same reason as require_scope: validate_key touches disk.
    """

    def dep(
        xi_api_key: str | None = Header(default=None, alias="xi-api-key"),
        authorization: str | None = Header(default=None),
    ) -> bool:
        try:
            authorize_headers(xi_api_key, authorization, scope)
            return True
        except HTTPException:
            return False

    return dep


def require_read_write(read_scope: str, write_scope: str):
    """Dependency: GET/HEAD/OPTIONS need `read_scope`, everything else needs
    `write_scope`. Lets a tts-scoped key list voices (ElevenLabs drop-in
    clients do this) without granting it voice management.

    NOT async — same reason as require_scope.
    """

    def dep(
        request: Request,
        xi_api_key: str | None = Header(default=None, alias="xi-api-key"),
        authorization: str | None = Header(default=None),
    ) -> None:
        scope = read_scope if request.method in ("GET", "HEAD", "OPTIONS") else write_scope
        _authorize(_extract_secret(xi_api_key, authorization), scope)

    return dep
