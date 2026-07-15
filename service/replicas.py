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

Aggregated metrics are addressed per replica. Under ``SO_REUSEPORT`` the
replicas are not individually addressable (they answer on one shared port), so
the aggregator scrapes the shared port once per replica and sums — accurate
pool totals require the sequential-port mode; this is documented and logged.
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
AGG_KEYS = (
    "received", "completed", "rejected_429", "errored", "timeouts",
    "abandoned", "in_flight", "queued",
)

# Environment variables pinned per replica so the whole box isn't oversubscribed
# (each thread pool would otherwise assume it owns every core).
_THREAD_ENV_VARS = (
    "TTS_TORCH_THREADS", "OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS",
    "MKL_NUM_THREADS",
)


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
    """
    env = dict(os.environ if base is None else base)
    env["TTS_WORKERS"] = "1"
    per = str(per_replica_threads(replicas, cores))
    for var in _THREAD_ENV_VARS:
        env[var] = per
    return env


def serving_ports(port: int, replicas: int, reuse_port: bool) -> list[int]:
    """Client-facing port for each replica. Shared under SO_REUSEPORT, else a
    contiguous distinct range."""
    if reuse_port:
        return [port] * replicas
    return [port + i for i in range(replicas)]


def replica_command(port: int, reuse_port: bool, host: str = "0.0.0.0",
                    fd: Optional[int] = None,
                    app: str = "service.app:app") -> list[str]:
    """The uvicorn argv for one single-worker replica.

    Under ``reuse_port`` the replica inherits a pre-bound SO_REUSEPORT socket
    (``--fd``); otherwise it binds ``--host``/``--port`` itself.
    """
    cmd = [sys.executable, "-m", "uvicorn", app, "--workers", "1"]
    if reuse_port:
        if fd is None:
            raise ValueError("reuse_port command requires an inherited socket fd")
        cmd += ["--fd", str(fd)]
    else:
        cmd += ["--host", host, "--port", str(port)]
    return cmd


def metrics_targets(host: str, port: int, replicas: int,
                    reuse_port: bool) -> list[tuple[int, str]]:
    """(replica_index, /metrics URL) for each replica. Under SO_REUSEPORT every
    entry points at the one shared port (see the module docstring caveat)."""
    scrape_host = "127.0.0.1" if host in ("0.0.0.0", "") else host
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


def aggregate_metrics(targets: list[tuple[int, str]],
                      fetch: Callable[[str], dict] = _http_get_json) -> dict:
    """Fan out ``/metrics`` to every replica and sum into pool totals.

    ``fetch(url)`` returns a replica's parsed ``/metrics`` JSON (shape
    ``{"config": ..., "metrics": {...}}``, or a bare metrics dict). A replica
    that can't be reached is reported with ``ok: false`` and skipped from the
    totals rather than failing the whole aggregation.
    """
    replicas: list[dict] = []
    totals = {k: 0 for k in AGG_KEYS}
    for idx, url in targets:
        entry: dict = {"replica": idx, "url": url}
        try:
            data = fetch(url)
            metrics = data.get("metrics", data) if isinstance(data, dict) else {}
            entry["ok"] = True
            entry["metrics"] = metrics
            for k in AGG_KEYS:
                v = metrics.get(k)
                if isinstance(v, (int, float)) and not isinstance(v, bool):
                    totals[k] += v
        except Exception as exc:  # noqa: BLE001 - one bad replica must not break the rest
            entry["ok"] = False
            entry["error"] = str(exc)
        replicas.append(entry)
    return {"replicas": replicas, "totals": totals}


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
                 clock: Callable[[], float] = time.monotonic):
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
        self._ports = serving_ports(port, replicas, self.reuse_port)
        self.replicas = [_Replica(index=i, port=self._ports[i])
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
        kwargs: dict = {"env": env}
        fd = None
        if self.reuse_port:
            r.sock = self._make_reuse_socket(r.port)
            fd = r.sock.fileno()
            kwargs["pass_fds"] = (fd,)
        cmd = replica_command(r.port, self.reuse_port, host=self.host, fd=fd)
        logger.info("replica %d: %s (threads/replica=%s)",
                    r.index, " ".join(cmd), env["TTS_TORCH_THREADS"])
        r.proc = self._spawn(cmd, **kwargs)
        r.started_at = self._clock()
        r.next_restart_at = 0.0
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
# Aggregated-metrics HTTP endpoint (stdlib only)
# ---------------------------------------------------------------------------
def make_metrics_server(host: str, metrics_port: int,
                        targets: list[tuple[int, str]]) -> ThreadingHTTPServer:
    """A tiny HTTP server that answers GET /metrics with the summed pool view."""

    class _Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            body = json.dumps(aggregate_metrics(targets)).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):  # silence default stderr access log
            pass

    return ThreadingHTTPServer((host, metrics_port), _Handler)


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
    reuse = ap.add_mutually_exclusive_group()
    reuse.add_argument("--reuse-port", dest="reuse_port", action="store_true",
                       default=None, help="force SO_REUSEPORT shared port (Linux)")
    reuse.add_argument("--no-reuse-port", dest="reuse_port", action="store_false",
                       help="force sequential distinct ports")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    sup = ReplicaSupervisor(replicas=args.replicas, port=args.port,
                            host=args.host, reuse_port=args.reuse_port,
                            cores=args.cores)
    metrics_port = args.metrics_port if args.metrics_port is not None else args.port + 1000
    targets = metrics_targets(args.host, args.port, args.replicas, sup.reuse_port)
    server = make_metrics_server(args.host, metrics_port, targets)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    logger.info("aggregated metrics on http://%s:%d/metrics", args.host, metrics_port)

    try:
        sup.run()
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
