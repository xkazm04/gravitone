"""The error pipe, and the promise that it is closed by default.

Two things are worth proving here and nothing else is:

  1. With no DSN, NOTHING happens — not a suppressed send, not an inert client,
     not even an import. That is the claim the product makes about itself and
     it is the claim a self-hoster is entitled to check.
  2. When a DSN IS set, the payload that would leave the box carries no
     recording, no transcript, no credential and no person — and it carries the
     ingest cost ledger, which is the reason this pipe was worth opening.

Every "on" test runs against a Transport that keeps envelopes in a list. No
socket is opened by this file.
"""
from __future__ import annotations

import importlib
import sys

import pytest

from service.tests import fake_engine  # noqa: F401  (stubs torch/scipy/pocket_tts)

from service import observability


@pytest.fixture(autouse=True)
def _off_by_default():
    """Every test starts and ends with reporting OFF."""
    observability.reset()
    yield
    observability.reset()


# ── the closed door ──────────────────────────────────────────────────────────


def test_no_dsn_means_not_enabled(monkeypatch):
    monkeypatch.delenv("SENTRY_DSN", raising=False)
    assert observability.init() is False
    assert observability.enabled() is False


@pytest.mark.parametrize("value", ["", "   ", "\t"])
def test_blank_dsn_is_not_a_dsn(monkeypatch, value):
    monkeypatch.setenv("SENTRY_DSN", value)
    assert observability.init() is False
    assert observability.enabled() is False


def test_no_dsn_imports_no_sdk(monkeypatch):
    """The strong form of the promise: the library is never even loaded.

    An `init()` with an empty DSN would also transmit nothing, but it would
    leave sentry_sdk resident with its excepthook and atexit hook installed.
    This asserts the module never gets that far — the import lives INSIDE the
    DSN branch, so a `sys.modules` that cannot resolve it is irrelevant.
    """
    monkeypatch.setenv("SENTRY_DSN", "")
    # Poison the import: if init() reached it, this would raise, not return.
    monkeypatch.setitem(sys.modules, "sentry_sdk", None)
    assert observability.init() is False
    assert observability._sdk is None


def test_every_entry_point_is_a_noop_while_off():
    """The service calls these unconditionally; off must mean silent, not raise."""
    observability.bind_ingest_job("job-1", "cloud")
    observability.record_ingest_spend("job-1", "cloud", "done",
                                      {"calls": {"gemini": 3}, "total_calls": 3})
    observability.capture_ingest_failure("job-1", "cloud", "emotion labelling",
                                         RuntimeError("boom"), {"total_calls": 3})
    assert observability.enabled() is False


def test_app_imports_with_reporting_off(monkeypatch):
    """`service.app` calls observability.init() at import; that must be free."""
    monkeypatch.setenv("SENTRY_DSN", "")
    module = importlib.import_module("service.app")
    assert module is not None
    assert observability.enabled() is False


def test_a_dsn_with_no_sdk_installed_does_not_take_the_service_down(monkeypatch):
    monkeypatch.setenv("SENTRY_DSN", "https://k@o0.ingest.sentry.io/1")
    real_import = importlib.import_module

    def _no_sentry(name, *args, **kwargs):
        if name.startswith("sentry_sdk"):
            raise ImportError("no sentry-sdk here")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(importlib, "import_module", _no_sentry)
    monkeypatch.setitem(sys.modules, "sentry_sdk", None)
    # `import sentry_sdk` with sys.modules["sentry_sdk"] = None raises
    # ImportError, which is exactly the case init() is required to survive.
    assert observability.init() is False
    assert observability.enabled() is False


# ── scrubbing (pure, no client needed) ───────────────────────────────────────


def test_scrub_event_removes_everything_person_shaped():
    event = scrubbed = observability.scrub_event({
        "user": {"email": "someone@example.test", "ip_address": "203.0.113.9"},
        "request": {
            # The Gemini calls in service/ingest.py put the key in the query.
            "url": "https://generativelanguage.googleapis.com/v1/models?key=AIzaSECRET",
            "query_string": "key=AIzaSECRET",
            "data": {"transcript": "what the speaker actually said"},
            "cookies": {"session": "abc"},
            "headers": {"xi-api-key": "sk_live_SECRET"},
            "env": {"REMOTE_ADDR": "203.0.113.9"},
        },
    })
    assert "user" not in event
    assert scrubbed["request"]["url"].endswith("/v1/models")
    for gone in ("query_string", "data", "cookies", "headers", "env"):
        assert gone not in scrubbed["request"]
    blob = repr(scrubbed)
    for secret in ("AIzaSECRET", "sk_live_SECRET", "someone@example.test",
                   "what the speaker actually said", "203.0.113.9"):
        assert secret not in blob


def test_scrub_event_drops_frame_locals():
    event = observability.scrub_event({
        "exception": {"values": [{"stacktrace": {"frames": [
            {"function": "label_and_stem", "vars": {"api_key": "sk_live_SECRET"}},
        ]}}]},
    })
    frame = event["exception"]["values"][0]["stacktrace"]["frames"][0]
    assert "vars" not in frame
    assert frame["function"] == "label_and_stem"


def test_scrub_event_survives_a_sparse_event():
    assert observability.scrub_event({}) == {}
    assert observability.scrub_event({"request": {}})["request"] == {}
    assert observability.scrub_event({"exception": {"values": []}})


def test_scrub_breadcrumb_strips_the_query():
    crumb = observability.scrub_breadcrumb(
        {"data": {"url": "https://api.elevenlabs.io/v1/x?token=SECRET", "status_code": 500}})
    assert crumb["data"]["url"] == "https://api.elevenlabs.io/v1/x"
    assert crumb["data"]["status_code"] == 500
    assert observability.scrub_breadcrumb({}) == {}


@pytest.mark.parametrize("raw,expected", [
    (None, 1.0), ("", 1.0), ("  ", 1.0),
    ("nonsense", 1.0), ("-1", 1.0), ("2", 1.0),
    ("0", 0.0), ("0.25", 0.25), ("1", 1.0),
])
def test_rate_falls_back_rather_than_silently_muting(monkeypatch, raw, expected):
    if raw is None:
        monkeypatch.delenv("GRAVITONE_TEST_RATE", raising=False)
    else:
        monkeypatch.setenv("GRAVITONE_TEST_RATE", raw)
    assert observability._rate("GRAVITONE_TEST_RATE", 1.0) == expected


# ── the ledger's shape ───────────────────────────────────────────────────────


def test_spend_context_reads_the_ledger_and_computes_nothing():
    from service.ingest import Spend

    spend = Spend(retry_budget=5, escalation_budget=2)
    spend.charge("elevenlabs.scribe")
    spend.charge("gemini.flash")
    spend.charge("gemini.flash")
    spend.take_retry()
    spend.take_escalations(3)  # 2 granted, 1 skipped
    snapshot = spend.snapshot()

    context = observability.spend_context(snapshot)

    # Every number is the ledger's own; nothing here re-derives cost.
    assert context["total_calls"] == snapshot["total_calls"] == 3
    assert context["calls.gemini.flash"] == 2
    assert context["calls.elevenlabs.scribe"] == 1
    assert context["retries"] == 1
    assert context["retry_budget"] == 5
    assert context["escalated"] == 2
    assert context["escalation_budget"] == 2
    assert context["escalations_skipped"] == 1


# ── the open door ────────────────────────────────────────────────────────────


class _Captured:
    """A Transport that keeps envelopes instead of sending them."""

    def __init__(self):
        self.events: list[dict] = []

    def make(self):
        from sentry_sdk.transport import Transport

        events = self.events

        class _T(Transport):
            def capture_envelope(self, envelope):
                for item in envelope.items:
                    payload = item.payload.json
                    if payload is not None:
                        events.append(payload)

            def flush(self, *a, **kw):
                pass

            def kill(self):
                pass

        return _T()


@pytest.fixture
def captured(monkeypatch):
    pytest.importorskip("sentry_sdk")
    sink = _Captured()
    monkeypatch.setenv("SENTRY_ENVIRONMENT", "test")
    assert observability.init("https://key@o0.ingest.sentry.io/1") is True
    import sentry_sdk

    # Re-init with the capturing transport, keeping the options under test.
    client = sentry_sdk.get_client()
    options = dict(client.options)
    options["transport"] = sink.make()
    sentry_sdk.init(**{k: v for k, v in options.items() if not k.startswith("_")})
    yield sink


def test_the_options_are_the_posture(monkeypatch):
    pytest.importorskip("sentry_sdk")
    monkeypatch.setenv("SENTRY_ENVIRONMENT", "test")
    assert observability.init("https://key@o0.ingest.sentry.io/1") is True
    import sentry_sdk

    options = sentry_sdk.get_client().options
    assert options["send_default_pii"] is False
    assert options["max_request_body_size"] == "never"
    assert options["traces_sample_rate"] == 0.0
    assert options["profiles_sample_rate"] == 0.0
    assert options["sample_rate"] == 1.0
    assert options["auto_enabling_integrations"] is False
    assert options["before_send"] is observability.scrub_event
    assert options["before_breadcrumb"] is observability.scrub_breadcrumb


def test_a_completed_job_publishes_its_spend(captured):
    from service.ingest import Spend

    spend = Spend(retry_budget=5, escalation_budget=2)
    spend.charge("elevenlabs.isolator")
    spend.charge("gemini.pro")
    observability.record_ingest_spend("job-7", "cloud", "done", spend.snapshot())

    assert len(captured.events) == 1
    event = captured.events[0]
    assert event["level"] == "info"
    assert event["tags"]["ingest.job"] == "job-7"
    assert event["tags"]["ingest.mode"] == "cloud"
    assert event["tags"]["ingest.status"] == "done"
    ledger = event["contexts"]["ingest_spend"]
    assert ledger["total_calls"] == 2
    assert ledger["calls.gemini.pro"] == 1
    assert ledger["calls.elevenlabs.isolator"] == 1


def test_the_spend_event_can_be_turned_off_on_its_own(captured, monkeypatch):
    monkeypatch.setenv("SENTRY_INGEST_SPEND_EVENTS", "0")
    observability.record_ingest_spend("job-8", "cloud", "done",
                                      {"calls": {"gemini.flash": 1}, "total_calls": 1})
    assert captured.events == []


def test_a_failed_phase_arrives_with_what_it_had_spent(captured):
    observability.capture_ingest_failure(
        "job-9", "cloud", "emotion labelling", RuntimeError("gemini 503"),
        {"calls": {"gemini.flash": 31}, "total_calls": 31, "retries": 12,
         "retry_budget": 12})

    assert len(captured.events) == 1
    event = captured.events[0]
    assert event["exception"]["values"][-1]["value"] == "gemini 503"
    assert event["tags"]["ingest.phase"] == "emotion labelling"
    assert event["tags"]["ingest.job"] == "job-9"
    ledger = event["contexts"]["ingest_spend"]
    assert ledger["total_calls"] == 31
    assert ledger["retries"] == 12


def test_a_captured_error_carries_no_pii(captured):
    import sentry_sdk

    with sentry_sdk.isolation_scope() as scope:
        scope.set_user({"email": "someone@example.test"})
        sentry_sdk.capture_exception(RuntimeError("boom"))

    assert len(captured.events) == 1
    blob = repr(captured.events[0])
    assert "someone@example.test" not in blob
