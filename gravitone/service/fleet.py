"""The fleet's own queue depth — what the autoscaler must read instead of one pod's.

The KEDA scaler polls ``/metrics`` through the chart's ClusterIP Service, and a
ClusterIP hands each poll to ONE pod. ``metrics.queued`` on that answer is that
pod's admission queue: real, and arbitrary. KEDA then applies it as the fleet's
per-replica average, so a fleet of eight with one hot pod scales on a coin flip
(0 or N, depending on which pod the balancer picked). ``values.yaml`` used to
argue the number was sound because each pod's queue is real; it is real, and it
is a sample.

This module gives ``/metrics`` a ``fleet`` block: every pod behind the headless
peers Service (``TTS_FLEET_PEERS``) is resolved, each one's ``/metrics`` is read
with a short deadline, and the additive counters are summed. The scaler reads
``fleet.queued`` — the same number from every pod it happens to ask — and KEDA's
``AverageValue`` semantics (total / replicas) then mean what the target says:
queued requests per replica.

Stdlib only, like ``service.replicas``: the pod that answers is also the pod
that serves, and this must never pull anything heavy into the request path.
Peers that do not answer inside the deadline are counted as missing, never as
zero — a fleet number that quietly drops a busy pod is the sampling bug again
with a better name.
"""
from __future__ import annotations

import json
import socket
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Callable

# The additive subset of an engine snapshot that a fleet total is allowed to
# sum. Kept small on purpose: latency percentiles do not add, and a "fleet p95"
# built by averaging would be a number with no meaning.
FLEET_KEYS = ("queued", "in_flight", "rejected_429", "received", "completed")

SCOPE_FLEET_TOTAL = "fleet_total"


def resolve_peers(host: str, port: int = 8080) -> list[str]:
    """Every pod IP the headless Service names right now, sorted and deduplicated."""
    if not host:
        return []
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror:
        return []
    return sorted({info[4][0] for info in infos})


def fetch_peer_metrics(ip: str, port: int, api_key: str, timeout: float) -> dict | None:
    """One peer's ``/metrics`` document, or None when it did not answer in time."""
    url = f"http://{ip}:{port}/metrics"
    req = urllib.request.Request(url)
    if api_key:
        req.add_header("xi-api-key", api_key)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - cluster-internal
            return json.loads(resp.read().decode("utf-8"))
    except Exception:  # timeouts, refused, malformed - all "did not answer"
        return None


def aggregate(
    peers: list[str],
    port: int,
    api_key: str,
    timeout: float = 1.0,
    fetch: Callable[[str, int, str, float], dict | None] = fetch_peer_metrics,
) -> dict:
    """Sum the additive counters over every peer that answered.

    ``pods_resolved`` is how many the address book named; ``pods_answered`` is
    how many replied inside the deadline. The two differ during a rollout or a
    partition, and the difference is reported rather than hidden: a scaler that
    sees 3 of 8 answering knows the total is a floor.
    """
    totals = {k: 0 for k in FLEET_KEYS}
    answered = 0
    if peers:
        with ThreadPoolExecutor(max_workers=min(16, len(peers))) as pool:
            docs = list(pool.map(lambda ip: fetch(ip, port, api_key, timeout), peers))
        for doc in docs:
            if not isinstance(doc, dict):
                continue
            metrics = doc.get("metrics") or {}
            if not isinstance(metrics, dict):
                continue
            answered += 1
            for k in FLEET_KEYS:
                v = metrics.get(k)
                if isinstance(v, (int, float)):
                    totals[k] += v
    return {
        "scope": SCOPE_FLEET_TOTAL,
        "pods_resolved": len(peers),
        "pods_answered": answered,
        "complete": bool(peers) and answered == len(peers),
        **totals,
    }


def snapshot(
    peers_host: str,
    port: int,
    api_key: str,
    timeout: float = 1.0,
    resolve: Callable[[str, int], list[str]] = resolve_peers,
    fetch: Callable[[str, int, str, float], dict | None] = fetch_peer_metrics,
) -> dict:
    """The ``fleet`` block for ``/metrics``: resolve, then aggregate."""
    return aggregate(resolve(peers_host, port), port, api_key, timeout, fetch)
