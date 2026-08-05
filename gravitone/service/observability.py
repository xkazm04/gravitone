"""Error reporting for the service, OFF until an operator names a DSN.

Until this module existed, a production failure in this service reached exactly
one place: stdout. A background ingest phase that died — the ElevenLabs call
that 500'd on segment 31 of 40, the Gemini escalation that timed out, the
commit that raised mid-rollback — was logged, the job was marked "error", and
that was the end of it. Nobody could tell afterwards whether it had happened
once or forty times, or on which provider.

This module is the one pipe out. Its whole design is shaped by the fact that
Gravitone's claim is that it runs on a box you own and nothing leaves it:

  * **`sentry_sdk` is imported lazily, inside `init()`, and only when a DSN is
    set.** With `SENTRY_DSN` unset the package is never imported, so no
    transport is constructed, no `sys.excepthook` is replaced, no `atexit` hook
    is registered and no socket is opened. That is a stronger statement than
    "the SDK no-ops without a DSN" (which is also true), and it is the one a
    self-hoster actually cares about. It also means the dependency is genuinely
    optional: an `ImportError` leaves reporting off instead of taking the
    service down, which is what keeps the fake-engine test suite — which runs
    with no ML deps at all — honest.
  * **Errors, not telemetry.** `traces_sample_rate` and `profiles_sample_rate`
    are 0 by default and the auto-enabling integrations (which patch httpx,
    urllib, boto, redis, ... to emit spans) are off. Nothing is sent that is
    not an error, plus one deliberate ingest-cost event; see below.
  * **Nothing about a person.** This service handles voice recordings,
    transcripts and consent receipts. `send_default_pii` is False,
    `max_request_body_size` is `"never"` — the setting that actually decides
    whether an uploaded WAV or a transcript can ride along, and which is NOT
    covered by `send_default_pii` — and on top of both, `scrub_event` deletes
    the request body, headers, cookies and user from every event and strips
    query strings from event and breadcrumb URLs alike. That last one is not
    hypothetical: the Gemini calls in `service/ingest.py` carry their API key
    in the URL query string, so an unscrubbed HTTP breadcrumb would ship the
    operator's key to a third party.

THE COST LEDGER RIDES THIS PIPE. `service.ingest.Spend` already counts every
external call an ingest job makes (ElevenLabs Scribe, ElevenLabs Isolator, and
Gemini flash escalating to pro) and already caps retries and escalations per
job. It was published to the job's own `partial`/`result` and nowhere else, so
"what did last week's scans cost" was a question you answered by reading an
invoice. `record_ingest_spend` publishes that SAME, already-computed snapshot
as a Sentry context and one info-level event per terminal job. Nothing here
recomputes or re-derives spend — this module is a second reader of one ledger,
not a second ledger.
"""
from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger("gravitone.observability")

# The `sentry_sdk` module, once `init()` has actually turned reporting on.
# `None` is the OFF state and the only state a no-DSN process ever reaches.
_sdk: Any = None

# What `init()` decided, so a caller can ask without importing anything.
_enabled = False


def _clean(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def _rate(name: str, default: float) -> float:
    """A 0..1 sample rate from the environment.

    A typo falls back rather than silently meaning "send nothing": a rate is
    the one setting whose misconfiguration is invisible in the place you would
    look for it.
    """
    raw = _clean(name)
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        logger.warning("%s=%r is not a number; using %s", name, raw, default)
        return default
    if not 0.0 <= value <= 1.0:
        logger.warning("%s=%r is outside 0..1; using %s", name, raw, default)
        return default
    return value


def _strip_query(url: Any) -> Any:
    """`url` up to the first `?` or `#`, or `url` unchanged if it is not a str.

    The Gemini endpoint takes its key as `?key=...`; ElevenLabs takes it in a
    header. Both are covered — headers are deleted wholesale — but the query
    string is the one that hides inside an otherwise innocuous URL field.
    """
    if not isinstance(url, str):
        return url
    for marker in ("?", "#"):
        index = url.find(marker)
        if index >= 0:
            url = url[:index]
    return url


def scrub_event(event: dict, hint: Any = None) -> dict:
    """Strip everything person-shaped or credential-shaped from an event.

    Exposed (and tested) as a plain function so the guarantee is asserted
    rather than inferred from an `init()` kwarg. Applied as `before_send`, so
    it runs on EVERY event including the ones the SDK raises by itself.
    """
    event.pop("user", None)
    request = event.get("request")
    if isinstance(request, dict):
        for field in ("data", "cookies", "headers", "query_string", "env"):
            request.pop(field, None)
        if "url" in request:
            request["url"] = _strip_query(request["url"])
    # Local variables per stack frame can hold a decoded WAV, a transcript or a
    # key. The SDK only attaches them when asked, but this makes it structural.
    for entry in (event.get("exception") or {}).get("values") or []:
        for frame in (entry.get("stacktrace") or {}).get("frames") or []:
            frame.pop("vars", None)
    return event


def scrub_breadcrumb(crumb: dict, hint: Any = None) -> dict:
    """As `scrub_event`, for the URL an HTTP breadcrumb records."""
    data = crumb.get("data")
    if isinstance(data, dict) and "url" in data:
        data["url"] = _strip_query(data["url"])
    return crumb


def init(dsn: str | None = None) -> bool:
    """Turn reporting on if a DSN says so. Returns whether it is on.

    Idempotent and safe to call from anywhere: with no DSN it reads one
    environment variable and returns, having imported nothing.
    """
    global _sdk, _enabled
    if _enabled:
        return True
    resolved = (dsn if dsn is not None else _clean("SENTRY_DSN")).strip()
    if not resolved:
        return False
    try:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.starlette import StarletteIntegration
    except ImportError:
        # A declared DSN with no SDK installed is an operator mistake worth
        # saying out loud — but not worth refusing to start the service over.
        logger.warning(
            "SENTRY_DSN is set but sentry-sdk is not installed; error reporting "
            "stays off. `pip install sentry-sdk` to turn it on.")
        return False

    sentry_sdk.init(
        dsn=resolved,
        environment=_clean("SENTRY_ENVIRONMENT", "development"),
        release=_clean("SENTRY_RELEASE") or None,
        # Errors are the accepted scope. 1.0 because an error tracker that
        # silently drops errors turns "we never saw that" into an unreliable
        # statement; SENTRY_SAMPLE_RATE is the knob for an operator who has a
        # quota to defend.
        sample_rate=_rate("SENTRY_SAMPLE_RATE", 1.0),
        # Performance data is volume with no incident value here, and this
        # service's hot path is audio synthesis measured by its own /metrics.
        traces_sample_rate=_rate("SENTRY_TRACES_SAMPLE_RATE", 0.0),
        profiles_sample_rate=0.0,
        # The two settings that decide whether a voice recording, a transcript
        # or an email can reach Sentry. `max_request_body_size` is the one that
        # matters for THIS service and it is NOT implied by send_default_pii.
        send_default_pii=False,
        max_request_body_size="never",
        # Do not go looking for libraries to patch. The auto-enabling set
        # instruments httpx/urllib/boto/redis/sqlalchemy for SPANS, which is
        # exactly the telemetry that is out of scope — and each patch is
        # surface area on a process whose selling point is that it is quiet.
        auto_enabling_integrations=False,
        integrations=[StarletteIntegration(), FastApiIntegration()],
        before_send=scrub_event,
        before_breadcrumb=scrub_breadcrumb,
        # A stack trace and a short trail; the default 100 crumbs is a bigger
        # payload and a bigger surface for no extra diagnostic value.
        max_breadcrumbs=30,
    )
    _sdk = sentry_sdk
    _enabled = True
    logger.info("error reporting on (environment=%s)",
                _clean("SENTRY_ENVIRONMENT", "development"))
    return True


def enabled() -> bool:
    """Whether anything in this module will actually transmit."""
    return _enabled


def reset() -> None:
    """Return to the OFF state. For tests; never called by the service."""
    global _sdk, _enabled
    if _sdk is not None:
        try:
            _sdk.get_client().close(timeout=0.0)
        except Exception:  # noqa: BLE001 - teardown must not fail a test
            logger.debug("sentry client close failed during reset", exc_info=True)
    _sdk = None
    _enabled = False


# ── ingest: failures, and what they cost ─────────────────────────────────────
#
# `service/ingest_api.py` runs each job's phases on their own threads and
# catches everything (a phase must mark the job "error", not kill the thread),
# so no exception here ever reaches an excepthook. These are the explicit
# hand-offs.


def spend_context(snapshot: dict) -> dict:
    """`Spend.snapshot()` reshaped for a Sentry context — nothing recomputed.

    Split out from `record_ingest_spend` so the shape is testable without a
    client, and so it is obvious that this function does no arithmetic beyond
    reading the keys the ledger already wrote.
    """
    calls = snapshot.get("calls") or {}
    context: dict[str, Any] = {
        "total_calls": snapshot.get("total_calls", 0),
        "retries": snapshot.get("retries", 0),
        "retry_budget": snapshot.get("retry_budget", 0),
        "escalated": snapshot.get("escalated", 0),
        "escalation_budget": snapshot.get("escalation_budget", 0),
        "escalations_failed": snapshot.get("escalations_failed", 0),
        "escalations_skipped": snapshot.get("escalations_skipped", 0),
    }
    # One key per provider, so a spike is legible in Sentry's own UI without
    # anyone having to expand a nested blob.
    for provider, count in sorted(calls.items()):
        context[f"calls.{provider}"] = count
    return context


def bind_ingest_job(job_id: str, mode: str) -> None:
    """Tag everything this THREAD reports with the job it belongs to.

    Ingest phases each run on a dedicated thread, so the isolation scope set
    here belongs to one job and does not bleed into another.
    """
    if not _enabled:
        return
    try:
        scope = _sdk.get_isolation_scope()
        scope.set_tag("ingest.job", job_id)
        scope.set_tag("ingest.mode", mode)
    except Exception:  # noqa: BLE001 - reporting must never break a scan
        logger.debug("could not bind ingest job scope", exc_info=True)


def record_ingest_spend(job_id: str, mode: str, status: str,
                        snapshot: dict | None) -> None:
    """Publish one job's external-call ledger.

    Two things happen, both from the same already-computed snapshot:

    1. It becomes an `ingest_spend` CONTEXT on this thread's scope, so any
       error reported later in the job arrives with the cost attached — "this
       failed after 47 provider calls and 12 retries" is a different bug report
       from "this failed on the first call".
    2. Unless `SENTRY_INGEST_SPEND_EVENTS=0`, one info-level event is sent per
       terminal job, so cost is queryable on its own rather than only visible
       when something breaks. Ingest jobs are human-initiated and rare (a scan
       is minutes of audio and minutes of wall clock), so this is a handful of
       events a day, not a stream.
    """
    if not _enabled or not snapshot:
        return
    context = spend_context(snapshot)
    try:
        scope = _sdk.get_isolation_scope()
        scope.set_context("ingest_spend", context)
        wanted = _clean("SENTRY_INGEST_SPEND_EVENTS", "1").lower()
        if wanted not in ("0", "false", "no", "off"):
            _sdk.capture_event({
                "level": "info",
                "message": (f"ingest {status}: {context['total_calls']} external "
                            f"calls, {context['retries']} retries"),
                "logger": "gravitone.ingest.spend",
                "tags": {"ingest.job": job_id, "ingest.mode": mode,
                         "ingest.status": status},
                "contexts": {"ingest_spend": context},
            })
    except Exception:  # noqa: BLE001 - reporting must never break a scan
        logger.debug("could not record ingest spend", exc_info=True)


def capture_ingest_failure(job_id: str, mode: str, action: str,
                           exc: BaseException, snapshot: dict | None = None) -> None:
    """Report a background phase that died, with what it had spent getting there.

    The service already turns this into a sanitized, job-visible error; this is
    the half the operator sees. Failures inside reporting are swallowed on
    purpose — a Sentry outage must not turn a recoverable scan failure into an
    unhandled one.
    """
    if not _enabled:
        return
    try:
        scope = _sdk.get_isolation_scope()
        scope.set_tag("ingest.job", job_id)
        scope.set_tag("ingest.mode", mode)
        scope.set_tag("ingest.phase", action)
        if snapshot:
            scope.set_context("ingest_spend", spend_context(snapshot))
        _sdk.capture_exception(exc)
    except Exception:  # noqa: BLE001
        logger.debug("could not capture ingest failure", exc_info=True)
