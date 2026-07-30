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


# ---------------------------------------------------------------------------
# The performance ledger - append-only history, never a rewrite
# ---------------------------------------------------------------------------
# A certificate is a snapshot; the ledger is the TIME SERIES that makes the
# performance claim falsifiable. Layout:
#
#   docs/certifications/<hw_fingerprint>/<git_sha>.json   the raw certificate
#   docs/certifications/ledger.json                       the append-only index
#
# The index exists so a CI gate can find "the newest row for this hardware
# class" without reading every certificate, and so a human can see the shape of
# the history at a glance. It is a PROJECTION of the certificates, never a
# replacement for them: every row points at the artifact it summarises and can
# be re-derived from it, which is exactly how tampering is detected.
LEDGER_VERSION = "gravitone-ledger/1"
DEFAULT_LEDGER_DIR = "docs/certifications"
LEDGER_INDEX = "ledger.json"

# Hardware fields that identify the BOX CLASS. Deliberately NOT the whole
# gather_hardware() dict: `system` carries the kernel release, and a kernel
# upgrade is a change worth MEASURING on the same box, not a reason to start a
# fresh history under a new fingerprint. Pinned as an explicit tuple so a future
# field added to gather_hardware() cannot silently reshuffle every fingerprint
# already written to the ledger.
FINGERPRINT_KEYS = ("machine", "cpu_count", "cpu_model", "processor",
                    "memory_gb")

# Row fields that are a pure projection of the certificate (plus the row's own
# instance_type and file name) and are therefore RE-DERIVABLE - this is the set
# integrity checking covers.
CERT_DERIVED_ROW_FIELDS = ("hw_fingerprint", "cpu_model", "cores", "git_sha",
                           "issued", "single_stream_rtf", "cap",
                           "aud_s_at_cap", "verdict", "sha256")

# Row fields carried from the load-test RESULT, which the certificate does not
# contain and its hash therefore does not cover. They are provenance, not
# claims; the README says so, and nothing gates on them.
RESULT_DERIVED_ROW_FIELDS = ("torch_version", "fpmath")

# What makes two rows THE SAME MEASUREMENT. Deliberately excludes `issued` and
# `sha256`: re-running `certify --append-ledger` over one result JSON mints a
# fresh certificate with a new timestamp and therefore a new hash, so
# sha-only deduplication would let a retried CI step write the same benchmark
# into history twice. Every field a row actually CLAIMS is here; only the
# moment of issuance is not.
MEASUREMENT_IDENTITY_FIELDS = ("hw_fingerprint", "instance_type", "git_sha",
                               "torch_version", "fpmath", "single_stream_rtf",
                               "cap", "aud_s_at_cap", "verdict")


class LedgerIntegrityError(Exception):
    """The ledger disagrees with the certificates it claims to summarise."""


def hw_fingerprint(hardware: dict, instance_type: str | None = None) -> str:
    """Stable short hash naming a box class (hardware + optional instance type).

    Two runs on the same instance type share a fingerprint, so their rows form
    one comparable series - which is the only way a trend line means anything.
    """
    payload = {k: hardware.get(k) for k in FINGERPRINT_KEYS}
    payload["instance_type"] = instance_type or None
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(blob).hexdigest()[:16]


def ledger_row(cert: dict, result: dict | None = None,
               instance_type: str | None = None,
               cert_path: str | None = None) -> dict:
    """Summarise one certificate as an index row.

    ``result`` supplies the reproducibility stamp the certificate itself does
    not carry (torch version, fpmath mode, the harness git SHA). Without it
    those fields are None rather than guessed - an unknown torch version is
    information, an invented one is a lie.
    """
    result = result or {}
    hardware = cert.get("hardware") or {}
    capacity = cert.get("capacity") or {}
    fingerprint = hw_fingerprint(hardware, instance_type)
    sha = str(cert.get("git_sha") or result.get("git_sha") or "unknown")
    return {
        "hw_fingerprint": fingerprint,
        "instance_type": instance_type or None,
        "cpu_model": hardware.get("cpu_model") or hardware.get("processor"),
        "cores": hardware.get("cpu_count"),
        "git_sha": sha,
        "issued": cert.get("issued"),
        "torch_version": result.get("torch_version"),
        "fpmath": result.get("onednn_fpmath_mode"),
        "single_stream_rtf": capacity.get("single_stream_rtf"),
        "cap": capacity.get("recommended_cap"),
        "aud_s_at_cap": capacity.get("audio_s_per_wall_s_at_cap"),
        "verdict": cert.get("verdict"),
        "sha256": cert.get("sha256"),
        "cert_path": cert_path or f"{fingerprint}/{sha}.json",
    }


def empty_ledger() -> dict:
    return {
        "version": LEDGER_VERSION,
        "note": ("append-only index of hardware certifications. Rows are a "
                 "projection of docs/certifications/<hw_fingerprint>/"
                 "<git_sha>.json and are re-derived from those files to detect "
                 "edits; existing rows are NEVER rewritten. See README.md."),
        "rows": [],
    }


def load_ledger(path) -> dict:
    """Read the index, or an empty one. A corrupt index is an ERROR, not a
    fresh start: silently replacing unreadable history is how history is lost."""
    p = Path(path)
    if not p.exists():
        return empty_ledger()
    try:
        doc = json.loads(p.read_text("utf-8"))
    except json.JSONDecodeError as exc:
        raise LedgerIntegrityError(f"{p} is not valid JSON ({exc}) - refusing "
                                   f"to append to a ledger that cannot be "
                                   f"read") from None
    if not isinstance(doc, dict) or not isinstance(doc.get("rows"), list):
        raise LedgerIntegrityError(f"{p} is not a ledger document")
    return doc


def verify_ledger(ledger: dict, ledger_dir) -> dict:
    """Re-derive every row from its certificate. Returns problems, by kind.

    ``tampered`` - the certificate is present and the row DISAGREES with it (or
    the certificate no longer passes its own hash). Fatal: appending to a ledger
    whose history has been edited would launder the edit.

    ``unverifiable`` - no certificate file for the row. Reported, never fatal:
    the proposal keeps a full certificate only for verdict changes, so a
    pruned artifact is an expected state, and refusing on it would make the
    pruning policy unusable. Such a row simply proves nothing on its own.
    """
    root = Path(ledger_dir)
    tampered, unverifiable = [], []
    for idx, row in enumerate(ledger.get("rows") or []):
        rel = row.get("cert_path") or ""
        cert_file = root / rel
        if not rel or not cert_file.exists():
            unverifiable.append({"index": idx, "row": row,
                                 "reason": f"no certificate at {rel or '(unset)'}"})
            continue
        try:
            cert = json.loads(cert_file.read_text("utf-8"))
        except json.JSONDecodeError:
            tampered.append({"index": idx, "row": row,
                             "reason": f"{rel} is not valid JSON"})
            continue
        if not verify_certificate(cert, CERT_SECRET):
            tampered.append({"index": idx, "row": row,
                             "reason": f"{rel} fails its own integrity check"})
            continue
        expected = ledger_row(cert, instance_type=row.get("instance_type"),
                              cert_path=rel)
        # git_sha is carried from the result, but the artifact is NAMED for it,
        # so the file name makes it verifiable after all.
        stem_sha = cert_file.stem.split("-")[0]
        mismatched = [f for f in CERT_DERIVED_ROW_FIELDS
                      if f != "git_sha" and row.get(f) != expected.get(f)]
        if row.get("git_sha") != stem_sha:
            mismatched.append("git_sha")
        if mismatched:
            tampered.append({
                "index": idx, "row": row, "fields": sorted(mismatched),
                "reason": (f"row disagrees with {rel} on "
                           f"{', '.join(sorted(mismatched))}")})
    return {"tampered": tampered, "unverifiable": unverifiable,
            "ok": not tampered}


def _write_json_atomic(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(doc, indent=2) + "\n", "utf-8")
    os.replace(tmp, path)


def append_ledger(cert: dict, result: dict | None = None, *,
                  ledger_dir=DEFAULT_LEDGER_DIR,
                  instance_type: str | None = None) -> dict:
    """Verify a certificate, then APPEND it to the ledger. Never a rewrite.

    Three refusals, all of them the point of the feature:
      * a certificate that fails its own integrity check is not recorded;
      * a ledger whose existing rows no longer match their certificates is not
        extended - the edit is surfaced instead of being buried under a new row;
      * a certificate already in the ledger (same sha256) is a no-op, so a
        re-run of the CI step cannot duplicate history.
    """
    if not verify_certificate(cert, CERT_SECRET):
        raise LedgerIntegrityError(
            "certificate failed verification - nothing was appended")

    root = Path(ledger_dir)
    index_path = root / LEDGER_INDEX
    ledger = load_ledger(index_path)
    integrity = verify_ledger(ledger, root)
    if integrity["tampered"]:
        raise LedgerIntegrityError(
            "existing ledger rows no longer match their certificates: "
            + "; ".join(t["reason"] for t in integrity["tampered"])
            + " - refusing to append (history must be repaired, not extended)")

    sha = cert.get("sha256")
    provisional = ledger_row(cert, result, instance_type)
    identity = {k: provisional.get(k) for k in MEASUREMENT_IDENTITY_FIELDS}
    for index, row in enumerate(ledger["rows"]):
        if sha and row.get("sha256") == sha:
            return {"appended": False, "row": row, "ledger": ledger,
                    "reason": f"certificate {sha[:12]} is already row {index}"}
        if all(row.get(k) == v for k, v in identity.items()):
            return {"appended": False, "row": row, "ledger": ledger,
                    "reason": (f"row {index} already records this measurement "
                               f"({identity['git_sha']} on "
                               f"{identity['hw_fingerprint']}); only the "
                               f"issuance timestamp differs")}

    fingerprint, git = provisional["hw_fingerprint"], provisional["git_sha"]
    # Same commit re-benchmarked on the same box: keep BOTH artifacts. The
    # ledger is a history, and overwriting yesterday's certificate to make room
    # for today's is precisely the rewrite this module refuses to do.
    rel = f"{fingerprint}/{git}.json"
    if (root / rel).exists():
        rel = f"{fingerprint}/{git}-{str(sha)[:8]}.json"
    row = ledger_row(cert, result, instance_type, cert_path=rel)

    _write_json_atomic(root / rel, cert)
    ledger["rows"].append(row)
    ledger["version"] = LEDGER_VERSION
    _write_json_atomic(index_path, ledger)
    return {"appended": True, "row": row, "ledger": ledger,
            "cert_path": str(root / rel), "reason": "appended"}


def newest_row(ledger: dict, fingerprint: str) -> dict | None:
    """The most recent row for a hardware class - what a PR gate diffs against.

    "Most recent" is ledger ORDER, not the ``issued`` string: the ledger is
    append-only, so its order is the history, and trusting a self-reported
    timestamp would let a backdated row jump the queue.
    """
    for row in reversed(ledger.get("rows") or []):
        if row.get("hw_fingerprint") == fingerprint:
            return row
    return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--result", default="service/loadtest_result.json")
    ap.add_argument("--out", default="certification.json")
    ap.add_argument("--append-ledger", action="store_true",
                    help="append this certificate to the append-only "
                         "performance ledger (docs/certifications)")
    ap.add_argument("--ledger-dir", default=DEFAULT_LEDGER_DIR)
    ap.add_argument("--instance-type", default=None,
                    help="cloud instance type, part of the hardware "
                         "fingerprint (e.g. c8g.2xlarge)")
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
    if a.append_ledger:
        try:
            outcome = append_ledger(cert, result, ledger_dir=a.ledger_dir,
                                    instance_type=a.instance_type)
        except LedgerIntegrityError as exc:
            print(f"!! ledger refused the append: {exc}")
            raise SystemExit(2) from None
        row = outcome["row"]
        if outcome["appended"]:
            print(f"ledger: appended {row['hw_fingerprint']}/{row['git_sha']} "
                  f"({row['verdict']}) -> {outcome['cert_path']}")
        else:
            print(f"ledger: no-op - {outcome['reason']}")
    if cert["verdict"] == "certified":
        print("Add your box to the matrix: PR this file per docs/SUPPORTED_HARDWARE.md")
    raise SystemExit(0 if cert["verdict"] == "certified" else 2)


if __name__ == "__main__":
    main()
