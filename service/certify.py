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

CERT_VERSION = "gravitone-cert/1"
CERT_SECRET = os.environ.get("GRAVITONE_CERT_SECRET", "")

# Certification bar: what "this box can serve Gravitone" means.
THRESHOLDS = {
    "single_stream_rtf_min": 1.0,   # faster than realtime, one stream
    "recommended_cap_min": 1,       # at least one healthy concurrency level
    "errors_at_cap_max": 0,         # zero failures at the recommended cap
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

    checks = [
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
    ]
    return {
        "checks": checks,
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


def _canonical(cert: dict) -> bytes:
    unsigned = {k: v for k, v in cert.items() if k not in ("sha256", "signature")}
    return json.dumps(unsigned, sort_keys=True, separators=(",", ":")).encode()


def build_certificate(result: dict) -> dict:
    cert = {
        "version": CERT_VERSION,
        "issued": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "hardware": gather_hardware(),
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
