"""Hardware certification kit — certify-your-box for the self-hosted tier.

Turns a measured load-test run into a signed capacity certificate: is this
hardware realtime-verified, what concurrency does it safely sustain, and
what config should it run. A passing certificate is what the supported/
enterprise tier keys off, and opt-in submissions grow the supported-hardware
matrix (docs/SUPPORTED_HARDWARE.md).

Usage (after `bash benchmark_arm.sh` or `python -m service.loadtest`):
    python -m service.certify [--result service/loadtest_result.json]
                              [--out certification.json]

Integrity: the certificate carries a sha256 of its canonical payload;
with GRAVITONE_CERT_SECRET set it is additionally HMAC-signed (same
shared-secret model as Character Packs). Vendor keypair signing is a
follow-up (docs/harness).
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import platform
from datetime import datetime, timezone
from pathlib import Path

# v1 certificates were issued from load-test results that could not tell a
# synthesis from a cache hit (the harness pre-dated the synthesis cache and
# happily averaged X-Realtime-Factor values in the millions). They are NOT
# comparable to v2 and must not be read as capacity claims — hence a new
# version string rather than a silent behaviour change.
#
# v3 adds the SLO capacity contract: a certificate may now carry a promise
# about ARRIVAL RATE at a latency SLO ("this box sustains R req/s at p95 <= S
# for M minutes, ~= N concurrent listeners"), measured open-loop. That is a
# different measurement basis from v2's closed-loop concurrency ramp — a v2
# cap and a v3 rate answer different questions and must never be diffed
# against each other — so, per this file's own precedent, the version string
# changes rather than the meaning of an existing field.
CERT_VERSION = "gravitone-cert/3"

# Versions whose integrity this module can still verify. A v2 certificate
# stays verifiable forever (the hash/HMAC covers the payload, whatever version
# it declares) — extending the issuing bar must never orphan artifacts already
# in the wild.
SUPPORTED_CERT_VERSIONS = ("gravitone-cert/2", "gravitone-cert/3")
CERT_SECRET = os.environ.get("GRAVITONE_CERT_SECRET", "")

# Seconds between one listener's requests, used to turn req/s into people.
# Mirrors service.loadtest.DEFAULT_THINK_TIME_S; the run's own value wins.
DEFAULT_THINK_TIME_S = 30.0

# Load-test result schema that is cache-aware (service.loadtest.SCHEMA_VERSION).
# Anything older cannot substantiate that its numbers came from the model.
MIN_RESULT_SCHEMA = 3

# Certification bar: what "this box can serve Gravitone" means.
THRESHOLDS = {
    "single_stream_rtf_min": 1.0,   # faster than realtime, one stream
    "recommended_cap_min": 1,       # at least one healthy concurrency level
    "errors_at_cap_max": 0,         # zero failures at the recommended cap
    "cache_hits_max": 0,            # zero responses replayed from the cache
}


def measurement_status(result: dict) -> dict:
    """Is this result a measurement of SYNTHESIS, and can it say so itself?

    Three ways it is not, all fatal to a certificate:
      * schema < 3 — produced before the harness knew the cache existed, so its
        levels carry no cache accounting at all. Absence of evidence here is
        not evidence of absence: such a run may be 100% cache hits.
      * ``cache_mode`` other than bypass/off — the run deliberately let the
        cache answer.
      * any recorded ``cache_hits`` — the server served stored audio anyway.
    """
    schema = result.get("schema_version") or 1
    rows = result.get("levels") or []
    measurement = result.get("measurement") or {}
    cache_mode = measurement.get("cache_mode") or result.get("cache_mode")
    hits = measurement.get("cache_hits_total")
    if hits is None:
        hits = sum(int(r.get("cache_hits") or 0) for r in rows)
    reasons = []
    if schema < MIN_RESULT_SCHEMA:
        reasons.append(
            f"result schema v{schema} predates cache-aware benchmarking "
            f"(need v{MIN_RESULT_SCHEMA}+): it cannot show whether its numbers "
            f"came from the model or from the synthesis cache — re-run the load test")
    if cache_mode not in (None, "bypass", "off") :
        reasons.append(f"cache_mode={cache_mode!r}: the synthesis cache was allowed "
                       f"to answer requests")
    if hits > THRESHOLDS["cache_hits_max"]:
        reasons.append(f"{hits} response(s) were served from the synthesis cache")
    return {
        "schema_version": schema,
        "cache_mode": cache_mode,
        "cache_hits_total": hits,
        "measures_synthesis": not reasons,
        "reasons": reasons,
    }


def slo_status(result: dict) -> dict:
    """Does this run substantiate a capacity PROMISE, and may we sign it?

    Three outcomes, and the middle one is the point of the check:
      * **not declared** — a closed-loop concurrency ramp (every v2-era run).
        It makes no rate/SLO claim, so there is nothing to refuse: the
        certificate simply carries no capacity contract and says so.
      * **declared and measured** — an open-loop run found a rate that met the
        SLO (and held it through any soak). This is signable.
      * **declared but PREDICTED** — the rate came from a fitted/extrapolated
        envelope, not from arrivals that actually happened. Refused, exactly
        as a cache-contaminated measurement is refused: a certificate is a
        promise about a box, and a curve fit is a hypothesis about one.
    """
    slo = result.get("slo") or {}
    declared = slo.get("p95_s") is not None
    predicted = bool(slo.get("predicted"))
    rate = slo.get("max_rate_rps")
    soak_minutes = slo.get("soak_minutes") or 0
    soak_passed = slo.get("soak_passed")
    reasons = []
    if declared:
        if predicted:
            reasons.append(
                "the rate is PREDICTED (fitted/extrapolated), not measured — a "
                "certificate may only promise arrivals that actually happened")
        if not isinstance(rate, (int, float)) or rate <= 0:
            reasons.append(slo.get("note")
                           or "no offered rate met the declared SLO")
        elif soak_passed is False:
            reasons.append(f"the {soak_minutes}-minute soak at {rate} req/s did "
                           f"not hold: the rate is reachable, not sustainable")
    think = slo.get("think_time_s") or DEFAULT_THINK_TIME_S
    return {
        "declared": declared,
        "predicted": predicted,
        "p95_s": slo.get("p95_s"),
        "violations_max": slo.get("violations_max"),
        "max_rate_rps": rate if (declared and not reasons) else None,
        "soak_minutes": soak_minutes,
        "soak_passed": soak_passed,
        "think_time_s": think,
        "concurrent_users": (slo.get("concurrent_users")
                             if (declared and not reasons) else None),
        "sustains_slo": declared and not reasons,
        "reasons": reasons,
    }


def capacity_contract(status: dict) -> dict | None:
    """The signable capacity promise, or None when the run made none."""
    if not status["sustains_slo"]:
        return None
    return {
        "slo": {"p95_s": status["p95_s"],
                "violations_max": status["violations_max"]},
        "max_rate_rps": status["max_rate_rps"],
        "soak_minutes": status["soak_minutes"],
        "concurrent_users": status["concurrent_users"],
        "concurrent_users_basis": (
            f"max_rate_rps x think_time_s: a listener requesting speech every "
            f"{status['think_time_s']}s contributes 1/{status['think_time_s']} "
            f"req/s. Change the think time and the headcount changes with it."),
        "measured": "open-loop Poisson arrivals, distinct script per request",
    }


def gather_hardware() -> dict:
    hw = {
        "machine": platform.machine(),
        "system": f"{platform.system()} {platform.release()}",
        "cpu_count": os.cpu_count(),
        "processor": platform.processor() or None,
        "cpu_model": None,
    }
    try:  # Linux: the useful name lives in /proc/cpuinfo
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.lower().startswith(("model name", "hardware", "cpu part")):
                hw["cpu_model"] = line.split(":", 1)[1].strip()
                break
    except OSError:
        pass
    try:
        mem_kb = int(next(l for l in Path("/proc/meminfo").read_text().splitlines()
                          if l.startswith("MemTotal")).split()[1])
        hw["memory_gb"] = round(mem_kb / 1024 / 1024, 1)
    except (OSError, StopIteration):
        hw["memory_gb"] = None
    return hw


def evaluate(result: dict) -> dict:
    """Apply the certification bar to a loadtest result. Returns checks,
    capacity figures and the verdict."""
    rows = result.get("levels") or []
    if not rows:
        raise ValueError("loadtest result has no levels — run the benchmark first")

    single = next((r for r in rows if r.get("concurrency") == 1), rows[0])
    cap = result.get("recommended_cap") or rows[-1]["concurrency"]
    at_cap = next((r for r in rows if r.get("concurrency") == cap), rows[-1])

    single_rtf = single.get("server_rtf_mean") or 0.0
    cap_errors = (at_cap.get("errors") or 0) + (at_cap.get("rejected_429") or 0)
    aud_per_s = at_cap.get("audio_s_per_wall_s") or 0.0

    measurement = measurement_status(result)
    slo = slo_status(result)

    checks = [
        # FIRST, because every number below it is meaningless without it: did
        # this run actually exercise the model? A cached response returns in
        # microseconds, so a contaminated run produces a spectacular — and
        # entirely fictional — realtime factor and concurrency cap.
        {"check": "measures_synthesis",
         "want": "every sample rendered by the model (no cache hits)",
         "got": ("yes" if measurement["measures_synthesis"]
                 else "; ".join(measurement["reasons"])),
         "pass": measurement["measures_synthesis"]},
        {"check": "realtime_single_stream",
         "want": f">= {THRESHOLDS['single_stream_rtf_min']}x",
         "got": single_rtf,
         "pass": single_rtf >= THRESHOLDS["single_stream_rtf_min"]},
        {"check": "healthy_concurrency_cap",
         "want": f">= {THRESHOLDS['recommended_cap_min']}",
         "got": cap,
         "pass": cap >= THRESHOLDS["recommended_cap_min"]},
        {"check": "clean_at_cap",
         "want": f"<= {THRESHOLDS['errors_at_cap_max']} errors/429s",
         "got": cap_errors,
         "pass": cap_errors <= THRESHOLDS["errors_at_cap_max"]},
        # The capacity CONTRACT. A run that declared no SLO passes without
        # claiming anything (the certificate then carries no contract at all);
        # a run that declared one must have MEASURED a rate that met it.
        {"check": "sustains_slo",
         "want": "a measured arrival rate meeting the declared SLO",
         "got": ("no SLO declared: this certificate covers the concurrency "
                 "ramp only and promises no request rate"
                 if not slo["declared"] else
                 (f"{slo['max_rate_rps']} req/s at p95 <= {slo['p95_s']}s"
                  f" ({slo['concurrent_users']} concurrent listeners"
                  f" at a {slo['think_time_s']}s think time)"
                  if slo["sustains_slo"] else "; ".join(slo["reasons"]))),
         "pass": (not slo["declared"]) or slo["sustains_slo"]},
    ]
    return {
        "checks": checks,
        "measurement": measurement,
        "slo": slo,
        "capacity_contract": capacity_contract(slo),
        "verdict": "certified" if all(c["pass"] for c in checks) else "failed",
        "capacity": {
            "single_stream_rtf": single_rtf,
            "recommended_cap": cap,
            "audio_s_per_wall_s_at_cap": aud_per_s,
            "audio_minutes_per_hour": round(aud_per_s * 60) if aud_per_s else None,
        },
        "recommended_config": {
            "TTS_WORKERS": 1,
            "replicas": cap,
            "TTS_TORCH_THREADS": max(1, (os.cpu_count() or cap) // max(1, cap)),
            "TTS_QUEUE_MAX": max(8, 4 * cap),
        },
    }


def topology_status(result: dict) -> dict:
    """What topology produced the run, and what its server-side counters mean.

    The shipped Linux topology shares one port across replicas (SO_REUSEPORT),
    so the launcher cannot address them individually and its counters are a
    SAMPLE of one replica. The client-side numbers (latency, throughput, audio
    per wall-second) are still real — they were measured through the shared
    port across the whole pool — but the certificate must not restate sampled
    counters as a pool aggregate, so it says which it has.
    """
    topo = result.get("topology") or {}
    scope = topo.get("metrics_scope") or "unknown"
    return {
        "mode": topo.get("mode") or "unknown",
        "replicas": topo.get("replicas"),
        "server_metrics_scope": scope,
        "server_metrics_note": (
            topo.get("metrics_scope_note")
            or "this result predates scoped server-side counters"),
        "pool_aggregate_available": scope == "pool_total",
    }


def _canonical(cert: dict) -> bytes:
    unsigned = {k: v for k, v in cert.items() if k not in ("sha256", "signature")}
    return json.dumps(unsigned, sort_keys=True, separators=(",", ":")).encode()


def build_certificate(result: dict) -> dict:
    cert = {
        "version": CERT_VERSION,
        "issued": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "hardware": gather_hardware(),
        "topology": topology_status(result),
        **evaluate(result),
        "thresholds": THRESHOLDS,
        "loadtest_args": result.get("args", {}),
    }
    cert["sha256"] = hashlib.sha256(_canonical(cert)).hexdigest()
    if CERT_SECRET:
        cert["signature"] = {
            "alg": "HMAC-SHA256",
            "value": hmac.new(CERT_SECRET.encode(), _canonical(cert), hashlib.sha256).hexdigest(),
        }
    return cert


def verify_certificate(cert: dict, secret: str = "") -> bool:
    """True when the payload hash (and HMAC, if both sides have the secret)
    check out."""
    if cert.get("sha256") != hashlib.sha256(_canonical(cert)).hexdigest():
        return False
    sig = cert.get("signature")
    if secret:
        # A configured secret means the HMAC signature is REQUIRED. An unsigned
        # (or signature-stripped) certificate must NOT be trusted: the sha256
        # above is an unkeyed integrity hint over attacker-controllable data,
        # not a security control, so accepting a missing signature would let
        # anyone mint a passing certificate. Fail closed instead.
        if not sig:
            return False
        want = hmac.new(secret.encode(), _canonical(cert), hashlib.sha256).hexdigest()
        return hmac.compare_digest(want, str(sig.get("value", "")))
    return True


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--result", default="service/loadtest_result.json")
    ap.add_argument("--out", default="certification.json")
    a = ap.parse_args()

    try:
        result = json.loads(Path(a.result).read_text("utf-8"))
    except FileNotFoundError:
        print(f"{a.result} not found -- run 'bash benchmark_arm.sh' (or service.loadtest) first")
        raise SystemExit(1)

    cert = build_certificate(result)
    Path(a.out).write_text(json.dumps(cert, indent=2), "utf-8")

    hw = cert["hardware"]
    cap = cert["capacity"]
    print("-" * 60)
    print(f"Gravitone hardware certification  [{cert['verdict'].upper()}]")
    print("-" * 60)
    print(f"Box: {hw.get('cpu_model') or hw.get('processor') or hw['machine']} "
          f"({hw['cpu_count']} cores, {hw.get('memory_gb') or '?'} GB)")
    for c in cert["checks"]:
        print(f"  {'PASS' if c['pass'] else 'FAIL'}  {c['check']}: {c['got']} (want {c['want']})")
    if cap["audio_minutes_per_hour"]:
        print(f"Capacity: ~{cap['audio_minutes_per_hour']} audio-min/hour at cap {cap['recommended_cap']}")
    contract = cert.get("capacity_contract")
    if contract:
        print(f"Contract: sustains {contract['max_rate_rps']} req/s at p95 <= "
              f"{contract['slo']['p95_s']}s "
              f"~= {contract['concurrent_users']} concurrent listeners"
              + (f", held {contract['soak_minutes']} min"
                 if contract["soak_minutes"] else " (no soak)"))
        print(f"          {contract['concurrent_users_basis']}")
    elif cert["slo"]["declared"]:
        print(f"Contract: REFUSED — {'; '.join(cert['slo']['reasons'])}")
    topo = cert["topology"]
    if not topo["pool_aggregate_available"]:
        print(f"Server counters: {topo['server_metrics_scope']} — "
              f"{topo['server_metrics_note']}")
    rc = cert["recommended_config"]
    print(f"Config: {rc['replicas']} replicas x TTS_TORCH_THREADS={rc['TTS_TORCH_THREADS']}, "
          f"TTS_QUEUE_MAX={rc['TTS_QUEUE_MAX']}")
    # The launcher pins TTS_WORKERS=1 and the per-replica thread budget itself;
    # this is the exact command that runs the recommended topology.
    print(f"Run it: python -m service.replicas --replicas {rc['replicas']} --port 8000")
    print(f"wrote {a.out}")
    if cert["verdict"] == "certified":
        print("Add your box to the matrix: PR this file per docs/SUPPORTED_HARDWARE.md")
    raise SystemExit(0 if cert["verdict"] == "certified" else 2)


if __name__ == "__main__":
    main()
