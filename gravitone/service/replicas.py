"""Replica-native launcher — the real scaling story for a GIL-bound model.

The benchmark harness (``service.loadtest`` / ``service.certify``) found that
throughput scales by PROCESS, not by in-process worker: the model serializes on
the GIL, so N single-worker processes (N separate GILs) beat one N-worker
process. This module is the piece that actually runs that topology.

    python -m service.replicas --replicas 4 [--port 8000]

It spawns N uvicorn single-worker processes, pins each one's thread budget so
they don't oversubscribe the cores, supervises them (restart-on-death with
bounded backoff, SIGTERM fan-out, wait-for-children), and exposes a tiny
aggregated-metrics endpoint that sums each replica's ``/metrics`` into pool
totals. Stdlib only — no new dependencies.

Port sharing:
  * On Arm Linux (the deploy target) replicas share one client-facing ``port``
    via ``SO_REUSEPORT`` — the kernel load-balances connections across them.
  * On every other platform (and whenever ``--no-reuse-port`` is given) that
    kernel feature isn't available, so replicas fall back to sequential ports
    ``port, port+1, … port+N-1``. This is logged clearly at start-up.

Aggregated metrics are addressed per replica, and the aggregator only claims a
POOL TOTAL when it can actually reach every replica:

  * sequential-port mode — each replica has its own URL, so ``/metrics``
    returns ``scope: "pool_total"``: real sums over all N.
  * ``SO_REUSEPORT`` mode — the replicas share one port and the kernel routes
    each scrape to an arbitrary one of them. Scraping that port N times and
    summing does not produce a pool total; it produces N random samples of one
    pool member added together, which is a bigger, wronger number than the
    single sample it came from. So we scrape ONCE and return
    ``scope: "single_replica_sample"`` with ``totals: null`` — a sample that
    says it is a sample. Use ``--no-reuse-port`` (or a real metrics backend)
    when you need true pool totals.

Fabric (admin port, router, drain)
----------------------------------
The ``single_replica_sample`` caveat above is honest but useless, and it exists
for one reason only: under ``SO_REUSEPORT`` no replica has an address of its
own. So each replica now also runs a tiny stdlib ADMIN server on a private,
always-sequential loopback port (``--admin-port-base``, default ``port+2000``):

  * ``GET /metrics``   — this replica's own metrics document (same shape the
    service publishes), so ``metrics_targets(..., admin_base=...)`` has N
    addressable targets and ``scope`` is a TRUE ``pool_total`` in BOTH port
    modes. The sample caveat survives only where it is still true: no admin
    ports (``--no-admin``) plus ``SO_REUSEPORT``.
  * ``GET /introspect`` — ``live_workers``, ``available_permits``,
    ``queue_depth``, ``in_flight`` (+ ``voice_lru_keys`` once the engine
    exposes them). This is capacity detail, so the admin server binds
    ``127.0.0.1`` and NOTHING else — never ``--host``.

Because uvicorn serves one socket, the admin server cannot live inside the
service app without the launcher owning app code. Instead the launcher spawns
each replica through this module's own ``--child`` entrypoint, which starts the
admin thread and then hands the process to uvicorn. That child mode is the ONLY
place this module may touch the service's own imports, and it does so lazily,
inside functions: the parent (supervisor) process must stay stdlib-only, or
importing the launcher would drag torch into the box that supervises it. The
top-of-module import list is pinned by
``test_replicas.StdlibOnlyImportTests``.

On top of an addressable pool the launcher's front door can do two more things,
both OPT-IN (direct SO_REUSEPORT stays the default and the fallback):

  * ``--router`` — a thin stdlib proxy that picks the cheapest replica by
    (free permits, then voice affinity, then queue depth). It requires
    sequential client ports, since a shared port has no per-replica address to
    proxy TO; asking for both is refused by name rather than silently ignored.
  * drain-based replacement — ``drain_and_replace`` stops routing to a replica,
    polls its ``/introspect`` until ``in_flight == 0``, then replaces it. With
    the router off there is no route to stop, so the drain reports itself
    ``degraded`` with a named reason instead of pretending it quiesced.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Optional

logger = logging.getLogger("gravitone.replicas")

IS_LINUX = sys.platform.startswith("linux")

# Counter keys summed into pool totals — the additive subset of the engine's
# Metrics.snapshot().
#
# DELIBERATELY hand-copied, not imported from service.engine: this module is the
# SUPERVISOR. It spawns the replica processes and serves the aggregated /metrics
# using nothing but the stdlib, so it must never import engine — that would pull
# torch + scipy into the launcher process (heavy, and fatal on a box where the
# parent can't import them). Keep this list stdlib-local.
#
# The drift risk that buys (a renamed/added engine counter silently vanishing
# from pool totals) is covered by test_replicas.test_agg_keys_match_engine_metrics,
# which CAN import both sides. If you rename a counter in engine.Metrics, that
# test fails — update this tuple.
#
# audio_seconds_total is a FLOAT and was missing for exactly that reason (the
# drift test above only walks integer fields). It is additive, and it is what
# the studio's savings ticker reads, so a pool that omitted it under-reported
# every replica but one.
AGG_KEYS = (
    "received", "completed", "rejected_429", "errored", "timeouts",
    "abandoned", "cache_hits", "collapsed", "in_flight", "queued",
    "audio_seconds_total",
)

# What an aggregated /metrics document is a measurement OF.
SCOPE_POOL_TOTAL = "pool_total"              # every replica scraped and summed
SCOPE_SAMPLE = "single_replica_sample"       # one arbitrary replica, unsummable

_SAMPLE_NOTE = (
    "SO_REUSEPORT: replicas share one port and are not individually "
    "addressable, so these counters come from ONE arbitrary replica and are "
    "NOT pool totals. Restart the launcher with --no-reuse-port for "
    "per-replica addressability (this trades away kernel load-balancing)."
)

# The admin/introspection surface is capacity detail (permits, queue depth, hot
# voices). It is bound to loopback ONLY — never to the launcher's --host, which
# is routinely 0.0.0.0. This constant exists so there is exactly one place that
# decides that, and a test that pins it.
ADMIN_HOST = "127.0.0.1"

# Default offset of the private admin range from the client-facing port. The
# aggregated-metrics server already claims port+1000, so admin starts at +2000.
ADMIN_PORT_OFFSET = 2000

# Why a drain could not actually stop new work arriving at the replica.
DRAIN_ROUTER_OFF = (
    "router disabled: nothing is routing, so this drain cannot stop new work "
    "arriving at the replica (SO_REUSEPORT kernel balancing / direct clients "
    "keep sending). It waits for in-flight work to finish - a best-effort "
    "quiesce, NOT a guaranteed-empty replica. Start the launcher with --router "
    "for a drain that actually stops routing first."
)

# Environment variables pinned per replica so the whole box isn't oversubscribed
# (each thread pool would otherwise assume it owns every core).
_THREAD_ENV_VARS = (
    "TTS_TORCH_THREADS", "OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS",
    "MKL_NUM_THREADS",
)

# oneDNN bf16 fast-math — the single biggest Arm (Neoverse) inference lever,
# and it must be in the ENVIRONMENT before torch is imported, so only the
# launcher can set it. It used to live ONLY in the Dockerfile, which meant a
# bare-metal `python -m service.replicas` run silently lost it and did not
# match the container it was supposed to represent. setdefault, so an operator
# exporting a different value (or "any" to disable) still wins.
FPMATH_ENV_VAR = "ONEDNN_DEFAULT_FPMATH_MODE"
FPMATH_DEFAULT = "bf16"


# ---------------------------------------------------------------------------
# Pure helpers (fully unit-testable without spawning anything)
# ---------------------------------------------------------------------------
def per_replica_threads(replicas: int, cores: int) -> int:
    """Thread budget for one replica: cores split evenly, at least 1."""
    return max(1, cores // max(1, replicas))


def replica_env(replicas: int, cores: int, base: Optional[dict] = None) -> dict:
    """Env for a replica: single in-process worker + a pinned thread budget.

    The math libraries (OpenMP / OpenBLAS / MKL) and torch must ALL be pinned
    before the process starts — they read these vars once at import — so the
    launcher sets them here rather than relying on the child to self-limit.
    ``ONEDNN_DEFAULT_FPMATH_MODE`` is read at import time too, which is why it
    belongs here and not in the service: this is the only place that can make a
    bare-metal run match the shipped container.
    """
    env = dict(os.environ if base is None else base)
    env["TTS_WORKERS"] = "1"
    per = str(per_replica_threads(replicas, cores))
    for var in _THREAD_ENV_VARS:
        env[var] = per
    env.setdefault(FPMATH_ENV_VAR, FPMATH_DEFAULT)
    return env


def serving_ports(port: int, replicas: int, reuse_port: bool) -> list[int]:
    """Client-facing port for each replica. Shared under SO_REUSEPORT, else a
    contiguous distinct range."""
    if reuse_port:
        return [port] * replicas
    return [port + i for i in range(replicas)]


def admin_ports(admin_base: int, replicas: int) -> list[int]:
    """Private admin port per replica — ALWAYS sequential and distinct.

    Deliberately independent of the client-facing port mode: the whole point of
    the admin port is that a replica has an address of its own even when the
    kernel is load-balancing a shared one.
    """
    return [admin_base + i for i in range(replicas)]


def admin_targets(admin_base: int, replicas: int,
                  path: str = "/metrics") -> list[tuple[int | None, str]]:
    """``(replica_index, admin URL)`` for every replica, loopback only."""
    return [(i, f"http://{ADMIN_HOST}:{p}{path}")
            for i, p in enumerate(admin_ports(admin_base, replicas))]


def introspect_targets(admin_base: int, replicas: int) -> list[tuple[int | None, str]]:
    """``/introspect`` target per replica."""
    return admin_targets(admin_base, replicas, path="/introspect")


def backend_urls(host: str, port: int, replicas: int) -> list[str]:
    """Per-replica client-facing base URLs — router use, sequential ports only."""
    dial = ADMIN_HOST if host in ("0.0.0.0", "") else host
    return [f"http://{dial}:{p}"
            for p in serving_ports(port, replicas, reuse_port=False)]


def replica_command(port: int, reuse_port: bool, host: str = "0.0.0.0",
                    fd: Optional[int] = None,
                    app: str = "service.app:app",
                    admin_port: Optional[int] = None) -> list[str]:
    """The argv for one single-worker replica.

    Under ``reuse_port`` the replica inherits a pre-bound SO_REUSEPORT socket
    (``--fd``); otherwise it binds ``--host``/``--port`` itself.

    Without ``admin_port`` this is the plain ``python -m uvicorn`` line it has
    always been — byte-identical, because the deploy scripts and everyone's
    muscle memory read it. With one, the replica is launched through this
    module's ``--child`` entrypoint instead, which starts the loopback admin
    server and then hands the process to uvicorn with exactly the same socket
    arrangement.
    """
    if reuse_port and fd is None:
        raise ValueError("reuse_port command requires an inherited socket fd")
    if admin_port is None:
        cmd = [sys.executable, "-m", "uvicorn", app, "--workers", "1"]
        if reuse_port:
            cmd += ["--fd", str(fd)]
        else:
            cmd += ["--host", host, "--port", str(port)]
        return cmd
    cmd = [sys.executable, "-m", "service.replicas", "--child",
           "--app", app, "--admin-port", str(admin_port)]
    if reuse_port:
        cmd += ["--fd", str(fd)]
    else:
        cmd += ["--host", host, "--port", str(port)]
    return cmd


def metrics_scope(reuse_port: bool, admin: bool = False) -> str:
    """What the aggregated document can honestly claim in this topology.

    ``admin`` means every replica has its own admin port, which is what the
    reuse-port caveat was ever about: with N addressable targets the sum IS a
    pool total, in either port mode. Without them, a shared client port still
    yields one unlabelled sample and must still say so.
    """
    if admin:
        return SCOPE_POOL_TOTAL
    return SCOPE_SAMPLE if reuse_port else SCOPE_POOL_TOTAL


def metrics_targets(host: str, port: int, replicas: int,
                    reuse_port: bool,
                    admin_base: Optional[int] = None
                    ) -> list[tuple[int | None, str]]:
    """Scrape targets as ``(replica_index, /metrics URL)``.

    ``admin_base``: scrape each replica's private admin port instead — one
    target per replica in BOTH port modes, which is what retires the
    single-sample caveat.

    Sequential ports (no admin): one target per replica, index = that replica.

    ``SO_REUSEPORT`` (no admin): ONE target with index ``None``. The replicas
    share a port, so the kernel hands each scrape to an arbitrary member —
    there is no such thing as "replica i's URL" here. Emitting the same URL N
    times (what this used to do) invited the caller to sum N samples of one
    unknown replica into a fake pool total; one target, honestly unlabelled,
    cannot be summed by accident.
    """
    if admin_base is not None:
        return admin_targets(admin_base, replicas)
    scrape_host = ADMIN_HOST if host in ("0.0.0.0", "") else host
    if reuse_port:
        return [(None, f"http://{scrape_host}:{port}/metrics")]
    ports = serving_ports(port, replicas, reuse_port)
    return [(i, f"http://{scrape_host}:{p}/metrics") for i, p in enumerate(ports)]


def backoff_delay(consecutive_failures: int, base: float = 0.5,
                  cap: float = 30.0) -> float:
    """Exponential restart backoff, capped. 0 failures -> base."""
    if consecutive_failures <= 0:
        return base
    return min(cap, base * (2 ** consecutive_failures))


def _http_get_json(url: str, timeout: float = 2.0) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as resp:  # noqa: S310
        return json.loads(resp.read().decode("utf-8"))


def aggregate_metrics(targets: list[tuple[int | None, str]],
                      fetch: Callable[[str], dict] = _http_get_json,
                      scope: str = SCOPE_POOL_TOTAL,
                      replicas_expected: Optional[int] = None) -> dict:
    """Scrape the targets and report what they honestly add up to.

    ``fetch(url)`` returns a replica's parsed ``/metrics`` JSON (shape
    ``{"config": ..., "metrics": {...}}``, or a bare metrics dict). A replica
    that can't be reached is reported with ``ok: false`` and skipped rather
    than failing the whole scrape.

    ``scope`` decides what the document claims (see ``metrics_scope``):

    * ``pool_total`` — every replica is individually addressable, so the
      counters are summed into ``totals``. ``replicas_reporting`` /
      ``replicas_expected`` travel with them: a partial scrape yields a total
      that is real but INCOMPLETE, and the consumer has to be able to see that.
    * ``single_replica_sample`` — the replicas share a port (SO_REUSEPORT) and
      cannot be told apart. ``totals`` is ``null`` — deliberately, so nothing
      downstream can mistake a sample for a pool figure — and the one scrape is
      published as ``sample`` with a ``note`` saying why.
    """
    entries: list[dict] = []
    reporting = 0
    for idx, url in targets:
        entry: dict = {"replica": idx, "url": url}
        try:
            data = fetch(url)
            metrics = data.get("metrics", data) if isinstance(data, dict) else {}
            entry["ok"] = True
            entry["metrics"] = metrics
            reporting += 1
        except Exception as exc:  # noqa: BLE001 - one bad replica must not break the rest
            entry["ok"] = False
            entry["error"] = str(exc)
        entries.append(entry)

    doc: dict = {
        "scope": scope,
        "replicas": entries,
        "replicas_expected": (replicas_expected if replicas_expected is not None
                              else len(targets)),
        "replicas_reporting": reporting,
    }
    if scope == SCOPE_SAMPLE:
        ok = next((e for e in entries if e.get("ok")), None)
        doc["totals"] = None          # there is no total to give, so give none
        doc["sample"] = ok.get("metrics") if ok else None
        doc["note"] = _SAMPLE_NOTE
        return doc

    totals = {k: 0 for k in AGG_KEYS}
    for entry in entries:
        for k in AGG_KEYS:
            v = (entry.get("metrics") or {}).get(k)
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                totals[k] += v
    totals["audio_seconds_total"] = round(totals["audio_seconds_total"], 2)
    doc["totals"] = totals
    doc["complete"] = reporting == doc["replicas_expected"]
    return doc


# ---------------------------------------------------------------------------
# Introspection (the pool's decision-grade view of itself)
# ---------------------------------------------------------------------------
# Fields an /introspect document always carries. voice_lru_keys is deliberately
# NOT here: it appears only when the engine actually exposes the accessor, so a
# consumer can tell "no hot voices" from "this build cannot tell you".
INTROSPECT_KEYS = ("live_workers", "available_permits", "queue_depth", "in_flight")


def introspect_doc(engine: object, index: Optional[int] = None) -> dict:
    """Build one replica's ``/introspect`` document from a live engine.

    Uses ``metrics.counters()`` rather than ``snapshot()``: this endpoint is
    polled in a drain loop on a saturated box, and ``snapshot()`` sorts the
    latency windows. Missing accessors degrade to ``None`` (an older engine, or
    a fake in tests) rather than raising — an introspection endpoint that 500s
    under load is worse than one that says "unknown".
    """
    counters: dict = {}
    metrics = getattr(engine, "metrics", None)
    if metrics is not None:
        try:
            counters = metrics.counters()
        except Exception:  # noqa: BLE001 - never fail the admin surface
            counters = {}

    def _int(value):
        return value if isinstance(value, int) and not isinstance(value, bool) else None

    permits = getattr(engine, "available_permits", None)
    doc: dict = {
        "replica": index,
        "live_workers": _int(getattr(engine, "live_workers", None)),
        "available_permits": _int(permits() if callable(permits) else permits),
        "queue_depth": _int(counters.get("queued")),
        "in_flight": _int(counters.get("in_flight")),
        "ready": bool(getattr(engine, "ready", False)),
        "draining": bool(getattr(engine, "draining", False)),
    }
    # Voice affinity is the router's sleeper win, but engine.py is not ours to
    # edit: light it up the moment the accessor lands, omit the key until then.
    keys = getattr(engine, "voice_lru_keys", None)
    if callable(keys):
        try:
            doc["voice_lru_keys"] = sorted({str(k) for k in keys()})
        except Exception:  # noqa: BLE001
            pass
    return doc


def aggregate_introspection(targets: list[tuple[int | None, str]],
                            fetch: Callable[[str], dict] = _http_get_json,
                            drained: tuple = (),
                            replicas_expected: Optional[int] = None) -> dict:
    """The ONE POOL VIEW: every replica's introspection folded into a document.

    Per-replica entries keep their own identity (an unreachable replica is
    ``ok: false``, never silently dropped), ``totals`` sums only the additive
    capacity fields, and ``voices`` inverts the LRU keys into "which replica is
    hot for this voice" — the question an operator actually asks.
    """
    entries: list[dict] = []
    reporting = 0
    for idx, url in targets:
        entry: dict = {"replica": idx, "url": url, "drained": idx in drained}
        try:
            data = fetch(url)
            if not isinstance(data, dict):
                raise TypeError("introspect did not return an object")
            entry.update({k: data.get(k) for k in INTROSPECT_KEYS})
            for extra in ("ready", "draining", "voice_lru_keys"):
                if extra in data:
                    entry[extra] = data[extra]
            entry["ok"] = True
            reporting += 1
        except Exception as exc:  # noqa: BLE001 - one bad replica is not an outage
            entry["ok"] = False
            entry["error"] = str(exc)
        entries.append(entry)

    totals = {k: 0 for k in INTROSPECT_KEYS}
    voices: dict = {}
    for entry in entries:
        if not entry.get("ok"):
            continue
        for k in INTROSPECT_KEYS:
            v = entry.get(k)
            if isinstance(v, int) and not isinstance(v, bool):
                totals[k] += v
        for key in entry.get("voice_lru_keys") or ():
            voices.setdefault(str(key), []).append(entry["replica"])

    expected = replicas_expected if replicas_expected is not None else len(targets)
    return {
        "scope": SCOPE_POOL_TOTAL,
        "replicas": entries,
        "replicas_expected": expected,
        "replicas_reporting": reporting,
        "complete": reporting == expected,
        "drained": sorted(drained),
        "totals": totals,
        "voices": voices,
    }


def choose_replica(snapshots: list[dict], voice_id: Optional[str] = None,
                   drained: tuple = ()) -> Optional[int]:
    """Least-cost replica for one request, or ``None`` if none can serve.

    Cost order, most significant first:

    1. has a free admission permit — a replica with none will queue or 429 the
       request no matter how hot its voice cache is;
    2. voice affinity, when the engine tells us its LRU keys — a hit skips
       ``get_state_for_audio_prompt``, the single largest avoidable cost on a
       cold voice;
    3. most free permits, then shortest queue, then least in flight;
    4. replica index, so the choice is deterministic (and therefore testable).

    Drained and unreachable replicas are never chosen.
    """
    best: Optional[tuple] = None
    for snap in snapshots:
        idx = snap.get("replica")
        if idx is None or idx in drained or not snap.get("ok", True):
            continue
        if snap.get("draining"):
            continue
        free = snap.get("available_permits")
        free = free if isinstance(free, int) and not isinstance(free, bool) else 0
        depth = snap.get("queue_depth")
        depth = depth if isinstance(depth, int) and not isinstance(depth, bool) else 0
        inflight = snap.get("in_flight")
        inflight = inflight if isinstance(inflight, int) and not isinstance(inflight, bool) else 0
        keys = snap.get("voice_lru_keys")
        hit = bool(voice_id and isinstance(keys, (list, tuple)) and voice_id in keys)
        key = (0 if free > 0 else 1, 0 if hit else 1, -free, depth, inflight, idx)
        if best is None or key < best:
            best = key
    return None if best is None else best[-1]


def voice_of_request(body: bytes, content_type: str = "") -> Optional[str]:
    """The voice a proxied request is asking for, when it is knowable.

    JSON bodies only, and failure is always ``None`` — voice affinity is an
    optimisation, so a body we cannot parse must cost the request nothing but
    the affinity term.
    """
    if not body or "json" not in (content_type or "").lower():
        return None
    try:
        data = json.loads(body.decode("utf-8"))
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(data, dict):
        return None
    for key in ("voice_id", "voice", "character_id"):
        value = data.get(key)
        if isinstance(value, str) and value:
            return value
    return None


# ---------------------------------------------------------------------------
# Supervisor
# ---------------------------------------------------------------------------
@dataclass
class _Replica:
    index: int
    port: int
    proc: object = None                  # subprocess.Popen (or a test double)
    sock: Optional[socket.socket] = None  # kept alive so its fd stays open
    consecutive_failures: int = 0
    started_at: float = 0.0
    next_restart_at: float = 0.0
    admin_port: Optional[int] = None      # private loopback introspection port
    draining: bool = False                # excluded from routing, finishing work


class ReplicaSupervisor:
    """Spawns and supervises N single-worker replica processes.

    ``spawn`` and ``clock`` are injectable so the supervision logic can be
    exercised without launching real uvicorn/model processes.
    """

    # A replica that stays up at least this long is considered healthy and its
    # failure streak resets (so a one-off crash doesn't compound backoff).
    HEALTHY_UPTIME_S = 30.0

    def __init__(self, replicas: int, port: int = 8000, host: str = "0.0.0.0",
                 reuse_port: Optional[bool] = None, cores: Optional[int] = None,
                 spawn: Callable[..., object] = subprocess.Popen,
                 clock: Callable[[], float] = time.monotonic,
                 admin_base: Optional[int] = None, admin: bool = True,
                 sleep: Callable[[float], None] = time.sleep):
        if replicas < 1:
            raise ValueError("replicas must be >= 1")
        self.n = replicas
        self.port = port
        self.host = host
        # Default: shared port on Linux, sequential ports everywhere else.
        self.reuse_port = IS_LINUX if reuse_port is None else reuse_port
        self.cores = cores or os.cpu_count() or replicas
        self._spawn = spawn
        self._clock = clock
        self._sleep = sleep
        # Admin ports are on by default: they are what makes the pool
        # addressable (and therefore honestly aggregatable) at all. --no-admin
        # restores the plain uvicorn child for anyone who needs that exact argv.
        self.admin_base = (None if not admin else
                           (port + ADMIN_PORT_OFFSET if admin_base is None
                            else admin_base))
        self._ports = serving_ports(port, replicas, self.reuse_port)
        self._admin_ports = (admin_ports(self.admin_base, replicas)
                             if self.admin_base is not None else [None] * replicas)
        self.replicas = [_Replica(index=i, port=self._ports[i],
                                  admin_port=self._admin_ports[i])
                         for i in range(replicas)]
        self._shutting_down = False

    # -- spawning ----------------------------------------------------------
    def _make_reuse_socket(self, port: int) -> socket.socket:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)  # type: ignore[attr-defined]
        s.bind((self.host, port))
        s.listen(128)
        s.set_inheritable(True)
        return s

    def _spawn_one(self, r: _Replica) -> None:
        env = replica_env(self.n, self.cores)
        env["TTS_PORT"] = str(r.port)
        if r.admin_port is not None:
            env["TTS_ADMIN_PORT"] = str(r.admin_port)
            env["TTS_REPLICA_INDEX"] = str(r.index)
        kwargs: dict = {"env": env}
        fd = None
        if self.reuse_port:
            r.sock = self._make_reuse_socket(r.port)
            fd = r.sock.fileno()
            kwargs["pass_fds"] = (fd,)
        cmd = replica_command(r.port, self.reuse_port, host=self.host, fd=fd,
                              admin_port=r.admin_port)
        logger.info("replica %d: %s (threads/replica=%s)",
                    r.index, " ".join(cmd), env["TTS_TORCH_THREADS"])
        r.proc = self._spawn(cmd, **kwargs)
        r.started_at = self._clock()
        r.next_restart_at = 0.0
        r.draining = False   # a fresh process is a serving process
        # The child inherited its OWN copy of the listening fd (pass_fds) and
        # serves on it, so the parent no longer needs to hold the socket. Drop
        # the parent's reference now: if it stays open, a crashed child leaves
        # this socket alive-but-unserved in the SO_REUSEPORT group, and the
        # kernel keeps load-balancing ~1/N of new connections into an accept
        # queue nothing drains (clients hang, then RST) for the whole backoff
        # window. Closing it means the socket dies with the child.
        if r.sock is not None:
            r.sock.close()
            r.sock = None

    def start(self) -> None:
        mode = ("shared port %d via SO_REUSEPORT" % self.port if self.reuse_port
                else "sequential ports %d..%d" % (self.port, self.port + self.n - 1))
        if not self.reuse_port and IS_LINUX:
            logger.info("SO_REUSEPORT disabled by request; using %s", mode)
        elif not self.reuse_port:
            logger.info("SO_REUSEPORT unavailable on %s; falling back to %s",
                        sys.platform, mode)
        else:
            logger.info("launching %d replicas on %s", self.n, mode)
        for r in self.replicas:
            self._spawn_one(r)

    # -- supervision -------------------------------------------------------
    @staticmethod
    def _is_dead(proc: object) -> bool:
        return proc is None or proc.poll() is not None  # type: ignore[attr-defined]

    def check_once(self, now: Optional[float] = None) -> None:
        """One supervision tick: restart any dead replica whose backoff has
        elapsed. Safe to call on a timer."""
        if self._shutting_down:
            return
        now = self._clock() if now is None else now
        for r in self.replicas:
            if not self._is_dead(r.proc):
                # Reset the failure streak once a replica has proven stable.
                if r.consecutive_failures and now - r.started_at >= self.HEALTHY_UPTIME_S:
                    r.consecutive_failures = 0
                continue
            if r.next_restart_at == 0.0:
                # Just noticed the death: schedule the backoff window.
                r.consecutive_failures += 1
                delay = backoff_delay(r.consecutive_failures - 1)
                r.next_restart_at = now + delay
                logger.warning("replica %d died; restarting in %.1fs (failure #%d)",
                               r.index, delay, r.consecutive_failures)
                continue
            if now >= r.next_restart_at:
                self._spawn_one(r)

    def run(self, poll_interval: float = 0.5) -> None:
        """Blocking supervise loop until a termination signal arrives."""
        self._install_signal_handlers()
        self.start()
        while not self._shutting_down:
            self.check_once()
            time.sleep(poll_interval)
        self.shutdown()

    # -- drain-based replacement -------------------------------------------
    def introspect_url(self, index: int) -> Optional[str]:
        """This replica's private ``/introspect`` URL, if admin is enabled."""
        port = self.replicas[index].admin_port
        return None if port is None else f"http://{ADMIN_HOST}:{port}/introspect"

    def drain_replica(self, index: int, router: Optional["Router"] = None,
                      timeout_s: float = 60.0, poll_s: float = 0.5,
                      fetch: Callable[[str], dict] = _http_get_json) -> dict:
        """Stop routing to a replica and wait for its in-flight work to finish.

        Returns a document that says exactly what was achieved, because the
        interesting cases are the incomplete ones:

        * ``drained`` — ``in_flight`` was observed at 0.
        * ``degraded`` + ``reason`` — the wait happened, but nothing could stop
          NEW work arriving (no router: the kernel and direct clients keep
          sending), or there is no admin port to poll at all, so "0 in flight"
          was never actually observed. A rolling replacement that quietly
          assumes a quiesce it never got is how you drop live requests.
        """
        r = self.replicas[index]
        r.draining = True
        reasons: list[str] = []
        if router is not None:
            router.mark_drained(index)
        else:
            reasons.append(DRAIN_ROUTER_OFF)

        url = self.introspect_url(index)
        if url is None:
            reasons.append("no admin port (--no-admin): in-flight work is not "
                           "observable, so the drain cannot wait for it")
            return {"replica": index, "drained": False, "degraded": True,
                    "waited_s": 0.0, "in_flight": None, "reasons": reasons}

        start = self._clock()
        in_flight: Optional[int] = None
        drained = False
        while True:
            try:
                doc = fetch(url)
                in_flight = doc.get("in_flight")
                if in_flight == 0:
                    drained = True
                    break
            except Exception as exc:  # noqa: BLE001
                # An unreachable replica is not serving anything either, but we
                # did not OBSERVE the quiesce, so say so rather than claim it.
                reasons.append(f"introspect unreachable: {exc}")
                break
            if self._clock() - start >= timeout_s:
                reasons.append(f"timed out after {timeout_s}s with in_flight="
                               f"{in_flight}")
                break
            self._sleep(poll_s)

        return {"replica": index, "drained": drained,
                "degraded": bool(reasons), "waited_s": self._clock() - start,
                "in_flight": in_flight, "reasons": reasons}

    def replace_replica(self, index: int, grace_s: float = 10.0) -> None:
        """Terminate one replica and spawn its successor in the same slot."""
        r = self.replicas[index]
        if not self._is_dead(r.proc):
            try:
                r.proc.terminate()  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
                pass
            try:
                r.proc.wait(timeout=grace_s)  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
                pass
            if not self._is_dead(r.proc):
                try:
                    r.proc.kill()  # type: ignore[attr-defined]
                except Exception:  # noqa: BLE001
                    pass
        # A deliberate replacement is not a crash: don't let it feed the
        # restart backoff that exists to slow down a crash loop.
        r.consecutive_failures = 0
        r.next_restart_at = 0.0
        self._spawn_one(r)

    def drain_and_replace(self, index: int, router: Optional["Router"] = None,
                          timeout_s: float = 60.0, poll_s: float = 0.5,
                          grace_s: float = 10.0,
                          fetch: Callable[[str], dict] = _http_get_json) -> dict:
        """Rolling replacement of one replica: drain, replace, resume routing."""
        result = self.drain_replica(index, router=router, timeout_s=timeout_s,
                                    poll_s=poll_s, fetch=fetch)
        logger.info("replica %d drain: drained=%s degraded=%s", index,
                    result["drained"], result["degraded"])
        self.replace_replica(index, grace_s=grace_s)
        if router is not None:
            router.unmark_drained(index)
        result["replaced"] = True
        return result

    # -- shutdown ----------------------------------------------------------
    def _install_signal_handlers(self) -> None:
        def _handler(signum, frame):  # noqa: ANN001
            logger.info("received signal %s; shutting down replicas", signum)
            self._shutting_down = True
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                signal.signal(sig, _handler)
            except (ValueError, OSError):  # not in main thread / unsupported
                pass

    def shutdown(self, grace_s: float = 10.0) -> None:
        """SIGTERM fan-out, wait for graceful drain, then SIGKILL stragglers."""
        self._shutting_down = True
        alive = [r for r in self.replicas if not self._is_dead(r.proc)]
        for r in alive:
            try:
                r.proc.terminate()  # type: ignore[attr-defined]  # SIGTERM on POSIX
            except Exception:  # noqa: BLE001
                pass
        deadline = self._clock() + grace_s
        for r in alive:
            remaining = max(0.0, deadline - self._clock())
            try:
                r.proc.wait(timeout=remaining)  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001 - timeout or already-gone
                pass
        for r in alive:
            if not self._is_dead(r.proc):
                try:
                    r.proc.kill()  # type: ignore[attr-defined]
                except Exception:  # noqa: BLE001
                    pass
        for r in self.replicas:
            if r.sock is not None:
                try:
                    r.sock.close()
                except Exception:  # noqa: BLE001
                    pass


# ---------------------------------------------------------------------------
# Stdlib HTTP plumbing (shared by the admin server and the front door)
# ---------------------------------------------------------------------------
# Headers that describe THIS hop and must never be copied onto the next one.
_HOP_BY_HOP = frozenset({
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length",
})

_PROXY_CHUNK = 64 * 1024


def _json_routes_handler(routes: dict, router: Optional["Router"] = None):
    """Handler class serving a ``{path: callable() -> dict}`` route table.

    Anything not in the table is a 404 — unless a router is attached, in which
    case it is a client request to be proxied on.
    """

    class _Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _json(self, payload: dict, status: int = 200) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _dispatch(self) -> None:
            path = urllib.parse.urlparse(self.path).path
            fn = routes.get(path)
            if fn is not None:
                try:
                    self._json(fn())
                except Exception as exc:  # noqa: BLE001 - admin must not 500-crash
                    self._json({"error": str(exc)}, status=503)
                return
            if router is not None:
                router.proxy(self)
                return
            self._json({"error": "not found", "path": path}, status=404)

        do_GET = _dispatch       # noqa: N815
        do_POST = _dispatch      # noqa: N815
        do_PUT = _dispatch       # noqa: N815
        do_PATCH = _dispatch     # noqa: N815
        do_DELETE = _dispatch    # noqa: N815

        def log_message(self, *a):  # silence default stderr access log
            pass

    return _Handler


def make_json_server(host: str, port: int, routes: dict,
                     router: Optional["Router"] = None) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), _json_routes_handler(routes, router))


# ---------------------------------------------------------------------------
# Per-replica admin server (runs INSIDE the replica process, loopback only)
# ---------------------------------------------------------------------------
def admin_routes(engine_getter: Callable[[], object],
                 index: Optional[int] = None,
                 cache_getter: Optional[Callable[[], dict]] = None) -> dict:
    """Route table for one replica's private admin port.

    ``/metrics``    the same document the service publishes, so the launcher's
                    aggregator can scrape it with no special-casing;
    ``/introspect`` the decision-grade view (permits, queue, hot voices).
    """

    def _metrics() -> dict:
        engine = engine_getter()
        if engine is None:
            raise RuntimeError("engine not ready")
        doc = {"config": engine.config(), "metrics": engine.metrics.snapshot()}
        if cache_getter is not None:
            try:
                doc["cache"] = cache_getter()
            except Exception:  # noqa: BLE001 - cache stats are not load-bearing
                pass
        doc["replica"] = index
        return doc

    def _introspect() -> dict:
        engine = engine_getter()
        if engine is None:
            raise RuntimeError("engine not ready")
        return introspect_doc(engine, index=index)

    return {"/metrics": _metrics, "/introspect": _introspect}


def make_admin_server(admin_port: int, engine_getter: Callable[[], object],
                      index: Optional[int] = None,
                      cache_getter: Optional[Callable[[], dict]] = None
                      ) -> ThreadingHTTPServer:
    """The replica-private admin server. Bound to ``ADMIN_HOST``, always.

    The host is NOT a parameter on purpose: this endpoint publishes capacity
    detail (free permits, queue depth, which voices are resident), and the one
    way that leaks is somebody passing the launcher's ``--host`` (routinely
    ``0.0.0.0``) into it.
    """
    return make_json_server(ADMIN_HOST, admin_port,
                            admin_routes(engine_getter, index=index,
                                         cache_getter=cache_getter))


# ---------------------------------------------------------------------------
# Front-door router (OPT-IN; direct mode is unchanged and remains the default)
# ---------------------------------------------------------------------------
class Router:
    """A thin stdlib proxy that sends each request to the cheapest replica.

    Deliberately small: it is a new hop and a new single point of failure, so
    it stays off unless asked for, holds no state beyond a short-lived
    introspection cache and the drained set, and never imports anything the
    supervisor could not already import.
    """

    def __init__(self, backends: list[str],
                 introspect: list[tuple[int | None, str]],
                 fetch: Callable[[str], dict] = _http_get_json,
                 ttl_s: float = 0.5,
                 clock: Callable[[], float] = time.monotonic,
                 open_upstream: Optional[Callable[..., object]] = None):
        self.backends = list(backends)
        self._introspect = list(introspect)
        self._fetch = fetch
        self._ttl = ttl_s
        self._clock = clock
        self._open = open_upstream or (lambda req, timeout: urllib.request.urlopen(req, timeout=timeout))  # noqa: S310,E501
        self._lock = threading.Lock()
        self._drained: set = set()
        self._cache: list[dict] = []
        self._cached_at = -1e9

    # -- routing state -----------------------------------------------------
    def mark_drained(self, index: int) -> None:
        with self._lock:
            self._drained.add(index)

    def unmark_drained(self, index: int) -> None:
        with self._lock:
            self._drained.discard(index)

    @property
    def drained(self) -> tuple:
        with self._lock:
            return tuple(sorted(self._drained))

    def snapshots(self, force: bool = False) -> list[dict]:
        """Per-replica introspection, cached for ``ttl_s``.

        The cache is what keeps the router honest about its own cost: without
        it, every proxied request would pay N extra HTTP round-trips to decide
        where to go, which is a worse deal than the kernel's blind balancing.
        """
        now = self._clock()
        with self._lock:
            fresh = self._cache and (now - self._cached_at) < self._ttl
            if fresh and not force:
                return list(self._cache)
        doc = aggregate_introspection(self._introspect, fetch=self._fetch,
                                      drained=self.drained)
        snaps = doc["replicas"]
        with self._lock:
            self._cache = snaps
            self._cached_at = now
        return list(snaps)

    def pick(self, voice_id: Optional[str] = None) -> Optional[int]:
        return choose_replica(self.snapshots(), voice_id=voice_id,
                              drained=self.drained)

    def pool(self) -> dict:
        doc = aggregate_introspection(self._introspect, fetch=self._fetch,
                                      drained=self.drained)
        doc["backends"] = list(self.backends)
        return doc

    # -- proxying ----------------------------------------------------------
    def proxy(self, handler: BaseHTTPRequestHandler) -> None:
        """Forward one client request to the chosen replica.

        The body is buffered (a synthesis request is small); the RESPONSE is
        streamed straight through in chunks, because that is the side that
        carries audio.
        """
        length = int(handler.headers.get("Content-Length") or 0)
        body = handler.rfile.read(length) if length > 0 else b""
        voice = voice_of_request(body, handler.headers.get("Content-Type", ""))
        index = self.pick(voice)
        if index is None or index >= len(self.backends):
            payload = json.dumps({
                "detail": "no replica available",
                "drained": list(self.drained),
            }).encode("utf-8")
            handler.send_response(503)
            handler.send_header("Content-Type", "application/json")
            handler.send_header("Content-Length", str(len(payload)))
            handler.end_headers()
            handler.wfile.write(payload)
            return

        url = self.backends[index] + handler.path
        headers = {k: v for k, v in handler.headers.items()
                   if k.lower() not in _HOP_BY_HOP}
        req = urllib.request.Request(url, data=body or None,
                                     headers=headers, method=handler.command)
        try:
            resp = self._open(req, 300.0)
        except urllib.error.HTTPError as exc:
            resp = exc            # an upstream 4xx/5xx is a real answer: relay it
        except Exception as exc:  # noqa: BLE001 - upstream down
            payload = json.dumps({"detail": f"replica {index} unreachable: {exc}"}
                                 ).encode("utf-8")
            handler.send_response(502)
            handler.send_header("Content-Type", "application/json")
            handler.send_header("Content-Length", str(len(payload)))
            handler.end_headers()
            handler.wfile.write(payload)
            return

        with resp:
            status = getattr(resp, "status", None) or resp.getcode()
            handler.send_response(status)
            handler.send_header("X-Gravitone-Replica", str(index))
            for k, v in resp.headers.items():
                if k.lower() not in _HOP_BY_HOP:
                    handler.send_header(k, v)
            # We do not know the length up front for a streamed body, so close
            # the connection to delimit it rather than lie in Content-Length.
            handler.send_header("Connection", "close")
            handler.end_headers()
            while True:
                chunk = resp.read(_PROXY_CHUNK)
                if not chunk:
                    break
                handler.wfile.write(chunk)
        handler.close_connection = True


# ---------------------------------------------------------------------------
# Launcher front door: aggregated /metrics, /introspect, /pool (+ router)
# ---------------------------------------------------------------------------
def make_metrics_server(host: str, metrics_port: int,
                        targets: list[tuple[int | None, str]],
                        scope: str = SCOPE_POOL_TOTAL,
                        replicas_expected: Optional[int] = None,
                        introspect: Optional[list[tuple[int | None, str]]] = None,
                        router: Optional[Router] = None) -> ThreadingHTTPServer:
    """The launcher's HTTP surface.

    ``GET /metrics``    the pool view — summed when the replicas are
                        addressable, an explicitly-labelled single-replica
                        sample when SO_REUSEPORT alone means they are not.
    ``GET /introspect`` per-replica capacity, when admin ports exist.
    ``GET /pool``       ONE POOL VIEW: every replica's introspection folded
                        into a single document (totals + which replica is hot
                        for which voice + who is drained).

    With a ``router`` attached, every OTHER path is proxied to the cheapest
    replica.
    """
    routes: dict = {
        "/metrics": lambda: aggregate_metrics(
            targets, scope=scope, replicas_expected=replicas_expected),
    }
    if introspect:
        def _drained() -> tuple:
            return router.drained if router is not None else ()

        routes["/introspect"] = lambda: aggregate_introspection(
            introspect, drained=_drained(), replicas_expected=replicas_expected)

        def _pool() -> dict:
            doc = aggregate_introspection(introspect, drained=_drained(),
                                          replicas_expected=replicas_expected)
            doc["metrics"] = aggregate_metrics(
                targets, scope=scope, replicas_expected=replicas_expected)
            doc["routing"] = "router" if router is not None else "direct"
            return doc

        routes["/pool"] = _pool
    return make_json_server(host, metrics_port, routes, router=router)


# ---------------------------------------------------------------------------
# Child mode: one replica = admin server thread + uvicorn
# ---------------------------------------------------------------------------
def _app_engine_getter(app: str) -> Callable[[], object]:
    """Lazy accessor for the replica's in-process engine.

    Imported INSIDE the returned closure, and only ever called in the child:
    the supervisor process must be able to import this module without pulling
    in the service (and therefore torch).
    """
    module = app.split(":", 1)[0]

    def _get() -> object:
        mod = __import__(module, fromlist=["ENGINE"])
        return getattr(mod, "ENGINE", None)

    return _get


def _app_cache_getter(app: str) -> Callable[[], dict]:
    module = app.split(":", 1)[0]

    def _get() -> dict:
        mod = __import__(module, fromlist=["SYNTH_CACHE"])
        cache = getattr(mod, "SYNTH_CACHE", None)
        return cache.stats() if cache is not None else {}

    return _get


def child_main(app: str, admin_port: int, index: Optional[int] = None,
               host: str = "0.0.0.0", port: Optional[int] = None,
               fd: Optional[int] = None) -> None:  # pragma: no cover - process entry
    """Run one replica: start its loopback admin server, then serve the app."""
    import uvicorn  # noqa: PLC0415 - child-side only; never in the supervisor

    server = make_admin_server(admin_port, _app_engine_getter(app), index=index,
                               cache_getter=_app_cache_getter(app))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    logger.info("replica %s admin on http://%s:%d (/metrics, /introspect)",
                index, ADMIN_HOST, admin_port)
    try:
        if fd is not None:
            uvicorn.run(app, fd=fd, log_level="info")
        else:
            uvicorn.run(app, host=host, port=port, log_level="info")
    finally:
        server.shutdown()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main(argv: Optional[list[str]] = None) -> None:
    ap = argparse.ArgumentParser(
        prog="python -m service.replicas",
        description="Run and supervise N single-worker TTS replicas.")
    ap.add_argument("--replicas", type=int, required=True,
                    help="number of single-worker processes to run")
    ap.add_argument("--port", type=int, default=8000,
                    help="client-facing port (shared under SO_REUSEPORT, else base of a range)")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--metrics-port", type=int, default=None,
                    help="aggregated-metrics port (default: --port + 1000)")
    ap.add_argument("--cores", type=int, default=None,
                    help="core budget to split across replicas (default: os.cpu_count())")
    ap.add_argument("--admin-port-base", type=int, default=None,
                    help="base of the private loopback admin range "
                         "(default: --port + %d)" % ADMIN_PORT_OFFSET)
    ap.add_argument("--no-admin", dest="admin", action="store_false", default=True,
                    help="disable per-replica admin ports (restores the plain "
                         "uvicorn child; pool totals fall back to a sample "
                         "under SO_REUSEPORT)")
    ap.add_argument("--router", action="store_true",
                    help="front-door router: proxy requests to the cheapest "
                         "replica (OFF by default; requires sequential ports)")
    reuse = ap.add_mutually_exclusive_group()
    reuse.add_argument("--reuse-port", dest="reuse_port", action="store_true",
                       default=None, help="force SO_REUSEPORT shared port (Linux)")
    reuse.add_argument("--no-reuse-port", dest="reuse_port", action="store_false",
                       help="force sequential distinct ports")
    # Child mode (spawned by this launcher, not for humans): serve one replica
    # with a private admin port. Parsed by the same parser so the argv is
    # self-documenting in `ps`.
    ap.add_argument("--child", action="store_true", help=argparse.SUPPRESS)
    ap.add_argument("--app", default="service.app:app", help=argparse.SUPPRESS)
    ap.add_argument("--admin-port", type=int, default=None, help=argparse.SUPPRESS)
    ap.add_argument("--fd", type=int, default=None, help=argparse.SUPPRESS)
    ap.add_argument("--index", type=int, default=None, help=argparse.SUPPRESS)
    if argv is None:
        argv = sys.argv[1:]
    # --replicas is required for the launcher but meaningless for a child.
    if "--child" in argv:
        for action in ap._actions:      # noqa: SLF001 - argparse has no public API
            if action.dest == "replicas":
                action.required = False
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    if args.child:
        if args.admin_port is None:
            ap.error("--child requires --admin-port")
        index = args.index
        if index is None and os.environ.get("TTS_REPLICA_INDEX", "").isdigit():
            index = int(os.environ["TTS_REPLICA_INDEX"])
        child_main(args.app, args.admin_port, index=index, host=args.host,
                   port=args.port, fd=args.fd)
        return

    if args.router and args.reuse_port:
        ap.error("--router needs per-replica addresses, but --reuse-port makes "
                 "every replica share one; the router cannot proxy to a socket "
                 "the kernel assigns. Use --router --no-reuse-port.")
    if args.router and not args.admin:
        ap.error("--router routes by live capacity, which it reads from the "
                 "admin ports that --no-admin turns off.")
    # A router replaces the kernel's balancing, so the replicas must be
    # individually addressable: default to sequential ports when routing.
    reuse_port = False if args.router else args.reuse_port

    sup = ReplicaSupervisor(replicas=args.replicas, port=args.port,
                            host=args.host, reuse_port=reuse_port,
                            cores=args.cores, admin=args.admin,
                            admin_base=args.admin_port_base)
    metrics_port = args.metrics_port if args.metrics_port is not None else args.port + 1000
    targets = metrics_targets(args.host, args.port, args.replicas,
                              sup.reuse_port, admin_base=sup.admin_base)
    scope = metrics_scope(sup.reuse_port, admin=sup.admin_base is not None)
    introspect = (introspect_targets(sup.admin_base, args.replicas)
                  if sup.admin_base is not None else None)
    router = None
    if args.router:
        router = Router(backend_urls(args.host, args.port, args.replicas),
                        introspect or [])
    server = make_metrics_server(args.host, metrics_port, targets, scope=scope,
                                 replicas_expected=args.replicas,
                                 introspect=introspect, router=router)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    logger.info("metrics on http://%s:%d/metrics (scope=%s)",
                args.host, metrics_port, scope)
    if sup.admin_base is not None:
        logger.info("admin ports %d..%d on %s (/metrics, /introspect); pool view "
                    "on http://%s:%d/pool", sup.admin_base,
                    sup.admin_base + args.replicas - 1, ADMIN_HOST,
                    args.host, metrics_port)
    if router is not None:
        logger.info("router ENABLED on port %d: least-cost replica by "
                    "(free permits, voice affinity, queue depth)", metrics_port)
    if scope == SCOPE_SAMPLE:
        logger.warning("metrics scope is %s: %s", SCOPE_SAMPLE, _SAMPLE_NOTE)

    try:
        sup.run()
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
