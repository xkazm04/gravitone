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

Degradation is flagged when ANY of these trip vs the level-1 baseline:
  * p95 latency > --degrade-factor x baseline p95   (default 2.0)
  * any HTTP 429 (queue overflow) or errors
  * host CPU >= --cpu-ceiling% AND server realtime_factor < 1.0 (slower than realtime)
"""
from __future__ import annotations

import argparse
import asyncio
import json
import statistics
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


def pct(data, p):
    if not data:
        return None
    s = sorted(data)
    k = min(len(s) - 1, int(round((p / 100.0) * (len(s) - 1))))
    return round(s[k], 4)


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


async def run_level(url, voice, text, fmt, concurrency, n_requests):
    results = {"lat": [], "rtf": [], "audio": [], "rejected": 0, "errors": 0}
    samples = {"cpu": [], "mem": []}
    stop_evt = asyncio.Event()
    sampler = asyncio.create_task(_sample_resources(stop_evt, samples))

    sem = asyncio.Semaphore(concurrency)
    limits = httpx.Limits(max_connections=concurrency + 4, max_keepalive_connections=concurrency + 4)
    wall0 = time.perf_counter()
    async with httpx.AsyncClient(limits=limits) as client:
        async def bounded():
            async with sem:
                await _one(client, url, voice, text, fmt, results)
        await asyncio.gather(*[bounded() for _ in range(n_requests)])
    wall = time.perf_counter() - wall0

    stop_evt.set()
    await sampler

    ok = len(results["lat"])
    audio_total = sum(results["audio"])
    rtfs = [x for x in results["rtf"] if x == x]  # drop nan
    return {
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


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8080")
    ap.add_argument("--voice", default="step4")
    ap.add_argument("--text", default=TEXT_DEFAULT)
    ap.add_argument("--format", default="wav_24000")
    ap.add_argument("--levels", default="1,2,3,4,6,8",
                    help="comma-separated concurrency levels to ramp through")
    ap.add_argument("--requests", type=int, default=12,
                    help="requests fired per level")
    ap.add_argument("--degrade-factor", type=float, default=2.0)
    ap.add_argument("--cpu-ceiling", type=float, default=95.0)
    ap.add_argument("--out", default="service/loadtest_result.json")
    args = ap.parse_args()

    # readiness check
    async with httpx.AsyncClient() as c:
        h = await c.get(f"{args.url}/health", timeout=30)
        if h.status_code != 200:
            print(f"service not ready at {args.url} (status {h.status_code}). Start it first.")
            return
        print("service config:", json.dumps(h.json().get("config", {})))

    levels = [int(x) for x in args.levels.split(",") if x.strip()]
    rows = []
    baseline_p95 = None
    knee = None

    hdr = (f"{'conc':>4} {'ok':>4} {'429':>4} {'err':>4} {'p50_s':>7} {'p95_s':>7} "
           f"{'thr/s':>6} {'aud/s':>6} {'srtf':>5} {'cpu%':>5} {'mem%':>5}")
    print("\n" + hdr)
    print("-" * len(hdr))

    for c in levels:
        row = await run_level(args.url, args.voice, args.text, args.format, c, max(args.requests, c))
        rows.append(row)
        print(f"{row['concurrency']:>4} {row['ok']:>4} {row['rejected_429']:>4} "
              f"{row['errors']:>4} {str(row['lat_p50_s']):>7} {str(row['lat_p95_s']):>7} "
              f"{str(row['throughput_req_s']):>6} {str(row['audio_s_per_wall_s']):>6} "
              f"{str(row['server_rtf_mean']):>5} {str(row['cpu_mean_pct']):>5} "
              f"{str(row['mem_max_pct']):>5}")

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

    with open(args.out, "w") as f:
        json.dump({"levels": rows, "knee": knee, "recommended_cap": recommended,
                   "args": vars(args)}, f, indent=2)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    asyncio.run(main())
