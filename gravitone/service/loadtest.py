"""Ramp load-tester: find the concurrency cap before critical degradation.

Fires an increasing number of *parallel* requests at the running service and,
for each concurrency level, records latency percentiles, throughput, the
server's real-time factor, 429/error rates, and host CPU/RAM. It then reports
the "knee" — the highest concurrency that still meets the quality bar — which
is the cap you'd configure (TTS_WORKERS / queue policy) for deployment.

Usage:
  uv run --no-dev python -m service.loadtest \
      --url http://127.0.0.1:8080 --voice step4 \
      --levels 1,2,3,4,6,8 --requests 12

  # Sizing advisor: turn an existing result JSON into the exact env vars
  # (also printed automatically at the end of every run):
  python -m service.loadtest --plan [--out service/loadtest_result.json]

  # OPEN-LOOP capacity contract: "how many users does this box serve at an SLO"
  python -m service.loadtest --arrival poisson --rate 2,4,6,8 --duration 60 \
      --slo-p95 2.0 --slo-violations-max 0.01 --soak 10

Two arrival modes, measuring two different things:
  * ``--arrival closed`` (default) — the concurrency ramp above. N requests
    behind a semaphore: a new one starts only when a previous one finishes.
    This measures how many SIMULTANEOUS streams the box tolerates.
  * ``--arrival poisson`` — an OPEN-LOOP driver. Requests are scheduled on
    wall-clock offsets from a Poisson process (``service/workload.py``) and
    fire regardless of how many are still in flight, so when the server slows
    the load does NOT politely back off and queueing — the real production
    failure mode — actually appears. This measures how many USERS the box
    serves at a declared latency SLO, which is the number an operator can be
    held to. Every request carries its own generated script, so the synthesis
    cache is defeated by construction, not merely asked to stand aside.

!! OPEN-LOOP RUNS CAN MELT A SMALL BOX. Run them on an IDLE machine (nothing
else serving, ideally the load generator off-box) and keep ``--max-in-flight``
set: it is a HARD circuit breaker — arrivals past the ceiling are refused by the
driver, counted as ``refused_in_flight``, and reported, so the harness never
turns a capacity question into an outage.

Degradation is flagged when ANY of these trip vs the level-1 baseline:
  * p95 latency > --degrade-factor x baseline p95   (default 2.0)
  * any HTTP 429 (queue overflow), 504 (timeout), or other errors
  * host CPU >= --cpu-ceiling% AND server realtime_factor < 1.0 (slower than realtime)

Honest cache accounting: the service caches finished synthesis per process
(``service/cache.py``, ON by default), and this harness sends ONE constant text
at every level — so without care every request after the first would be an LRU
lookup and the whole ramp would measure the cache, not the model. Every request
this tool fires therefore carries the cache-bypass headers by default
(``--cache-mode bypass``): the server renders it or fails. ``--cache-mode
allow`` is available to characterise the cache itself, and a run that recorded
ANY cache hit is flagged per level (``cache_hits``) and refuses certification.

Honest CPU accounting: co-locating the load generator with the server means a
whole-host CPU number double-counts the driver. Pass ``--server-pid`` (the
benchmark scripts know the PID they launched) to split the server's process-tree
CPU (server_cpu_*) from the driver's own CPU (driver_cpu_*), keeping the whole
host (host_cpu_*) for continuity. Without a PID we report host-only and say so.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import subprocess
import sys
import time

import httpx

from service.workload import (DEFAULT_PROFILE, PROFILES, arrival_schedule,
                              corpus_capacity, corpus_series, schedule_stats)

try:
    import psutil
except ImportError:  # resource sampling is best-effort
    psutil = None

TEXT_DEFAULT = (
    "This is a load test sentence for the pocket text to speech service. "
    "It is long enough to produce several seconds of audio per request."
)

# Result-JSON schema version. Bump when the shape changes so two result files
# can be compared safely (v1 = the pre-versioned shape; v2 = self-describing;
# v3 = cache-aware — the run states its cache_mode and every level reports how
# many responses were served from cache, so a v<=2 file CANNOT be trusted as a
# measurement of synthesis: it was produced by a harness that had no idea the
# synthesis cache existed and may be entirely cache hits).
SCHEMA_VERSION = 3

# How the harness treats the server's synthesis cache.
#   bypass (default) — every request carries no-store/bypass headers, so the
#     model renders it. This is what "measuring the engine" means.
#   allow            — cache behaves normally; use ONLY to characterise the
#     cache. Such a run is not a valid capacity measurement and certify refuses it.
CACHE_MODES = ("bypass", "allow")
DEFAULT_CACHE_MODE = "bypass"

# Sent on every benchmark request in bypass mode. Both spellings, so the run is
# honest against a proxy/build that understands only the standard one.
CACHE_BYPASS_HEADERS = {
    "Cache-Control": "no-store",
    "X-Gravitone-Cache": "bypass",
}


def request_headers(cache_mode: str = DEFAULT_CACHE_MODE) -> dict:
    """HTTP headers for one benchmark request.

    Defaulted to bypass ON PURPOSE: an operator who never heard of the cache
    must still get numbers that describe the model. Opting into cached numbers
    has to be an explicit ``--cache-mode allow``.
    """
    return dict(CACHE_BYPASS_HEADERS) if cache_mode != "allow" else {}

# Below this many successful samples per level, p95/p99 are statistically noisy
# and get flagged rather than trusted.
LOW_CONFIDENCE_N = 20

# The driver is "saturated" — a bottleneck in its own right — when its own
# process CPU crosses ~90% of ONE core (psutil Process.cpu_percent is per-core,
# so 100.0 == one full core). Past this the load generator, not the server, may
# be limiting throughput, so the level's numbers understate server capacity.
DRIVER_SATURATION_PCT = 90.0

# ---------------------------------------------------------------------------
# Open-loop capacity contract
# ---------------------------------------------------------------------------
# closed  — the historical concurrency ramp (semaphore, self-throttling).
# poisson — wall-clock arrivals that do NOT wait for in-flight work.
ARRIVAL_MODES = ("closed", "poisson")
DEFAULT_ARRIVAL = "closed"

# HARD circuit breaker. Open-loop load against an overloaded box grows without
# bound (that is the point of open-loop), so the driver refuses arrivals past
# this many in flight instead of driving the machine into swap/OOM. Refusals
# are COUNTED and reported — a level that needed the breaker did not sustain
# its offered rate, and is treated as degraded.
DEFAULT_MAX_IN_FLIGHT = 64

# Seconds a single listener waits between requests. Capacity in req/s becomes
# capacity in *people* only through this assumption, so it is stated, stored in
# the result, and printed — never buried in a constant.
DEFAULT_THINK_TIME_S = 30.0

# Default SLO violation budget: 1% of successful requests may exceed the p95
# target before the rate is judged unsustainable.
DEFAULT_SLO_VIOLATIONS_MAX = 0.01

IDLE_BOX_WARNING = (
    "open-loop load does not back off when the server slows: run this on an "
    "IDLE box (ideally with the load generator off-box) and keep "
    "--max-in-flight set as a hard circuit breaker")


def pct(data, p):
    if not data:
        return None
    s = sorted(data)
    k = min(len(s) - 1, int(round((p / 100.0) * (len(s) - 1))))
    return round(s[k], 4)


# ---------------------------------------------------------------------------
# Honest measurement accounting (pure, unit-testable without a live server)
# ---------------------------------------------------------------------------
def classify_response(status_code: int) -> str:
    """Map an HTTP status to a load-test outcome bucket.

    504 is its OWN bucket ("timeout") — the engine counts synthesis timeouts
    distinctly (Metrics.on_timeout), and lumping them into "error" hides queue
    overload behind a generic failure count. 429 = admission refused (rejected).
    """
    if status_code == 200:
        return "ok"
    if status_code == 429:
        return "rejected"
    if status_code == 504:
        return "timeout"
    return "error"


def level_degraded(row: dict, baseline_p95, degrade_factor: float,
                   cpu_ceiling: float, *, slo_p95=None,
                   slo_violations_max=None) -> bool:
    """Whether a level trips the degradation bar (pure, so it is unit-testable).

    ANY 429, 504 timeout, error, 501-unsupported, or breaker refusal degrades
    the level (a timeout is treated exactly like an error/429 — the caller gave
    up waiting; a 501 means the route served nothing at all; a refusal means
    the driver had to protect the box, so the level did NOT sustain its rate).

    With an SLO declared (``slo_p95``, optionally ``slo_violations_max``) the
    bar becomes the SLO itself: the level is healthy iff its p95 is inside the
    target and its violation rate is inside the budget. That is the whole point
    of the capacity contract — the operator's promise, not a relative blow-up
    against whatever the first level happened to do. Without an SLO the
    original rules (p95 factor vs baseline, CPU-saturated-and-sub-realtime)
    stay in force as the fallback.
    """
    # unsupported_501 is a distinct outcome bucket, but a level where every
    # request 501s served ZERO audio — without counting it, an all-501 run
    # (e.g. --route stream on a build without it) has no errors and no p95, so
    # it looks identical to a perfectly healthy level and the tool reports
    # "no degradation" plus a bogus cap over total failure.
    if (row.get("rejected_429") or row.get("errors") or row.get("timeouts")
            or row.get("unsupported_501") or row.get("refused_in_flight")):
        return True
    if slo_p95 is not None:
        p95 = row.get("lat_p95_s")
        if p95 is None:
            # No successful samples at all: nothing met the SLO.
            return True
        if p95 > slo_p95:
            return True
        vr = row.get("slo_violation_rate")
        if (slo_violations_max is not None and vr is not None
                and vr > slo_violations_max):
            return True
        return False
    p95 = row.get("lat_p95_s")
    if baseline_p95 and p95 and p95 > degrade_factor * baseline_p95:
        return True
    # Prefer the server-only CPU when the honest split is available: the
    # whole-host figure double-counts a co-located load generator, so the
    # driver's own CPU could trip the ceiling and blame the server for
    # saturation it didn't cause (a false knee, understating real capacity).
    cpu = row.get("server_cpu_mean_pct")
    if cpu is None:
        cpu = row.get("cpu_mean_pct")
    srtf = row.get("server_rtf_mean")
    if cpu and cpu >= cpu_ceiling and srtf is not None and srtf < 1.0:
        return True
    return False


def _cpu_stats(vals):
    """(mean, max) of a CPU sample list rounded to 0.1, or (None, None)."""
    if not vals:
        return None, None
    return round(statistics.mean(vals), 1), round(max(vals), 1)


def is_driver_saturated(driver_cpu_max) -> bool:
    """True when the driver's own peak CPU crossed the one-core saturation line."""
    return driver_cpu_max is not None and driver_cpu_max >= DRIVER_SATURATION_PCT


def _proc_tree_cpu(proc):
    """Sum ``cpu_percent(None)`` over ``proc`` and its live descendants.

    Returns the process-tree CPU (server side), or ``None`` if the root process
    is gone. A child that vanishes mid-sample is skipped rather than fatal — the
    replica pool spawns/reaps workers, so a transient miss must not crash a run.
    """
    if proc is None:
        return None
    try:
        total = float(proc.cpu_percent(None))
    except Exception:  # noqa: BLE001 - server process gone
        return None
    try:
        for ch in proc.children(recursive=True):
            try:
                total += float(ch.cpu_percent(None))
            except Exception:  # noqa: BLE001 - child reaped mid-sample
                pass
    except Exception:  # noqa: BLE001
        pass
    return total


def _prime_tree(proc) -> None:
    """Prime cpu_percent on a process tree so the first real sample is a delta."""
    if proc is None:
        return
    try:
        proc.cpu_percent(None)
        for ch in proc.children(recursive=True):
            try:
                ch.cpu_percent(None)
            except Exception:  # noqa: BLE001
                pass
    except Exception:  # noqa: BLE001
        pass


def cpu_accounting_note(server_pid) -> str:
    """One-line JSON note describing which CPU signals a result actually has."""
    if server_pid is not None:
        return ("host+server+driver: server_cpu_* is the --server-pid process "
                "tree, driver_cpu_* is this load generator, host_cpu_* is the "
                "whole box")
    return ("host-only: pass --server-pid so server CPU is measured apart from "
            "the load generator's own CPU (host_cpu_* double-counts the driver)")


def cpu_row(samples: dict) -> dict:
    """The CPU/RAM slice of a level row, shared by both arrival modes.

    ``cpu_mean_pct``/``cpu_max_pct`` stay = whole-host for continuity with
    existing result files and summary scripts; ``host_cpu_*`` mirrors them
    under the explicit name and ``server_``/``driver_`` carry the honest split
    (None without ``--server-pid``).
    """
    host_mean, host_max = _cpu_stats(samples.get("cpu") or [])
    server_mean, server_max = _cpu_stats(samples.get("server") or [])
    driver_mean, driver_max = _cpu_stats(samples.get("driver") or [])
    mem = samples.get("mem") or []
    return {
        "cpu_mean_pct": host_mean,
        "cpu_max_pct": host_max,
        "host_cpu_mean_pct": host_mean,
        "host_cpu_max_pct": host_max,
        "server_cpu_mean_pct": server_mean,
        "server_cpu_max_pct": server_max,
        "driver_cpu_mean_pct": driver_mean,
        "driver_cpu_max_pct": driver_max,
        "driver_saturated": is_driver_saturated(driver_max),
        "mem_max_pct": round(max(mem), 1) if mem else None,
    }


# ---------------------------------------------------------------------------
# Open-loop capacity: SLO arithmetic (pure, unit-testable without a server)
# ---------------------------------------------------------------------------
class AdmissionGate:
    """The driver's HARD circuit breaker (pure — no I/O, so it is testable).

    Open-loop means arrivals do not wait for in-flight work, so an overloaded
    box would accumulate requests until something dies. This gate refuses
    arrivals past ``max_in_flight``, counts every refusal, and remembers the
    peak concurrency actually reached. ``max_in_flight <= 0`` disables the
    breaker (never do that on a box you care about).
    """

    def __init__(self, max_in_flight: int = DEFAULT_MAX_IN_FLIGHT) -> None:
        self.max_in_flight = int(max_in_flight)
        self.in_flight = 0
        self.peak_in_flight = 0
        self.refused = 0

    def try_acquire(self) -> bool:
        if 0 < self.max_in_flight <= self.in_flight:
            self.refused += 1
            return False
        self.in_flight += 1
        self.peak_in_flight = max(self.peak_in_flight, self.in_flight)
        return True

    def release(self) -> None:
        self.in_flight = max(0, self.in_flight - 1)


def violation_rate(latencies, slo_p95) -> float | None:
    """Fraction of SUCCESSFUL samples slower than the SLO target.

    None when no SLO is declared or nothing succeeded — an empty run has no
    violation rate, and reporting 0.0 there would read as "perfect".
    """
    if slo_p95 is None or not latencies:
        return None
    over = sum(1 for x in latencies if x > slo_p95)
    return round(over / len(latencies), 4)


def queue_wait_p95_s(queue_depths, goodput_req_s) -> float | None:
    """p95 queue WAIT estimated from sampled queue DEPTH via Little's law.

    The server exposes queue depth (the ``queued`` counter scraped per level),
    not per-request wait, so wait = depth / completion-rate. Estimated, and
    labelled as such in the JSON: it is the honest reading of the signal we
    have rather than a number we cannot substantiate.
    """
    if not queue_depths or not goodput_req_s:
        return None
    depth = pct(list(queue_depths), 95)
    if depth is None:
        return None
    return round(depth / goodput_req_s, 4)


def concurrent_users(rate_rps, think_time_s: float = DEFAULT_THINK_TIME_S):
    """Sustained req/s -> simultaneous listeners, at a stated think time.

    A listener who asks for speech every ``think_time_s`` seconds contributes
    ``1 / think_time_s`` req/s, so N users = rate x think time. The assumption
    is the whole conversion, so it travels with the number everywhere.
    """
    if not rate_rps or not think_time_s:
        return None
    return int(round(float(rate_rps) * float(think_time_s)))


def slo_knee(rows, slo_p95, slo_violations_max=DEFAULT_SLO_VIOLATIONS_MAX):
    """(max sustained offered rate, first failing rate) over open-loop rows.

    The knee of a capacity contract is the HIGHEST offered rate that met the
    SLO — and only rates below the first failure count, because a box that
    fails at 6 req/s and passes at 8 is telling you its 8 was luck (or that
    the run was too short), not that it sustains 8.
    """
    sustained = None
    first_fail = None
    for row in rows:
        rate = row.get("offered_rate_rps")
        if rate is None:
            continue
        bad = level_degraded(row, None, 0.0, 100.0, slo_p95=slo_p95,
                             slo_violations_max=slo_violations_max)
        if bad:
            if first_fail is None:
                first_fail = rate
            continue
        if first_fail is None:
            sustained = rate if sustained is None else max(sustained, rate)
    return sustained, first_fail


def parse_rates(spec) -> list:
    """"2,4,6.5" -> [2.0, 4.0, 6.5] (ascending, deduped, positives only)."""
    if isinstance(spec, (int, float)):
        return [float(spec)]
    out = []
    for part in str(spec).split(","):
        part = part.strip()
        if not part:
            continue
        v = float(part)
        if v > 0 and v not in out:
            out.append(v)
    return sorted(out)


def corpus_description(args) -> str:
    """What was actually spoken — the ``corpus`` field of the result JSON.

    Closed-loop sends one constant text, so the text IS the corpus. Open-loop
    sends a distinct generated body per request, so the corpus is the profile
    plus the seed that replays it. Two runs are only comparable if this string
    matches, which is why it must never flatten to "the default sentence".
    """
    if getattr(args, "arrival", DEFAULT_ARRIVAL) != "poisson":
        return args.text
    return (f"workload:{getattr(args, 'corpus_profile', DEFAULT_PROFILE)} "
            f"seed={getattr(args, 'seed', 0)} (distinct body per request)")


def open_loop_recommended_cap(rows, slo):
    """Peak in-flight observed at the sustained rate = the cap to configure.

    Open-loop never chooses a concurrency, it DISCOVERS one: at the sustained
    rate the box held this many requests at once, so that is the admission
    ceiling worth configuring. None when no rate was sustained — never a guess.
    """
    rate = (slo or {}).get("max_rate_rps")
    if not rate:
        return None
    row = next((r for r in rows
                if r.get("offered_rate_rps") == rate and not r.get("soak")), None)
    return (row or {}).get("peak_in_flight") or None


def open_loop_row(*, offered_rate, duration_s, scheduled, refused, results,
                  wall_s, samples=None, queue_depths=(), slo_p95=None,
                  slo_violations_max=DEFAULT_SLO_VIOLATIONS_MAX,
                  peak_in_flight=0, route="synth",
                  cache_mode=DEFAULT_CACHE_MODE, soak=False) -> dict:
    """Assemble one open-loop level row (pure over already-collected samples).

    ``concurrency`` on an open-loop row is the OBSERVED PEAK in-flight count,
    not a configured limit — nobody chose it, the arrival process produced it —
    so downstream consumers (print_plan, certify) keep working while the row
    says plainly where the number came from (``peak_in_flight``).
    """
    lats = results.get("lat") or []
    ok = len(lats)
    fired = scheduled - refused
    audio_total = sum(results.get("audio") or [])
    rtfs = [x for x in (results.get("rtf") or []) if x == x]  # drop nan
    goodput = round(ok / wall_s, 3) if wall_s else None
    row = {
        "arrival": "poisson",
        "soak": bool(soak),
        "offered_rate_rps": round(float(offered_rate), 3),
        "scheduled": scheduled,
        "fired": fired,
        "refused_in_flight": refused,
        "duration_s": round(float(duration_s), 2),
        "wall_s": round(wall_s, 2),
        "requests": scheduled,
        "ok": ok,
        "rejected_429": results.get("rejected", 0),
        "timeouts": results.get("timeouts", 0),
        "errors": results.get("errors", 0),
        # Achieved arrival rate: what the driver actually managed to put on the
        # wire. If it trails offered_rate the DRIVER is the bottleneck, and the
        # level understates the server (same honesty as driver_saturated).
        "achieved_rate_rps": round(fired / wall_s, 3) if wall_s else None,
        "goodput_req_s": goodput,
        "throughput_req_s": goodput,   # same figure under the closed-loop name
        "audio_s_per_wall_s": round(audio_total / wall_s, 3) if wall_s else None,
        "lat_p50_s": pct(lats, 50),
        "lat_p95_s": pct(lats, 95),
        "lat_p99_s": pct(lats, 99),
        "server_rtf_mean": round(statistics.mean(rtfs), 3) if rtfs else None,
        "slo_p95_s": slo_p95,
        "slo_violations_max": slo_violations_max,
        "slo_violation_rate": violation_rate(lats, slo_p95),
        "queue_depth_p95": pct(list(queue_depths), 95) if queue_depths else None,
        "queue_wait_p95_s": queue_wait_p95_s(queue_depths, goodput),
        "queue_wait_basis": ("Little's law over sampled /metrics queue depth "
                             "(depth p95 / goodput) — an estimate, not a "
                             "per-request measurement"),
        "peak_in_flight": peak_in_flight,
        "concurrency": peak_in_flight,
        "max_in_flight_refusals": refused,
        "cache_mode": cache_mode,
        "cache_hits": results.get("cache_hits", 0),
        "measures_synthesis": results.get("cache_hits", 0) == 0,
    }
    row.update(cpu_row(samples or {}))
    if route == "stream":
        row["ttfb_p50_s"] = pct(results.get("ttfb") or [], 50)
        row["ttfb_p95_s"] = pct(results.get("ttfb") or [], 95)
        row["ttfb_p99_s"] = pct(results.get("ttfb") or [], 99)
        row["unsupported_501"] = results.get("unsupported", 0)
    return mark_low_confidence(row)


def workload_block(*, rates, duration_s, seed, profile, max_in_flight, rows,
                   think_time_s=DEFAULT_THINK_TIME_S) -> dict:
    """What traffic was offered, and the honesty flags that qualify it."""
    refused = sum(int(r.get("refused_in_flight") or 0) for r in rows)
    return {
        "arrival": "poisson",
        "rates_rps": list(rates),
        "duration_s": duration_s,
        "seed": seed,
        "corpus_profile": profile,
        "corpus_distinct_bodies": True,
        "corpus_note": ("every request carried its own generated script "
                        "(service/workload.py), so no response could come from "
                        "the synthesis cache — cache-defeat by construction, "
                        "not by asking the server nicely"),
        "max_in_flight": max_in_flight,
        "refused_in_flight_total": refused,
        "breaker_tripped": refused > 0,
        "think_time_s": think_time_s,
        "idle_box_warning": IDLE_BOX_WARNING,
        "driver_saturated_any": any(r.get("driver_saturated") for r in rows),
    }


def slo_block(*, slo_p95, violations_max, max_rate, first_fail, soak_minutes,
              soak_ok=None, think_time_s=DEFAULT_THINK_TIME_S,
              predicted=False) -> dict:
    """The capacity PROMISE this run substantiates (or declines to).

    ``predicted`` exists so a fitted/extrapolated number can never be mistaken
    for a measured one: certify refuses to sign a predicted-only contract, the
    same way it refuses a cache-contaminated measurement.
    """
    sustained = max_rate if (max_rate and soak_ok is not False) else None
    if sustained is None:
        note = ("no offered rate met the SLO" if not max_rate else
                "the soak at the candidate rate did not hold — the rate is not "
                "sustainable, only briefly reachable")
    else:
        note = (f"sustained {sustained} req/s with p95 <= {slo_p95}s and "
                f"<= {round(violations_max * 100, 2)}% violations"
                + (f" for {soak_minutes} minute(s)" if soak_minutes else
                   " (no soak run: this is a short-run result)"))
    return {
        "p95_s": slo_p95,
        "violations_max": violations_max,
        "max_rate_rps": sustained,
        "candidate_rate_rps": max_rate,
        "first_failing_rate_rps": first_fail,
        "soak_minutes": soak_minutes,
        "soak_passed": soak_ok,
        "think_time_s": think_time_s,
        "concurrent_users": concurrent_users(sustained, think_time_s),
        "concurrent_users_basis": (
            f"max_rate_rps x think_time_s ({think_time_s}s between one "
            f"listener's requests) — change the think time and the headcount "
            f"changes with it"),
        "predicted": predicted,
        "note": note,
    }


# ---------------------------------------------------------------------------
# Reproducibility metadata (pure, unit-testable without a live server)
# ---------------------------------------------------------------------------
def git_sha() -> str:
    """Short git SHA of the harness that produced a result, or "unknown"."""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=5,
        )
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except Exception:  # noqa: BLE001 - git absent / not a repo / timeout
        pass
    return "unknown"


def torch_version() -> str | None:
    """torch.__version__ if importable (guarded — torch is optional here)."""
    try:
        import torch  # noqa: PLC0415 - optional, import only when asked
        return str(torch.__version__)
    except Exception:  # noqa: BLE001
        return None


def runtime_metadata() -> dict:
    """The reproducibility stamp embedded in every result JSON."""
    return {
        "schema_version": SCHEMA_VERSION,
        "git_sha": git_sha(),
        "torch_version": torch_version(),
        # The Neoverse BF16 fast-math switch — the single biggest perf lever on
        # Arm, so a result is meaningless without recording which mode it ran in.
        "onednn_fpmath_mode": os.environ.get("ONEDNN_DEFAULT_FPMATH_MODE"),
    }


def requests_per_level(requested: int, levels: list[int]) -> int:
    """One sample size for EVERY level so their percentile populations match.

    The old code fired ``max(requested, concurrency)`` per level, so higher
    levels drew from bigger populations — p95s across levels weren't comparable.
    Fix: pick the sample size once (enough to fill the busiest level).
    """
    ceiling = max(levels) if levels else requested
    return max(requested, ceiling)


def mark_low_confidence(row: dict, threshold: int = LOW_CONFIDENCE_N) -> dict:
    """Flag a level whose successful-sample count is too small to trust p95/p99."""
    if row.get("ok", 0) < threshold:
        row["low_confidence"] = True
    return row


def cache_hits_total(rows) -> int:
    """How many samples across the whole run were served from the cache."""
    return sum(int(r.get("cache_hits") or 0) for r in rows)


def measurement_block(rows, cache_mode: str) -> dict:
    """What this run is a measurement OF — the claim the certificate rests on.

    ``measures_synthesis`` is the only honest basis for a capacity number: it
    is true when the run bypassed the cache AND no level recorded a hit.
    """
    hits = cache_hits_total(rows)
    ok = cache_mode != "allow" and hits == 0
    return {
        "cache_mode": cache_mode,
        "cache_hits_total": hits,
        "measures_synthesis": ok,
        "note": ("every request bypassed the synthesis cache; latency, "
                 "throughput and realtime factor describe the model"
                 if ok else
                 f"cache_mode={cache_mode}, {hits} response(s) served from "
                 f"cache — these numbers describe the cache in part, NOT the "
                 f"model, and cannot certify hardware capacity"),
    }


def build_result(rows, knee, recommended, *, route, fmt, corpus,
                 service_config, meta, cache_mode=DEFAULT_CACHE_MODE,
                 extra=None) -> dict:
    """Assemble the self-describing result document (schema v3).

    Everything needed to reproduce/compare a run travels WITH the numbers:
    schema version, git SHA, torch + fpmath mode, the server's own /health
    config, exactly what was sent (corpus/format/route), and — since v3 — what
    the run measured (``measurement``: cache mode + any cache hits). A v<=2
    file predates the cache-awareness fix and must not be read as a synthesis
    measurement.
    """
    result = {
        "schema_version": meta["schema_version"],
        "git_sha": meta["git_sha"],
        "torch_version": meta["torch_version"],
        "onednn_fpmath_mode": meta["onednn_fpmath_mode"],
        "route": route,
        "format": fmt,
        "corpus": corpus,
        "cache_mode": cache_mode,
        "measurement": measurement_block(rows, cache_mode),
        "service_config": service_config,
        "levels": rows,
        "knee": knee,
        "recommended_cap": recommended,
    }
    if extra:
        result.update(extra)
    return result


# ---------------------------------------------------------------------------
# Direction 1 — benchmark the topology we actually ship (service.replicas)
# ---------------------------------------------------------------------------
# Server-side counters worth reporting per level. Scope matters: see
# METRICS_SCOPE_* — the same key set is either a real pool total or one
# replica's sample, and the result JSON always says which.
TOPOLOGY_METRIC_KEYS = (
    "received", "completed", "rejected_429", "errored", "timeouts",
    "abandoned", "in_flight", "queued", "audio_seconds_total",
)

# What the per-level counter deltas describe (mirrors service.replicas scopes).
SCOPE_POOL_TOTAL = "pool_total"                  # every replica scraped + summed
SCOPE_SAMPLE = "single_replica_sample"           # SO_REUSEPORT: one unknown replica
SCOPE_SINGLE_PROCESS = "single_process"          # --url mode: the one server
SCOPE_UNKNOWN = "unknown"                        # scrape failed / no scope field

SCOPE_NOTES = {
    SCOPE_POOL_TOTAL: "counters summed across every replica (addressable ports)",
    SCOPE_SAMPLE: ("counters come from ONE arbitrary replica: under SO_REUSEPORT "
                   "the replicas share a port and cannot be told apart, so these "
                   "are NOT pool totals and must not be read as pool throughput"),
    SCOPE_SINGLE_PROCESS: "counters from the single server under test",
    SCOPE_UNKNOWN: "the metrics endpoint did not say what it was reporting",
}


def default_metrics_port(port: int) -> int:
    """Where ``service.replicas`` serves aggregated /metrics by default."""
    return port + 1000


def replicas_launch_command(replicas: int, port: int, metrics_port: int,
                            host: str = "127.0.0.1",
                            python: str | None = None) -> list[str]:
    """The exact ``python -m service.replicas`` argv the harness spawns.

    Reuses the real launcher's CLI so the benchmark drives the SAME process the
    sizing advisor recommends — no hand-rolled process scaling.
    """
    return [python or sys.executable, "-m", "service.replicas",
            "--replicas", str(replicas),
            "--port", str(port),
            "--metrics-port", str(metrics_port),
            "--host", host]


def metrics_delta(before: dict, after: dict) -> dict:
    """Per-counter (after - before) over two counter snapshots.

    ``before``/``after`` are the counter dicts scraped around one level (a pool
    total, a single-replica sample, or one server's own /metrics — the caller
    records WHICH). Non-numeric or missing counters are skipped so a partial
    scrape can't crash the run.
    """
    delta: dict = {}
    for k in TOPOLOGY_METRIC_KEYS:
        b, a = before.get(k), after.get(k)
        if (isinstance(a, (int, float)) and not isinstance(a, bool)
                and isinstance(b, (int, float)) and not isinstance(b, bool)):
            delta[k] = a - b
    return delta


def topology_block(mode: str, replicas: int, per_level: list,
                   metrics_scope: str = SCOPE_UNKNOWN) -> dict:
    """The result-JSON block describing WHAT topology produced these numbers.

    mode "single" = one in-process server (``--url``); mode "replicas" = the
    ``service.replicas`` launcher driving N single-worker processes.

    ``metrics_scope`` is the honesty flag on the per-level counter deltas. The
    shipped Linux topology (SO_REUSEPORT) cannot address individual replicas,
    so its deltas are a SAMPLE of one replica, never a pool total — this block
    says so instead of publishing an aggregate nobody can substantiate.
    """
    return {
        "mode": mode,
        "replicas": replicas,
        "metrics_scope": metrics_scope,
        "metrics_scope_note": SCOPE_NOTES.get(metrics_scope, ""),
        "metrics_per_level": per_level,
    }


async def _scrape_pool_metrics(metrics_url: str) -> dict:
    """Scrape the launcher's /metrics and return ``{"scope", "counters"}``.

    The launcher publishes ``totals`` ONLY when it could address every replica;
    under SO_REUSEPORT it publishes ``sample`` with ``totals: null`` because the
    replicas share a port. This helper carries that distinction into the result
    JSON instead of flattening both into "the pool numbers". Empty scope +
    empty counters if unreachable — a missing scrape must not abort the ramp.
    """
    try:
        async with httpx.AsyncClient() as c:
            r = await c.get(metrics_url, timeout=5)
            if r.status_code == 200:
                doc = r.json()
                scope = doc.get("scope") or SCOPE_UNKNOWN
                counters = doc.get("totals")
                if not counters:
                    counters = doc.get("sample") or {}
                return {"scope": scope, "counters": counters}
    except Exception:  # noqa: BLE001
        pass
    return {"scope": SCOPE_UNKNOWN, "counters": {}}


async def _scrape_server_metrics(metrics_url: str) -> dict:
    """Scrape a SINGLE server's GET /metrics and return its counter snapshot.

    The app serves ``{"config": ..., "metrics": {...}}``. Returned in the same
    ``{"scope", "counters"}`` envelope as the launcher scrape so both modes
    record what their counters describe — here one process, completely.
    Empty counters on any failure — a missing scrape must never abort the ramp.
    """
    try:
        async with httpx.AsyncClient() as c:
            r = await c.get(metrics_url, timeout=5)
            if r.status_code == 200:
                return {"scope": SCOPE_SINGLE_PROCESS,
                        "counters": r.json().get("metrics", {}) or {}}
    except Exception:  # noqa: BLE001
        pass
    return {"scope": SCOPE_UNKNOWN, "counters": {}}


async def _wait_launcher_ready(serving_url: str, proc, timeout: float = 180.0,
                               interval: float = 2.0) -> dict:
    """Poll /health until the launcher serves 200, returning its config.

    Raises RuntimeError with a clear message if the launcher process dies or
    never becomes ready — so a dead subprocess is loud, not a silent hang.
    """
    deadline = time.perf_counter() + timeout
    async with httpx.AsyncClient() as c:
        while time.perf_counter() < deadline:
            if proc.poll() is not None:
                raise RuntimeError(
                    f"launcher exited before becoming ready (code {proc.returncode})")
            try:
                r = await c.get(f"{serving_url}/health", timeout=5)
                if r.status_code == 200:
                    return r.json().get("config", {})
            except Exception:  # noqa: BLE001 - not up yet, keep polling
                pass
            await asyncio.sleep(interval)
    raise RuntimeError(f"launcher at {serving_url} not ready within {timeout:.0f}s")


def _stop_launcher(proc, grace_s: float = 10.0) -> None:
    """Terminate the launcher cleanly (SIGTERM/terminate), SIGKILL if stubborn."""
    if proc is None or proc.poll() is not None:
        return
    try:
        proc.terminate()
    except Exception:  # noqa: BLE001
        pass
    try:
        proc.wait(timeout=grace_s)
    except Exception:  # noqa: BLE001 - timed out; escalate
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass


def _safe_float(v, default: float) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


async def _one(client, url, voice, text, fmt, results, headers=None):
    t0 = time.perf_counter()
    try:
        r = await client.post(
            f"{url}/v1/text-to-speech/{voice}",
            params={"output_format": fmt},
            json={"text": text, "model_id": "pocket_tts"},
            headers=headers or {},
            timeout=300,
        )
        dt = time.perf_counter() - t0
        bucket = classify_response(r.status_code)
        if bucket == "ok":
            results["lat"].append(dt)
            # X-Cache: hit means the server replayed stored audio — that sample
            # measured an LRU lookup, not the model. Count it so the level (and
            # the certificate) can say so instead of averaging it in silently.
            if (r.headers.get("X-Cache") or "").lower() == "hit":
                results["cache_hits"] = results.get("cache_hits", 0) + 1
            # Parse the timing headers defensively: a malformed X-Realtime-Factor
            # / X-Audio-Seconds must NOT raise here — that would drop this
            # already-successful request into the `except` below, recording its
            # latency AND re-counting it as an error, which falsely trips level
            # degradation and corrupts the computed knee / deployment cap.
            results["rtf"].append(_safe_float(r.headers.get("X-Realtime-Factor"), float("nan")))
            results["audio"].append(_safe_float(r.headers.get("X-Audio-Seconds"), 0.0))
        elif bucket == "rejected":
            results["rejected"] += 1
        elif bucket == "timeout":
            results["timeouts"] += 1
        else:
            results["errors"] += 1
    except Exception:  # noqa: BLE001
        results["errors"] += 1


# ---------------------------------------------------------------------------
# Direction 2 — streaming TTFB (time-to-first-chunk on the /stream route)
# ---------------------------------------------------------------------------
async def _measure_stream_timing(aiter, t0, clock=time.perf_counter):
    """Consume a streaming body, returning ``(ttfb, total)``.

    ``ttfb`` is the time from ``t0`` to the FIRST non-empty chunk — the headline
    "first audio in Nms" number — or ``None`` if the stream produced no bytes.
    ``total`` is the time to drain the whole stream. Pure over any async byte
    iterator, so the first-chunk timing is unit-testable without a live server.
    """
    ttfb = None
    async for chunk in aiter:
        if chunk and ttfb is None:
            ttfb = clock() - t0
    return ttfb, clock() - t0


async def _one_stream(client, url, voice, text, fmt, results, headers=None):
    t0 = time.perf_counter()
    try:
        async with client.stream(
            "POST", f"{url}/v1/text-to-speech/{voice}/stream",
            params={"output_format": fmt},
            json={"text": text, "model_id": "pocket_tts"},
            headers=headers or {},
            timeout=300,
        ) as r:
            if r.status_code == 200:
                ttfb, total = await _measure_stream_timing(r.aiter_bytes(), t0)
                results["lat"].append(total)
                if ttfb is not None:
                    results["ttfb"].append(ttfb)
            elif r.status_code == 429:
                results["rejected"] += 1
            elif r.status_code == 504:
                results["timeouts"] += 1
            elif r.status_code == 501:
                # The stream route 501s mp3 (transcoding needs the whole clip).
                results["unsupported"] += 1
            else:
                results["errors"] += 1
    except Exception:  # noqa: BLE001
        results["errors"] += 1


async def _sample_resources(stop_evt, samples, server_pid=None):
    if psutil is None:
        return
    psutil.cpu_percent(None)  # prime host (non-blocking mode)
    # The driver = this load-generator process; sample it apart from the server
    # so a co-located run doesn't credit the generator's CPU to the server.
    driver_proc = None
    server_proc = None
    if server_pid is not None:
        try:
            driver_proc = psutil.Process()
            driver_proc.cpu_percent(None)  # prime
        except Exception:  # noqa: BLE001
            driver_proc = None
        try:
            server_proc = psutil.Process(server_pid)
            _prime_tree(server_proc)
        except Exception:  # noqa: BLE001 - server pid not found; host-only
            server_proc = None
    while not stop_evt.is_set():
        # MUST await, not block: psutil.cpu_percent(interval=...) blocks the
        # event loop and would starve the request tasks. Use non-blocking
        # sampling (delta since last call) + asyncio.sleep to yield.
        await asyncio.sleep(0.5)
        samples["cpu"].append(psutil.cpu_percent(None))
        samples["mem"].append(psutil.virtual_memory().percent)
        if driver_proc is not None:
            try:
                samples["driver"].append(driver_proc.cpu_percent(None))
            except Exception:  # noqa: BLE001
                pass
        if server_proc is not None:
            tree = _proc_tree_cpu(server_proc)
            if tree is not None:
                samples["server"].append(tree)


async def run_level(url, voice, text, fmt, concurrency, n_requests, route="synth",
                    server_pid=None, cache_mode=DEFAULT_CACHE_MODE):
    results = {"lat": [], "ttfb": [], "rtf": [], "audio": [],
               "rejected": 0, "errors": 0, "timeouts": 0, "unsupported": 0,
               "cache_hits": 0}
    headers = request_headers(cache_mode)
    samples = {"cpu": [], "mem": [], "server": [], "driver": []}
    stop_evt = asyncio.Event()
    sampler = asyncio.create_task(_sample_resources(stop_evt, samples, server_pid))

    # In stream mode we time to first CHUNK; in synth mode we time full responses.
    one = _one_stream if route == "stream" else _one
    sem = asyncio.Semaphore(concurrency)
    limits = httpx.Limits(max_connections=concurrency + 4, max_keepalive_connections=concurrency + 4)
    wall0 = time.perf_counter()
    async with httpx.AsyncClient(limits=limits) as client:
        async def bounded():
            async with sem:
                await one(client, url, voice, text, fmt, results, headers)
        await asyncio.gather(*[bounded() for _ in range(n_requests)])
    wall = time.perf_counter() - wall0

    stop_evt.set()
    await sampler

    ok = len(results["lat"])
    audio_total = sum(results["audio"])
    rtfs = [x for x in results["rtf"] if x == x]  # drop nan
    row = {
        "concurrency": concurrency,
        "requests": n_requests,
        "ok": ok,
        "rejected_429": results["rejected"],
        "timeouts": results["timeouts"],
        "errors": results["errors"],
        "wall_s": round(wall, 2),
        "throughput_req_s": round(ok / wall, 3) if wall else None,
        "audio_s_per_wall_s": round(audio_total / wall, 3) if wall else None,
        "lat_p50_s": pct(results["lat"], 50),
        "lat_p95_s": pct(results["lat"], 95),
        "lat_p99_s": pct(results["lat"], 99),
        "server_rtf_mean": round(statistics.mean(rtfs), 3) if rtfs else None,
        # CPU/RAM (host + the honest server/driver split) — see cpu_row().
        **cpu_row(samples),
        # What this level actually measured. cache_hits > 0 means some samples
        # were LRU lookups, so the level's latency/throughput/rtf describe the
        # cache in part — never silently, always in the JSON.
        "cache_mode": cache_mode,
        "cache_hits": results.get("cache_hits", 0),
        "measures_synthesis": results.get("cache_hits", 0) == 0,
    }
    if route == "stream":
        # lat_* above ARE the total-response percentiles; add first-chunk (TTFB)
        # percentiles — the "first audio in Nms" headline — and the 501 tally.
        row["ttfb_p50_s"] = pct(results["ttfb"], 50)
        row["ttfb_p95_s"] = pct(results["ttfb"], 95)
        row["ttfb_p99_s"] = pct(results["ttfb"], 99)
        row["unsupported_501"] = results["unsupported"]
    return row


# ---------------------------------------------------------------------------
# Open-loop driver: arrivals on wall-clock offsets, in-flight count ignored
# ---------------------------------------------------------------------------
async def _sample_queue_depth(stop_evt, depths, scrape, interval: float = 1.0):
    """Poll the server's ``queued`` counter while a level runs.

    Queue DEPTH over time is the open-loop signal the closed-loop ramp could
    never see: when arrivals stop waiting for completions, work piles up here
    first and latency follows. A failed scrape is skipped, never fatal.
    """
    if scrape is None:
        return
    while not stop_evt.is_set():
        await asyncio.sleep(interval)
        try:
            snap = await scrape()
        except Exception:  # noqa: BLE001 - metrics port flaked; keep loading
            continue
        q = (snap.get("counters") or {}).get("queued")
        if isinstance(q, (int, float)) and not isinstance(q, bool):
            depths.append(float(q))


async def run_open_loop(args, rate_rps, duration_s, *, scrape=None, seed=0,
                        soak=False):
    """Fire a Poisson arrival stream at ``rate_rps`` for ``duration_s``.

    The defining difference from ``run_level``: there is NO admission
    semaphore. Each arrival fires at its scheduled wall-clock offset whatever
    is still in flight, so a slowing server produces a growing backlog instead
    of a politely reduced load. ``--max-in-flight`` is the only brake, and it
    is a refusal (counted), not a wait.

    Returns the level row, or ``None`` if the corpus could not supply a
    distinct body per request (refused loudly rather than repeating one).
    """
    offsets = arrival_schedule(rate_rps, duration_s, seed)
    profile = getattr(args, "corpus_profile", DEFAULT_PROFILE)
    try:
        texts = corpus_series(profile, len(offsets), seed=seed)
    except ValueError as exc:
        print(f"!! {exc}")
        print(f"   corpus profile {profile!r} holds {corpus_capacity(profile)} "
              f"distinct bodies; use --corpus-profile mixed/long, a lower "
              f"--rate, or a shorter --duration")
        return None

    route = getattr(args, "route", "synth")
    cache_mode = getattr(args, "cache_mode", DEFAULT_CACHE_MODE)
    server_pid = getattr(args, "server_pid", None)
    max_in_flight = getattr(args, "max_in_flight", DEFAULT_MAX_IN_FLIGHT)
    results = {"lat": [], "ttfb": [], "rtf": [], "audio": [],
               "rejected": 0, "errors": 0, "timeouts": 0, "unsupported": 0,
               "cache_hits": 0}
    headers = request_headers(cache_mode)
    samples = {"cpu": [], "mem": [], "server": [], "driver": []}
    depths: list = []
    stop_evt = asyncio.Event()
    sampler = asyncio.create_task(_sample_resources(stop_evt, samples, server_pid))
    depth_task = asyncio.create_task(_sample_queue_depth(stop_evt, depths, scrape))

    one = _one_stream if route == "stream" else _one
    gate = AdmissionGate(max_in_flight)
    pool = max(8, (max_in_flight if max_in_flight > 0 else 256) + 8)
    limits = httpx.Limits(max_connections=pool, max_keepalive_connections=pool)
    tasks: list = []
    wall0 = time.perf_counter()
    async with httpx.AsyncClient(limits=limits) as client:
        for offset, text in zip(offsets, texts):
            due = wall0 + offset - time.perf_counter()
            if due > 0:
                await asyncio.sleep(due)
            if not gate.try_acquire():
                continue          # breaker refused it; gate counted the refusal

            async def fire(body=text):
                try:
                    await one(client, args.url, args.voice, body, args.format,
                              results, headers)
                finally:
                    gate.release()

            tasks.append(asyncio.create_task(fire()))
        if tasks:
            await asyncio.gather(*tasks)
    wall = time.perf_counter() - wall0

    stop_evt.set()
    await sampler
    await depth_task

    return open_loop_row(
        offered_rate=rate_rps, duration_s=duration_s, scheduled=len(offsets),
        refused=gate.refused, results=results, wall_s=wall, samples=samples,
        queue_depths=depths, slo_p95=getattr(args, "slo_p95", None),
        slo_violations_max=getattr(args, "slo_violations_max",
                                   DEFAULT_SLO_VIOLATIONS_MAX),
        peak_in_flight=gate.peak_in_flight, route=route,
        cache_mode=cache_mode, soak=soak)


def _print_open_loop_row(row) -> None:
    print(f"{row['offered_rate_rps']:>6} {row['ok']:>5} {row['rejected_429']:>4} "
          f"{row['timeouts']:>4} {row['errors']:>4} {row['refused_in_flight']:>5} "
          f"{str(row['lat_p50_s']):>7} {str(row['lat_p95_s']):>7} "
          f"{str(row['goodput_req_s']):>7} {str(row['slo_violation_rate']):>6} "
          f"{str(row['queue_wait_p95_s']):>7} {str(row['peak_in_flight']):>5} "
          f"{str(row['cpu_mean_pct']):>5}")
    if row["refused_in_flight"]:
        print(f"     ^ CIRCUIT BREAKER: {row['refused_in_flight']} arrival(s) "
              f"refused by the driver at --max-in-flight; the box did NOT "
              f"sustain this rate (the level counts as degraded)")
    if row.get("driver_saturated"):
        print(f"     ^ driver SATURATED ({row['driver_cpu_max_pct']}% of one "
              f"core): run the load generator off-box before believing this row")
    if row.get("achieved_rate_rps") and row["achieved_rate_rps"] < 0.9 * row["offered_rate_rps"]:
        print(f"     ^ driver behind schedule: offered {row['offered_rate_rps']} "
              f"req/s but only placed {row['achieved_rate_rps']} req/s on the "
              f"wire — this row understates the server")
    if row.get("cache_hits"):
        print(f"     ^ CACHE CONTAMINATED: {row['cache_hits']} cached "
              f"response(s) despite a distinct body per request")


async def run_rate_ramp(args, rates, *, scrape=None):
    """Ramp offered RATE (not concurrency) and find the SLO knee.

    Returns ``(rows, slo, workload)`` where ``slo`` is the capacity promise the
    run substantiates — including the soak verdict, because a rate that holds
    for 60 seconds and collapses over 10 minutes is not a capacity claim.
    """
    print("\n" + IDLE_BOX_WARNING)
    if args.slo_p95 is None:
        print("NOTE: no --slo-p95 declared; rates are measured but no capacity "
              "contract can be issued from this run.")
    hdr = (f"{'rate':>6} {'ok':>5} {'429':>4} {'to':>4} {'err':>4} {'refus':>5} "
           f"{'p50_s':>7} {'p95_s':>7} {'good/s':>7} {'viol':>6} {'qwait':>7} "
           f"{'peak':>5} {'cpu%':>5}")
    print("\n" + hdr)
    print("-" * len(hdr))

    rows = []
    for i, rate in enumerate(rates):
        row = await run_open_loop(args, rate, args.duration, scrape=scrape,
                                  seed=args.seed + i)
        if row is None:
            break
        rows.append(row)
        _print_open_loop_row(row)

    max_rate, first_fail = slo_knee(rows, args.slo_p95, args.slo_violations_max)
    soak_ok = None
    soak_minutes = 0
    if max_rate and args.soak > 0:
        soak_minutes = args.soak
        print(f"\nsoaking {soak_minutes} minute(s) at {max_rate} req/s — "
              f"thermal throttling, memory growth and burstable-credit "
              f"exhaustion only show up over time")
        soak_row = await run_open_loop(args, max_rate, soak_minutes * 60.0,
                                       scrape=scrape, seed=args.seed + 999,
                                       soak=True)
        if soak_row is not None:
            rows.append(soak_row)
            _print_open_loop_row(soak_row)
            soak_ok = not level_degraded(
                soak_row, None, 0.0, 100.0, slo_p95=args.slo_p95,
                slo_violations_max=args.slo_violations_max)
            print(f"soak {'HELD' if soak_ok else 'FAILED'}")

    slo = slo_block(slo_p95=args.slo_p95,
                    violations_max=args.slo_violations_max,
                    max_rate=max_rate, first_fail=first_fail,
                    soak_minutes=soak_minutes, soak_ok=soak_ok,
                    think_time_s=args.think_time)
    workload = workload_block(rates=rates, duration_s=args.duration,
                              seed=args.seed, profile=args.corpus_profile,
                              max_in_flight=args.max_in_flight, rows=rows,
                              think_time_s=args.think_time)
    print("\n" + "=" * 60)
    if args.slo_p95 is None:
        print("No SLO declared — no capacity contract issued.")
    elif slo["max_rate_rps"]:
        print(f"CAPACITY CONTRACT: {slo['max_rate_rps']} req/s at p95 <= "
              f"{args.slo_p95}s "
              f"(~{slo['concurrent_users']} concurrent listeners at a "
              f"{args.think_time}s think time)")
        print(f"  {slo['note']}")
    else:
        print(f"NO SUSTAINABLE RATE FOUND: {slo['note']}")
    if first_fail:
        print(f"  first rate to miss the SLO: {first_fail} req/s")
    print("=" * 60)
    return rows, slo, workload


async def warmup(url, voice, text, fmt, n, cache_mode=DEFAULT_CACHE_MODE):
    """Fire N synth requests before the ramp so level 1 doesn't eat cold-start.

    These requests are thrown away — never recorded in any level's stats — so a
    standalone run's baseline reflects warm steady-state, not a first-token cold
    model load. Returns the count of successful warmups (for reporting only).
    """
    if n <= 0:
        return 0
    results = {"lat": [], "rtf": [], "audio": [], "rejected": 0, "errors": 0,
               "timeouts": 0, "cache_hits": 0}
    headers = request_headers(cache_mode)
    async with httpx.AsyncClient() as client:
        for _ in range(n):
            await _one(client, url, voice, text, fmt, results, headers)
    return len(results["lat"])


def print_plan(result: dict) -> None:
    """Sizing advisor: translate measured knee data into the exact deployment
    env vars (mirrors the /benchmarks capacity planner in the web studio).

    Grounded in the benchmark finding that throughput scales by
    process/replica, not in-process workers (the model is GIL-bound): the
    safe cap becomes the number of single-worker processes to run.
    """
    rows = result.get("levels") or []
    if not rows:
        print("no levels in result -- run the load test first")
        return
    slo = result.get("slo")
    if slo:
        # An open-loop run answers a different question than the ramp, so it
        # leads with the promise rather than with the process count.
        print("\n" + "-" * 60)
        print("Capacity contract (from measured open-loop arrivals)")
        print("-" * 60)
        if slo.get("max_rate_rps"):
            print(f"Sustains {slo['max_rate_rps']} req/s at p95 <= {slo['p95_s']}s"
                  f"  ~= {slo['concurrent_users']} concurrent listeners")
            print(f"  basis: {slo['concurrent_users_basis']}")
            if slo.get("soak_minutes"):
                print(f"  held for {slo['soak_minutes']} minute(s) of soak")
            else:
                print("  NOT soak-tested: re-run with --soak before promising "
                      "this rate over hours")
        else:
            print(f"No sustainable rate: {slo.get('note')}")
        wl = result.get("workload") or {}
        if wl.get("breaker_tripped"):
            print(f"  circuit breaker refused {wl['refused_in_flight_total']} "
                  f"arrival(s) at --max-in-flight={wl.get('max_in_flight')}")
        print(f"  {(wl.get('idle_box_warning') or IDLE_BOX_WARNING)}")
    knee = result.get("knee")
    cap = result.get("recommended_cap")
    if not cap:
        # No safe cap exists — the baseline level itself degraded. Falling back
        # to rows[-1] (the old behaviour) would advise the operator to run the
        # HIGHEST, most degraded concurrency measured: the exact opposite of
        # safe, in the one scenario this tool exists to catch. Fail closed to
        # the smallest measured level and say so out loud.
        cap = rows[0]["concurrency"]
        print("WARNING: no healthy level found -- the baseline concurrency already "
              "degraded. Sizing from the SMALLEST measured level; treat the numbers "
              "below as a floor, not a validated cap, and re-run on an idle box.")
    at_cap = next((r for r in rows if r["concurrency"] == cap), rows[0])
    cores = os.cpu_count() or cap
    threads = max(1, cores // cap)
    queue_max = max(8, 4 * cap)

    print("\n" + "-" * 60)
    print("Deployment plan (from measured knee)")
    print("-" * 60)
    if knee:
        print(f"Safe concurrency cap: {cap}  (degradation first at {knee})")
    else:
        print(f"Safe concurrency cap: >= {cap}  (no degradation seen -- true cap is higher)")
    if at_cap.get("audio_s_per_wall_s"):
        aud = at_cap["audio_s_per_wall_s"]
        print(f"Throughput at cap: {aud} audio-s/s ~= {round(aud * 60)} audio-min/hour")
    print(f"\nRun {cap} single-worker processes behind a load balancer:")
    print(f"  TTS_WORKERS=1")
    print(f"  TTS_TORCH_THREADS={threads}        # {cores} cores / {cap} processes")
    print(f"  TTS_QUEUE_MAX={queue_max}          # ~4x cap of waiting requests")

    # Print the EXACT launcher command — matching what was actually measured
    # when the result came from --replicas mode, so the advice is grounded.
    topo = result.get("topology") or {}
    port = (result.get("args") or {}).get("port", 8000)
    print("\nThe measured launcher runs exactly this topology:")
    print(f"  python -m service.replicas --replicas {cap} --port {port}")
    if topo.get("mode") == "replicas":
        print(f"  (validated: this benchmark drove service.replicas at "
              f"{topo.get('replicas')} replica(s) — see topology.metrics_per_level, "
              f"scope={topo.get('metrics_scope')})")
    else:
        print("  (single-server run: re-run with --replicas to measure this launcher directly)")
    print("\nScale by adding processes/replicas, not in-process workers (GIL-bound).")
    print("Full calculator + $/audio-hour comparison: the studio's /benchmarks page.")
    print("-" * 60)


async def run_ramp(args, levels, n_per_level, *, scrape=None):
    """Ramp through ``levels``, print the live table, and return
    ``(rows, knee, recommended, per_level_metrics, metrics_scope)``.

    If ``scrape`` (an async ``() -> {"scope", "counters"}``) is supplied, the
    server-side counters are captured before/after each level and their delta
    recorded — that's how timeouts/abandoned/queue land in the JSON. The scope
    the endpoint reported travels with every delta, because under SO_REUSEPORT
    those counters are ONE replica's sample, not a pool total.
    """
    rows = []
    per_level_metrics: list = []
    metrics_scope = SCOPE_UNKNOWN
    baseline_p95 = None
    knee = None
    route = getattr(args, "route", "synth")
    server_pid = getattr(args, "server_pid", None)
    cache_mode = getattr(args, "cache_mode", DEFAULT_CACHE_MODE)

    if route == "stream":
        # Stream mode leads with TTFB (first-chunk latency), the headline number;
        # the /stream route emits no timing headers so srtf/aud/s are dropped.
        # 'to' = 504 timeouts (distinct from 'err').
        hdr = (f"{'conc':>4} {'ok':>4} {'429':>4} {'to':>4} {'err':>4} {'501':>4} "
               f"{'tfb50':>7} {'tfb95':>7} {'tot50':>7} {'tot95':>7} "
               f"{'thr/s':>6} {'cpu%':>5} {'mem%':>5}")
    else:
        # 'to' = 504 timeouts (distinct from 'err').
        hdr = (f"{'conc':>4} {'ok':>4} {'429':>4} {'to':>4} {'err':>4} "
               f"{'p50_s':>7} {'p95_s':>7} "
               f"{'thr/s':>6} {'aud/s':>6} {'srtf':>5} {'cpu%':>5} {'mem%':>5}")
    print("\n" + hdr)
    print("-" * len(hdr))

    for c in levels:
        before = await scrape() if scrape is not None else None
        row = await run_level(args.url, args.voice, args.text, args.format, c,
                              n_per_level, route=route, server_pid=server_pid,
                              cache_mode=cache_mode)
        after = await scrape() if scrape is not None else None
        mark_low_confidence(row)
        rows.append(row)
        if route == "stream":
            print(f"{row['concurrency']:>4} {row['ok']:>4} {row['rejected_429']:>4} "
                  f"{row['timeouts']:>4} {row['errors']:>4} {row['unsupported_501']:>4} "
                  f"{str(row['ttfb_p50_s']):>7} {str(row['ttfb_p95_s']):>7} "
                  f"{str(row['lat_p50_s']):>7} {str(row['lat_p95_s']):>7} "
                  f"{str(row['throughput_req_s']):>6} {str(row['cpu_mean_pct']):>5} "
                  f"{str(row['mem_max_pct']):>5}")
            if row["unsupported_501"]:
                print(f"     ^ {row['unsupported_501']} request(s) got 501: mp3 is not "
                      f"streamable — use pcm_24000/wav_24000 for --route stream")
        else:
            print(f"{row['concurrency']:>4} {row['ok']:>4} {row['rejected_429']:>4} "
                  f"{row['timeouts']:>4} {row['errors']:>4} "
                  f"{str(row['lat_p50_s']):>7} {str(row['lat_p95_s']):>7} "
                  f"{str(row['throughput_req_s']):>6} {str(row['audio_s_per_wall_s']):>6} "
                  f"{str(row['server_rtf_mean']):>5} {str(row['cpu_mean_pct']):>5} "
                  f"{str(row['mem_max_pct']):>5}")
        if row["timeouts"]:
            print(f"     ^ {row['timeouts']} request(s) timed out (504): the server "
                  f"exceeded its request timeout — treated as degradation at conc={c}")
        if server_pid is not None and row.get("server_cpu_mean_pct") is not None:
            print(f"     cpu split: server={row['server_cpu_mean_pct']}% "
                  f"driver={row['driver_cpu_mean_pct']}% host={row['host_cpu_mean_pct']}% "
                  f"(mean; 'cpu%' column above is whole-host)")
        if row.get("driver_saturated"):
            print(f"     ^ driver SATURATED: load-generator CPU peaked at "
                  f"{row['driver_cpu_max_pct']}% (>= {DRIVER_SATURATION_PCT}% of one "
                  f"core) — the driver may be the bottleneck at conc={c}; reduce "
                  f"concurrency or run the load generator off-box")
        if row.get("cache_hits"):
            print(f"     ^ CACHE CONTAMINATED: {row['cache_hits']} of {row['ok']} "
                  f"response(s) came from the server's synthesis cache (X-Cache: "
                  f"hit), so this level did NOT measure the model. Run with "
                  f"--cache-mode bypass (the default) against a build that "
                  f"honours Cache-Control: no-store.")
        if row.get("low_confidence"):
            print(f"     ^ low confidence: only {row['ok']} sample(s) < {LOW_CONFIDENCE_N}; "
                  f"treat p95/p99 as indicative, not exact")
        if scrape is not None:
            before, after = before or {}, after or {}
            scope = after.get("scope") or before.get("scope") or SCOPE_UNKNOWN
            if scope != SCOPE_UNKNOWN:
                metrics_scope = scope
            delta = metrics_delta(before.get("counters") or {},
                                  after.get("counters") or {})
            per_level_metrics.append({"concurrency": c, "scope": scope,
                                      "counter_delta": delta})
            if delta:
                label = "sampled replica Δ" if scope == SCOPE_SAMPLE else "server Δ"
                print(f"     {label}: "
                      + " ".join(f"{k}={v}" for k, v in delta.items() if v))

        if c == levels[0]:
            baseline_p95 = row["lat_p95_s"] or 0.0
        if level_degraded(row, baseline_p95, args.degrade_factor,
                          args.cpu_ceiling) and knee is None:
            knee = c

    recommended = None
    for c in levels:
        if knee is None or c < knee:
            recommended = c
    print("\n" + "=" * 60)
    if knee:
        print(f"Degradation first seen at concurrency = {knee}")
        print(f"Recommended safe cap (last healthy level) = {recommended}")
    else:
        print(f"No degradation across tested levels (up to {levels[-1]}). "
              f"Push higher with --levels to find the ceiling.")
    if metrics_scope == SCOPE_SAMPLE:
        print("NOTE: server-side counters above are a SAMPLE of one replica "
              "(SO_REUSEPORT shares one port); they are not pool totals.")
    print("=" * 60)
    return rows, knee, recommended, per_level_metrics, metrics_scope


async def _run_configured(args, levels, n_per_level, scrape):
    """Drive the configured arrival mode.

    Returns ``(rows, knee, recommended, per_level_metrics, metrics_scope,
    extra)`` so both server modes (single ``--url`` and ``--replicas``) share
    one branch point instead of each growing its own copy of it.
    """
    if getattr(args, "arrival", DEFAULT_ARRIVAL) != "poisson":
        rows, knee, rec, per_level, scope = await run_ramp(
            args, levels, n_per_level, scrape=scrape)
        return rows, knee, rec, per_level, scope, {}

    scope = SCOPE_UNKNOWN
    if scrape is not None:
        scope = (await scrape()).get("scope") or SCOPE_UNKNOWN
    rows, slo, workload = await run_rate_ramp(args, parse_rates(args.rate),
                                              scrape=scrape)
    cap = open_loop_recommended_cap(rows, slo)
    # knee stays None: the open-loop knee is a RATE (slo.first_failing_rate_rps),
    # not a concurrency level, and putting it in the concurrency field would
    # make the sizing advisor print a rate as if it were a stream count.
    return rows, None, cap, [], scope, {"slo": slo, "workload": workload}


def _write_result(args, result) -> None:
    result["args"] = vars(args)
    with open(args.out, "w") as f:
        json.dump(result, f, indent=2)
    print(f"wrote {args.out}")
    m = result.get("measurement") or {}
    if not m.get("measures_synthesis", False):
        print(f"!! this run is NOT a synthesis measurement: {m.get('note')}")
        print("   `python -m service.certify` will refuse it.")
    print_plan(result)


async def run_replicas_mode(args, levels, n_per_level) -> None:
    """Direction 1: benchmark the topology we actually ship.

    Starts the REAL launcher (``python -m service.replicas``), waits for
    readiness on the serving port, ramps against it while scraping the
    aggregated metrics side port per level, then stops the launcher cleanly.
    Any launcher failure is surfaced loudly rather than hanging.
    """
    metrics_port = args.metrics_port or default_metrics_port(args.port)
    cmd = replicas_launch_command(args.replicas, args.port, metrics_port,
                                  host=args.launcher_host)
    serving_url = f"http://127.0.0.1:{args.port}"
    metrics_url = f"http://127.0.0.1:{metrics_port}/metrics"
    print("launching shipped topology:", " ".join(cmd))
    proc = subprocess.Popen(cmd)
    try:
        try:
            service_config = await _wait_launcher_ready(serving_url, proc)
        except RuntimeError as exc:
            print(f"!! {exc}")
            return
        print(f"launcher ready on {serving_url} "
              f"({args.replicas} replicas); launcher metrics on {metrics_url} "
              f"(the launcher states their scope — pool total vs one-replica sample)")
        if not sys.platform.startswith("linux") and args.replicas > 1:
            # Without SO_REUSEPORT the launcher falls back to sequential ports
            # and this ramp only ever hits the first replica — the other N-1
            # sit idle. Numbers from such a run measure ONE replica, not N.
            print(f"!! non-Linux box: replicas serve sequential ports and this "
                  f"ramp targets only port {args.port} (replica 0 of "
                  f"{args.replicas}). Treat throughput as single-replica; the "
                  f"real N-replica measurement needs the Arm Linux target.")

        # The ramp + warmup target the launcher we just started, not --url.
        args.url = serving_url
        # We spawned the launcher, so we know its PID: sample the launcher's
        # process tree (all replica workers) as the "server" CPU, apart from this
        # driver — unless the caller pinned a PID explicitly.
        if getattr(args, "server_pid", None) is None:
            args.server_pid = proc.pid
        if args.warmup > 0:
            print(f"warming up: {args.warmup} discarded synth request(s) ...")
            warmed = await warmup(args.url, args.voice, args.text, args.format,
                                  args.warmup, cache_mode=args.cache_mode)
            print(f"warmup complete ({warmed}/{args.warmup} ok)")

        async def scrape():
            return await _scrape_pool_metrics(metrics_url)

        (rows, knee, recommended, per_level, metrics_scope,
         extra) = await _run_configured(args, levels, n_per_level, scrape)
        if proc.poll() is not None:
            print(f"!! launcher died during the ramp (code {proc.returncode}); "
                  f"results below may be partial")

        result = build_result(
            rows, knee, recommended,
            route=args.route, fmt=args.format, corpus=corpus_description(args),
            service_config=service_config, meta=runtime_metadata(),
            cache_mode=args.cache_mode,
            extra={"topology": topology_block("replicas", args.replicas,
                                              per_level, metrics_scope),
                   "cpu_accounting": cpu_accounting_note(args.server_pid),
                   **extra})
        _write_result(args, result)
    finally:
        _stop_launcher(proc)
        print("launcher stopped")


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8080")
    ap.add_argument("--voice", default="step4")
    ap.add_argument("--text", default=TEXT_DEFAULT)
    ap.add_argument("--format", default="wav_24000")
    ap.add_argument("--route", choices=("synth", "stream"), default="synth",
                    help="synth = full-response latency (default); stream = the "
                         "/stream route, measuring time-to-first-chunk (TTFB)")
    ap.add_argument("--levels", default="1,2,3,4,6,8",
                    help="comma-separated concurrency levels to ramp through")
    ap.add_argument("--requests", type=int, default=12,
                    help="requests fired per level")
    ap.add_argument("--warmup", type=int, default=2,
                    help="synth requests fired (and discarded) before level 1 to warm the model")
    ap.add_argument("--replicas", type=int, default=None,
                    help="benchmark the shipped topology: start `python -m service.replicas` "
                         "with N single-worker replicas and ramp against it")
    ap.add_argument("--port", type=int, default=8080,
                    help="client-facing port the launcher serves on (--replicas mode)")
    ap.add_argument("--metrics-port", type=int, default=None,
                    help="launcher's aggregated-metrics port (default: --port + 1000)")
    ap.add_argument("--launcher-host", default="127.0.0.1",
                    help="host the launcher binds (--replicas mode)")
    ap.add_argument("--server-pid", type=int, default=None,
                    help="PID of the server process you launched. Its process "
                         "tree CPU is sampled as server_cpu_* (apart from this "
                         "driver's driver_cpu_*), so a co-located run doesn't "
                         "credit the load generator to the server. Auto-detected "
                         "in --replicas mode. Without it, only host CPU is reported.")
    ap.add_argument("--cache-mode", choices=CACHE_MODES, default=DEFAULT_CACHE_MODE,
                    help="bypass (default): every request carries "
                         "Cache-Control: no-store so the MODEL renders it — the "
                         "only mode that measures synthesis. allow: let the "
                         "server's synthesis cache serve repeats; use it to "
                         "characterise the cache, never to certify hardware.")
    # ---- open-loop capacity contract -------------------------------------
    ap.add_argument("--arrival", choices=ARRIVAL_MODES, default=DEFAULT_ARRIVAL,
                    help="closed (default): the concurrency ramp — N requests "
                         "behind a semaphore, so load backs off when the server "
                         "slows. poisson: OPEN LOOP — requests fire on "
                         "wall-clock arrival times whatever is in flight, which "
                         "is how real traffic behaves and the only way queueing "
                         "shows up. !! An open-loop run does not self-throttle: "
                         "run it on an IDLE box, ideally with the load "
                         "generator off-box, and leave --max-in-flight set.")
    ap.add_argument("--rate", default="1,2,4",
                    help="offered arrival rate(s) in req/s for --arrival "
                         "poisson; comma-separated to ramp (e.g. 2,4,6,8). The "
                         "reported capacity is the highest rate that met the SLO.")
    ap.add_argument("--duration", type=float, default=60.0,
                    help="seconds of arrivals per rate (--arrival poisson)")
    ap.add_argument("--seed", type=int, default=0,
                    help="seed for the arrival process and corpus — the same "
                         "seed replays the exact same run")
    ap.add_argument("--corpus-profile", choices=PROFILES, default=DEFAULT_PROFILE,
                    help="script-length mix for open-loop requests: short / "
                         "typical / long / mixed. Every request gets its OWN "
                         "generated body, so the synthesis cache is defeated by "
                         "construction rather than by asking the server.")
    ap.add_argument("--max-in-flight", type=int, default=DEFAULT_MAX_IN_FLIGHT,
                    help="HARD circuit breaker: arrivals past this many in "
                         "flight are refused by the driver (counted as "
                         "refused_in_flight and treated as degradation) instead "
                         "of piling onto an overloaded box. 0 disables it — "
                         "never do that on a box you care about.")
    ap.add_argument("--slo-p95", type=float, default=None,
                    help="latency SLO in seconds. With it, the knee becomes the "
                         "highest offered rate whose p95 stays inside this "
                         "target; without it the ramp's relative rules apply.")
    ap.add_argument("--slo-violations-max", type=float,
                    default=DEFAULT_SLO_VIOLATIONS_MAX,
                    help="fraction of requests allowed to exceed --slo-p95 "
                         "(0.01 = 1%%)")
    ap.add_argument("--soak", type=float, default=0.0,
                    help="minutes to hold the found rate, to catch thermal "
                         "throttling, memory growth and burstable-credit "
                         "exhaustion. A rate that survives 60s and dies over 10 "
                         "minutes is not a capacity claim.")
    ap.add_argument("--think-time", type=float, default=DEFAULT_THINK_TIME_S,
                    help="seconds between one listener's requests; converts the "
                         "sustained req/s into concurrent listeners")
    ap.add_argument("--degrade-factor", type=float, default=2.0)
    ap.add_argument("--cpu-ceiling", type=float, default=95.0)
    ap.add_argument("--out", default="service/loadtest_result.json")
    ap.add_argument("--plan", action="store_true",
                    help="print the sizing advisor for an existing --out result and exit (no load run)")
    args = ap.parse_args()

    if args.plan:
        try:
            with open(args.out) as f:
                print_plan(json.load(f))
        except FileNotFoundError:
            print(f"{args.out} not found — run the load test first")
        return

    if args.route == "stream" and args.format.startswith("mp3"):
        print("!! --route stream cannot use an mp3 format (the /stream route 501s "
              "mp3 — transcoding needs the whole clip). Use pcm_24000 or wav_24000.")
        print("   Proceeding will record every request as a 501 under unsupported_501.")

    if args.arrival == "poisson" and not parse_rates(args.rate):
        print("!! --arrival poisson needs at least one positive --rate "
              "(e.g. --rate 2,4,6)")
        return

    levels = [int(x) for x in args.levels.split(",") if x.strip()]
    # Equal sample size across every level so their percentile populations are
    # comparable (computed ONCE, not per-level).
    n_per_level = requests_per_level(args.requests, levels)

    if args.replicas and args.replicas > 0:
        await run_replicas_mode(args, levels, n_per_level)
        return

    # ---- single in-process server mode (--url) ----------------------------
    # Readiness check — keep the /health config snapshot for the result JSON
    # (it was previously printed then thrown away, so runs weren't reproducible).
    service_config = {}
    async with httpx.AsyncClient() as c:
        h = await c.get(f"{args.url}/health", timeout=30)
        if h.status_code != 200:
            print(f"service not ready at {args.url} (status {h.status_code}). Start it first.")
            return
        service_config = h.json().get("config", {})
        print("service config:", json.dumps(service_config))

    # Warm the model so level 1's baseline isn't polluted by cold-start.
    if args.warmup > 0:
        print(f"warming up: {args.warmup} discarded synth request(s) ...")
        warmed = await warmup(args.url, args.voice, args.text, args.format,
                              args.warmup, cache_mode=args.cache_mode)
        print(f"warmup complete ({warmed}/{args.warmup} ok)")

    # Single mode now also scrapes the server's own GET /metrics before/after
    # each level (same delta pattern the replicas mode uses) so timeouts /
    # abandoned / queue counters land in the per-level JSON, not just headers.
    async def scrape():
        return await _scrape_server_metrics(f"{args.url}/metrics")

    (rows, knee, recommended, per_level, metrics_scope,
     extra) = await _run_configured(args, levels, n_per_level, scrape)
    result = build_result(
        rows, knee, recommended,
        route=args.route, fmt=args.format, corpus=corpus_description(args),
        service_config=service_config, meta=runtime_metadata(),
        cache_mode=args.cache_mode,
        extra={"topology": topology_block("single", 1, per_level, metrics_scope),
               "cpu_accounting": cpu_accounting_note(args.server_pid),
               **extra})
    _write_result(args, result)


if __name__ == "__main__":
    asyncio.run(main())
