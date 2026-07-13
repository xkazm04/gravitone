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

Degradation is flagged when ANY of these trip vs the level-1 baseline:
  * p95 latency > --degrade-factor x baseline p95   (default 2.0)
  * any HTTP 429 (queue overflow) or errors
  * host CPU >= --cpu-ceiling% AND server realtime_factor < 1.0 (slower than realtime)
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

try:
    import psutil
except ImportError:  # resource sampling is best-effort
    psutil = None

TEXT_DEFAULT = (
    "This is a load test sentence for the pocket text to speech service. "
    "It is long enough to produce several seconds of audio per request."
)

# Result-JSON schema version. Bump when the shape changes so two result files
# can be compared safely (v1 = the pre-versioned shape; v2 = self-describing).
SCHEMA_VERSION = 2

# Below this many successful samples per level, p95/p99 are statistically noisy
# and get flagged rather than trusted.
LOW_CONFIDENCE_N = 20


def pct(data, p):
    if not data:
        return None
    s = sorted(data)
    k = min(len(s) - 1, int(round((p / 100.0) * (len(s) - 1))))
    return round(s[k], 4)


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


def build_result(rows, knee, recommended, *, route, fmt, corpus,
                 service_config, meta, extra=None) -> dict:
    """Assemble the self-describing result document (schema v2).

    Everything needed to reproduce/compare a run travels WITH the numbers:
    schema version, git SHA, torch + fpmath mode, the server's own /health
    config, and exactly what was sent (corpus/format/route).
    """
    result = {
        "schema_version": meta["schema_version"],
        "git_sha": meta["git_sha"],
        "torch_version": meta["torch_version"],
        "onednn_fpmath_mode": meta["onednn_fpmath_mode"],
        "route": route,
        "format": fmt,
        "corpus": corpus,
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
# Pool counters worth reporting per level (the launcher's aggregated totals).
TOPOLOGY_METRIC_KEYS = (
    "received", "completed", "rejected_429", "errored", "timeouts",
    "abandoned", "in_flight", "queued",
)


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
    """Per-counter (after - before) over the aggregated pool totals.

    ``before``/``after`` are the ``totals`` dicts scraped from the launcher's
    side metrics port around one level. Non-numeric or missing counters are
    skipped so a partial scrape can't crash the run.
    """
    delta: dict = {}
    for k in TOPOLOGY_METRIC_KEYS:
        b, a = before.get(k), after.get(k)
        if (isinstance(a, (int, float)) and not isinstance(a, bool)
                and isinstance(b, (int, float)) and not isinstance(b, bool)):
            delta[k] = a - b
    return delta


def topology_block(mode: str, replicas: int, per_level: list) -> dict:
    """The result-JSON block describing WHAT topology produced these numbers.

    mode "single" = one in-process server (``--url``); mode "replicas" = the
    ``service.replicas`` launcher driving N single-worker processes, with the
    aggregated pool-counter deltas captured around every level.
    """
    return {
        "mode": mode,
        "replicas": replicas,
        "aggregated_metrics_per_level": per_level,
    }


async def _scrape_pool_totals(metrics_url: str) -> dict:
    """Scrape the launcher's aggregated /metrics and return its pool totals
    (empty dict if unreachable — a missing scrape must not abort the ramp)."""
    try:
        async with httpx.AsyncClient() as c:
            r = await c.get(metrics_url, timeout=5)
            if r.status_code == 200:
                return r.json().get("totals", {}) or {}
    except Exception:  # noqa: BLE001
        pass
    return {}


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


async def _one(client, url, voice, text, fmt, results):
    t0 = time.perf_counter()
    try:
        r = await client.post(
            f"{url}/v1/text-to-speech/{voice}",
            params={"output_format": fmt},
            json={"text": text, "model_id": "pocket_tts"},
            timeout=300,
        )
        dt = time.perf_counter() - t0
        if r.status_code == 200:
            results["lat"].append(dt)
            results["rtf"].append(float(r.headers.get("X-Realtime-Factor", "nan")))
            results["audio"].append(float(r.headers.get("X-Audio-Seconds", "0")))
        elif r.status_code == 429:
            results["rejected"] += 1
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


async def _one_stream(client, url, voice, text, fmt, results):
    t0 = time.perf_counter()
    try:
        async with client.stream(
            "POST", f"{url}/v1/text-to-speech/{voice}/stream",
            params={"output_format": fmt},
            json={"text": text, "model_id": "pocket_tts"},
            timeout=300,
        ) as r:
            if r.status_code == 200:
                ttfb, total = await _measure_stream_timing(r.aiter_bytes(), t0)
                results["lat"].append(total)
                if ttfb is not None:
                    results["ttfb"].append(ttfb)
            elif r.status_code == 429:
                results["rejected"] += 1
            elif r.status_code == 501:
                # The stream route 501s mp3 (transcoding needs the whole clip).
                results["unsupported"] += 1
            else:
                results["errors"] += 1
    except Exception:  # noqa: BLE001
        results["errors"] += 1


async def _sample_resources(stop_evt, samples):
    if psutil is None:
        return
    psutil.cpu_percent(None)  # prime (non-blocking mode)
    while not stop_evt.is_set():
        # MUST await, not block: psutil.cpu_percent(interval=...) blocks the
        # event loop and would starve the request tasks. Use non-blocking
        # sampling (delta since last call) + asyncio.sleep to yield.
        await asyncio.sleep(0.5)
        samples["cpu"].append(psutil.cpu_percent(None))
        samples["mem"].append(psutil.virtual_memory().percent)


async def run_level(url, voice, text, fmt, concurrency, n_requests, route="synth"):
    results = {"lat": [], "ttfb": [], "rtf": [], "audio": [],
               "rejected": 0, "errors": 0, "unsupported": 0}
    samples = {"cpu": [], "mem": []}
    stop_evt = asyncio.Event()
    sampler = asyncio.create_task(_sample_resources(stop_evt, samples))

    # In stream mode we time to first CHUNK; in synth mode we time full responses.
    one = _one_stream if route == "stream" else _one
    sem = asyncio.Semaphore(concurrency)
    limits = httpx.Limits(max_connections=concurrency + 4, max_keepalive_connections=concurrency + 4)
    wall0 = time.perf_counter()
    async with httpx.AsyncClient(limits=limits) as client:
        async def bounded():
            async with sem:
                await one(client, url, voice, text, fmt, results)
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
        "errors": results["errors"],
        "wall_s": round(wall, 2),
        "throughput_req_s": round(ok / wall, 3) if wall else None,
        "audio_s_per_wall_s": round(audio_total / wall, 3) if wall else None,
        "lat_p50_s": pct(results["lat"], 50),
        "lat_p95_s": pct(results["lat"], 95),
        "lat_p99_s": pct(results["lat"], 99),
        "server_rtf_mean": round(statistics.mean(rtfs), 3) if rtfs else None,
        "cpu_mean_pct": round(statistics.mean(samples["cpu"]), 1) if samples["cpu"] else None,
        "cpu_max_pct": round(max(samples["cpu"]), 1) if samples["cpu"] else None,
        "mem_max_pct": round(max(samples["mem"]), 1) if samples["mem"] else None,
    }
    if route == "stream":
        # lat_* above ARE the total-response percentiles; add first-chunk (TTFB)
        # percentiles — the "first audio in Nms" headline — and the 501 tally.
        row["ttfb_p50_s"] = pct(results["ttfb"], 50)
        row["ttfb_p95_s"] = pct(results["ttfb"], 95)
        row["ttfb_p99_s"] = pct(results["ttfb"], 99)
        row["unsupported_501"] = results["unsupported"]
    return row


async def warmup(url, voice, text, fmt, n):
    """Fire N synth requests before the ramp so level 1 doesn't eat cold-start.

    These requests are thrown away — never recorded in any level's stats — so a
    standalone run's baseline reflects warm steady-state, not a first-token cold
    model load. Returns the count of successful warmups (for reporting only).
    """
    if n <= 0:
        return 0
    results = {"lat": [], "rtf": [], "audio": [], "rejected": 0, "errors": 0}
    async with httpx.AsyncClient() as client:
        for _ in range(n):
            await _one(client, url, voice, text, fmt, results)
    return len(results["lat"])


def print_plan(result: dict) -> None:
    """Sizing advisor: translate measured knee data into the exact deployment
    env vars (mirrors the /benchmarks capacity planner in the web studio).

    Grounded in the benchmark finding that throughput scales by
    process/replica, not in-process workers (the model is GIL-bound): the
    safe cap becomes the number of single-worker processes to run.
    """
    import os

    rows = result.get("levels") or []
    if not rows:
        print("no levels in result -- run the load test first")
        return
    knee = result.get("knee")
    cap = result.get("recommended_cap") or rows[-1]["concurrency"]
    at_cap = next((r for r in rows if r["concurrency"] == cap), rows[-1])
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
              f"{topo.get('replicas')} replica(s) — see topology.aggregated_metrics_per_level)")
    else:
        print("  (single-server run: re-run with --replicas to measure this launcher directly)")
    print("\nScale by adding processes/replicas, not in-process workers (GIL-bound).")
    print("Full calculator + $/audio-hour comparison: the studio's /benchmarks page.")
    print("-" * 60)


async def run_ramp(args, levels, n_per_level, *, scrape=None):
    """Ramp through ``levels``, print the live table, and return
    ``(rows, knee, recommended, per_level_metrics)``.

    If ``scrape`` (an async ``() -> pool-totals dict``) is supplied, the
    aggregated pool counters are captured before/after each level and their
    delta recorded — that's how the replica topology reports timeouts/abandoned.
    """
    rows = []
    per_level_metrics: list = []
    baseline_p95 = None
    knee = None
    route = getattr(args, "route", "synth")

    if route == "stream":
        # Stream mode leads with TTFB (first-chunk latency), the headline number;
        # the /stream route emits no timing headers so srtf/aud/s are dropped.
        hdr = (f"{'conc':>4} {'ok':>4} {'429':>4} {'err':>4} {'501':>4} "
               f"{'tfb50':>7} {'tfb95':>7} {'tot50':>7} {'tot95':>7} "
               f"{'thr/s':>6} {'cpu%':>5} {'mem%':>5}")
    else:
        hdr = (f"{'conc':>4} {'ok':>4} {'429':>4} {'err':>4} {'p50_s':>7} {'p95_s':>7} "
               f"{'thr/s':>6} {'aud/s':>6} {'srtf':>5} {'cpu%':>5} {'mem%':>5}")
    print("\n" + hdr)
    print("-" * len(hdr))

    for c in levels:
        before = await scrape() if scrape is not None else None
        row = await run_level(args.url, args.voice, args.text, args.format, c,
                              n_per_level, route=route)
        after = await scrape() if scrape is not None else None
        mark_low_confidence(row)
        rows.append(row)
        if route == "stream":
            print(f"{row['concurrency']:>4} {row['ok']:>4} {row['rejected_429']:>4} "
                  f"{row['errors']:>4} {row['unsupported_501']:>4} "
                  f"{str(row['ttfb_p50_s']):>7} {str(row['ttfb_p95_s']):>7} "
                  f"{str(row['lat_p50_s']):>7} {str(row['lat_p95_s']):>7} "
                  f"{str(row['throughput_req_s']):>6} {str(row['cpu_mean_pct']):>5} "
                  f"{str(row['mem_max_pct']):>5}")
            if row["unsupported_501"]:
                print(f"     ^ {row['unsupported_501']} request(s) got 501: mp3 is not "
                      f"streamable — use pcm_24000/wav_24000 for --route stream")
        else:
            print(f"{row['concurrency']:>4} {row['ok']:>4} {row['rejected_429']:>4} "
                  f"{row['errors']:>4} {str(row['lat_p50_s']):>7} {str(row['lat_p95_s']):>7} "
                  f"{str(row['throughput_req_s']):>6} {str(row['audio_s_per_wall_s']):>6} "
                  f"{str(row['server_rtf_mean']):>5} {str(row['cpu_mean_pct']):>5} "
                  f"{str(row['mem_max_pct']):>5}")
        if row.get("low_confidence"):
            print(f"     ^ low confidence: only {row['ok']} sample(s) < {LOW_CONFIDENCE_N}; "
                  f"treat p95/p99 as indicative, not exact")
        if scrape is not None:
            delta = metrics_delta(before or {}, after or {})
            per_level_metrics.append({"concurrency": c, "pool_delta": delta})
            if delta:
                print("     pool Δ: "
                      + " ".join(f"{k}={v}" for k, v in delta.items() if v))

        if c == levels[0]:
            baseline_p95 = row["lat_p95_s"] or 0.0
        degraded = False
        if row["rejected_429"] or row["errors"]:
            degraded = True
        if baseline_p95 and row["lat_p95_s"] and row["lat_p95_s"] > args.degrade_factor * baseline_p95:
            degraded = True
        if (row["cpu_mean_pct"] and row["cpu_mean_pct"] >= args.cpu_ceiling
                and row["server_rtf_mean"] is not None and row["server_rtf_mean"] < 1.0):
            degraded = True
        if degraded and knee is None:
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
    print("=" * 60)
    return rows, knee, recommended, per_level_metrics


def _write_result(args, result) -> None:
    result["args"] = vars(args)
    with open(args.out, "w") as f:
        json.dump(result, f, indent=2)
    print(f"wrote {args.out}")
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
              f"({args.replicas} replicas); aggregated metrics on {metrics_url}")
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
        if args.warmup > 0:
            print(f"warming up: {args.warmup} discarded synth request(s) ...")
            warmed = await warmup(args.url, args.voice, args.text, args.format, args.warmup)
            print(f"warmup complete ({warmed}/{args.warmup} ok)")

        async def scrape():
            return await _scrape_pool_totals(metrics_url)

        rows, knee, recommended, per_level = await run_ramp(
            args, levels, n_per_level, scrape=scrape)
        if proc.poll() is not None:
            print(f"!! launcher died during the ramp (code {proc.returncode}); "
                  f"results below may be partial")

        result = build_result(
            rows, knee, recommended,
            route=args.route, fmt=args.format, corpus=args.text,
            service_config=service_config, meta=runtime_metadata(),
            extra={"topology": topology_block("replicas", args.replicas, per_level)})
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
        warmed = await warmup(args.url, args.voice, args.text, args.format, args.warmup)
        print(f"warmup complete ({warmed}/{args.warmup} ok)")

    rows, knee, recommended, _ = await run_ramp(args, levels, n_per_level)
    result = build_result(
        rows, knee, recommended,
        route=args.route, fmt=args.format, corpus=args.text,
        service_config=service_config, meta=runtime_metadata(),
        extra={"topology": topology_block("single", 1, [])})
    _write_result(args, result)


if __name__ == "__main__":
    asyncio.run(main())
