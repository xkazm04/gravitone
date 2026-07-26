"""One error voice for the service.

Every client-visible failure is JSON ``{"detail": str}`` (the FastAPI default),
plus two structured variants that are part of the public contract:

  - 429 backpressure adds a ``queue`` snapshot (see ``app._backpressure_response``)
  - expired/unknown ingest jobs use ``{"status": "expired", "detail": ...}`` so
    pollers can branch on ``status`` — :func:`job_expired` is the ONE place that
    shape lives.

Server-side failures never leak internals: :func:`sanitized_500` logs the raw
cause against a short request id and hands the caller only the id — the same
pattern ``app.py`` established for synthesis failures. :func:`install_catch_all`
extends that guarantee to *unhandled* exceptions, which previously escaped to
Starlette's plain-text ``Internal Server Error`` and broke the JSON contract.
"""
from __future__ import annotations

import logging
import uuid

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

logger = logging.getLogger("gravitone")

# One truncation budget for operator-facing snippets stored in job state or
# logs. Client-facing details never carry raw tool output at all.
DETAIL_LIMIT = 300


def tail(text: str, limit: int = DETAIL_LIMIT) -> str:
    """Last ``limit`` chars — the informative end of ffmpeg/subprocess stderr."""
    return text[-limit:]


def sanitized_500(action: str, cause: BaseException | str) -> HTTPException:
    """Log the raw cause against a short request id; return a 500 whose detail
    carries only ``"{action} failed (request {id})"``. Callers ``raise`` the
    returned exception, keeping the raise site visible in tracebacks."""
    request_id = uuid.uuid4().hex[:8]
    if isinstance(cause, BaseException):
        logger.error("%s failed [request %s]: %s", action, request_id, cause,
                     exc_info=cause)
    else:
        logger.error("%s failed [request %s]: %s", action, request_id, cause)
    return HTTPException(status_code=500,
                         detail=f"{action} failed (request {request_id})")


def job_expired() -> JSONResponse:
    """The canonical 404 for an unknown/expired ingest job. ``status`` is load-
    bearing: the web poller branches on ``"expired"`` to end its loop."""
    return JSONResponse({"status": "expired",
                         "detail": "job not found or expired"},
                        status_code=404)


def install_catch_all(app: FastAPI) -> None:
    """Route unhandled exceptions through the sanitized-500 contract instead of
    Starlette's plain-text page. Starlette still re-raises after responding, so
    server logs/tracebacks keep working; clients keep getting ``{"detail"}``."""

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        request_id = uuid.uuid4().hex[:8]
        logger.error("unhandled error on %s %s [request %s]: %s",
                     request.method, request.url.path, request_id, exc,
                     exc_info=exc)
        return JSONResponse(
            status_code=500,
            content={"detail": f"internal error (request {request_id})"})
