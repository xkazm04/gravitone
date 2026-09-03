"""Per-IP budgets — the one limiter every public compute surface shares.

Two surfaces on this service spend real CPU for a caller who has proven
nothing: the hero demo (clone a stranger's voice, render a line) and public
re-perform (fork a shared take). Both were named as needing a limiter, and
both were going to grow one of their own. This is that limiter, written once.

Shape: FIXED WINDOW plus a BURST sub-window.

  * the window ("60 requests per 60s") is the budget an operator reasons about;
  * the burst ("at most 5 in any one second") is what stops a scripted client
    from spending the whole window in a single breath and leaving the box
    unusable for 59 seconds.

A fixed window is deliberate over a sliding log: a sliding log keeps one
timestamp per request, which is unbounded memory per caller, and this service
runs on a small Arm box. Two integers and two floats per caller is the whole
cost, and the boundary effect a fixed window is criticised for (up to 2x the
budget across a window seam) is exactly what the burst sub-window bounds.

Memory is BOUNDED: an LRU of at most `max_keys` callers. A limiter that
remembers every IP that ever knocked is itself the denial of service. Evicting
the least-recently-seen caller means the only thing a flood of one-shot IPs can
do is forget an idle caller's count — never grow the process.

TIME comes from `time.monotonic`, never the wall clock: an NTP step (or a
laptop resuming from sleep) must not hand out a free window or wedge one shut.
The clock is INJECTABLE so the tests control it and never sleep.

CLIENT IDENTITY is the direct peer by default. `X-Forwarded-For` is honoured
ONLY when `TTS_TRUST_PROXY` is on, because any client can send that header: on
a directly-exposed service, trusting it means every caller picks their own
bucket and the limiter is decoration. Turn it on when — and only when — a
reverse proxy you control is the only thing that can reach this port.

Which entry of that header is the caller is NOT "the first one": a client can
send its own `X-Forwarded-For` and every honest proxy APPENDS to it, so the
leftmost entry is caller-chosen text. We read the entry `TTS_TRUSTED_HOPS`
(default 1) from the RIGHT — the address the last proxy we trust actually
observed. One hop is the shipped topology (the studio relay, or
`replicas.py`'s `--router`); raise it by one for each additional proxy in
front (a CDN, an ingress) and by no more, because every hop you claim is one
more entry a caller can forge.

MULTI-PROCESS TRUTH. The service ships as N single-worker processes
(`service/replicas.py`), and an in-memory counter in one process counts
nothing that happened in the other N-1. Left alone, "60 per minute" is
60 x N per minute for the pool and the 429 body states a number that was never
enforced. So a budget can be SHARED across the replicas through a small file:

  * each process still counts locally (the hot path is unchanged: one dict
    lookup under a `threading.Lock`);
  * it just may not spend more than it has CLAIMED. A claim is a LEASE — a
    few requests at once — taken from the pool's window budget under
    `atomicio.file_lock`, so the file is touched at most once per `lease`
    ALLOWED requests per caller per process, and never at all once the pool
    budget is gone (the flood path, which is the one that must stay cheap).
  * the cost of leasing is a small UNDER-count, never an over-count: a
    process that still holds part of a lease when the window rolls loses it,
    so the pool allows between `limit - N*(lease-1)` and `limit` per window.
    Over-counting is what a limiter must never do; leaving a couple of
    requests unspent is a rounding error on a demo budget.

Shared mode is ON when `TTS_REPLICAS > 1` (the launcher exports it) and can be
forced either way with `TTS_RATELIMIT_SHARED=1|0`. In single-process mode
nothing touches the disk and the limiter is byte-for-byte the old one. The
window clock for the shared file is `time.monotonic`, which is machine-wide on
every platform we ship — the replicas are always the same box, since they
share this file and, under SO_REUSEPORT, one socket.

What stays PER PROCESS even in shared mode: the burst sub-window. It is a
1-second shaping rule, not the budget, and paying a file lock per second per
caller to make it exact would cost more than it protects. The pool can
therefore see up to N bursts in one second — bounded, always, by the shared
window budget. `RateLimiter.describe()` says exactly this, and it is what the
429 body quotes: a caller is never told a number the deployment does not
actually enforce.
"""
from __future__ import annotations

import json
import logging
import math
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from fastapi import HTTPException, Request

from service.atomicio import atomic_write_text, file_lock
from service.config import SETTINGS

logger = logging.getLogger("gravitone")

# Read once at import, but kept as a MODULE attribute rather than a constant
# folded into the dependencies below, so a deployment can flip it in a wrapper
# (and a test can flip it back) without rebuilding every budget.
TRUST_PROXY: bool = os.environ.get("TTS_TRUST_PROXY", "0").lower() in (
    "1", "true", "yes", "on")

# How many proxies in front of this service are OURS. Only meaningful with
# TRUST_PROXY on; see the module docstring for why it is counted from the right.
TRUSTED_HOPS: int = max(1, int(os.environ.get("TTS_TRUSTED_HOPS", "1") or 1))

DEFAULT_BURST_WINDOW_S = 1.0
DEFAULT_MAX_KEYS = 4096
MAX_KEY_CHARS = 64  # an address, not a caller-chosen string of any length

_TRUE = ("1", "true", "yes", "on")


def replica_count() -> int:
    """How many processes share every budget in this deployment.

    Exported by `replicas.py` when it spawns the pool; 1 (an honest default)
    for a plain `uvicorn service.app:app`. Read at call time so a test can set
    it without re-importing the module.
    """
    raw = os.environ.get("TTS_REPLICAS", "") or "1"
    try:
        return max(1, int(raw))
    except ValueError:
        return 1


def shared_enabled() -> bool:
    """Whether budgets are counted across processes (see the docstring)."""
    flag = os.environ.get("TTS_RATELIMIT_SHARED", "auto").strip().lower()
    if flag in _TRUE:
        return True
    if flag in ("0", "false", "no", "off"):
        return False
    return replica_count() > 1


def shared_dir() -> Path:
    """Where the shared window files live — beside the other runtime state."""
    override = os.environ.get("TTS_RATELIMIT_DIR", "").strip()
    if override:
        return Path(override)
    return Path(SETTINGS.voices_dir).parent / "ratelimit"


@dataclass(frozen=True)
class Decision:
    """What the limiter decided, and what to tell the caller."""
    allowed: bool
    retry_after: int  # seconds, >= 1 when denied, 0 when allowed
    remaining: int    # requests left in the current window
    reason: str       # "" | "window" | "burst"


class SharedWindow:
    """The pool's window budget for one named limiter, on disk.

    One JSON file per budget: ``{key: [window_start, claimed]}``. Every
    mutation is a read-modify-write, so it is taken under `atomicio.file_lock`
    (the `O_CREAT|O_EXCL` cross-process mutex) and written with
    `atomic_write_text` — a `threading.Lock` here would serialize one replica
    against itself and nothing else, which is the exact bug this class exists
    to fix.

    Callers claim LEASES rather than single requests, so the lock is taken once
    per `lease` allowed requests rather than once per request. A caller whose
    pool budget is exhausted is told so once and then refused from memory until
    the window rolls, which keeps the flood path free of disk entirely.

    DEGRADED, NOT DEAD: if the file cannot be read or written (full disk, a
    wedged lock) the claim is granted from the local budget and the failure is
    logged and counted. A limiter that 500s the service because a telemetry-
    sized file is unwritable would be a worse outage than the one it prevents.
    """

    def __init__(self, name: str, limit: int, window_s: float, *,
                 max_keys: int = DEFAULT_MAX_KEYS,
                 dir_getter=shared_dir) -> None:
        self.name = name
        self.limit = max(1, int(limit))
        self.window_s = max(0.001, float(window_s))
        self.max_keys = max(1, int(max_keys))
        self._dir = dir_getter
        self.claims = 0      # how many times we took the cross-process lock
        self.degraded = 0    # how many claims fell back to the local budget

    @property
    def path(self) -> Path:
        return self._dir() / f"{self.name}.window.json"

    @property
    def lock_path(self) -> Path:
        return self._dir() / f".{self.name}.window.lock"

    def _read(self) -> dict:
        try:
            data = json.loads(self.path.read_text("utf-8"))
        except FileNotFoundError:
            return {}
        except (OSError, json.JSONDecodeError):
            logger.warning("shared rate-limit window %s unreadable; "
                           "starting a fresh window", self.path)
            return {}
        return data if isinstance(data, dict) else {}

    def claim(self, key: str, now: float, want: int) -> tuple[float, int]:
        """Take up to `want` requests out of `key`'s pool budget.

        Returns ``(window_start, granted)``. ``granted == 0`` means the pool
        budget for this window is spent; ``window_start`` is the pool's window,
        which the caller adopts so every replica's window rolls together.
        """
        want = max(1, int(want))
        try:
            with file_lock(self.lock_path):
                data = self._read()
                entry = data.get(key)
                if (not isinstance(entry, list) or len(entry) != 2
                        or not all(isinstance(v, (int, float)) for v in entry)
                        or now - float(entry[0]) >= self.window_s
                        or now < float(entry[0])):
                    entry = [now, 0]
                start, claimed = float(entry[0]), int(entry[1])
                granted = max(0, min(want, self.limit - claimed))
                data.pop(key, None)   # re-insert last: dict order is the LRU
                data[key] = [start, claimed + granted]
                # Bounded like the in-memory limiter, and for the same reason:
                # a file that remembers every address that ever knocked is
                # itself the denial of service.
                while len(data) > self.max_keys:
                    data.pop(next(iter(data)))
                atomic_write_text(self.path, json.dumps(data))
                self.claims += 1
                return start, granted
        except (OSError, TimeoutError) as exc:  # noqa: BLE001 - degrade loudly
            self.degraded += 1
            # Log the NAME, never `self.path` — resolving the path is one of
            # the things that can be broken here, and a logging call that
            # re-raises would turn a degraded limiter into a 500.
            logger.warning("shared rate-limit window for budget '%s' is "
                           "unavailable (%s); counting per process this window",
                           self.name, exc)
            return now, want

    def reset(self) -> None:
        """Forget the pool's counts. For tests and an operator's rescue path."""
        try:
            self.path.unlink(missing_ok=True)
        except OSError:  # pragma: no cover - a rescue path may not be writable
            pass


class RateLimiter:
    """Fixed-window + burst counter over a bounded LRU of callers.

    Thread-safe: the service answers on a threadpool, and two requests from the
    same IP land on two threads routinely.

    With a `SharedWindow` attached the window budget is the POOL's, spent in
    leases (see the module docstring); without one it is this process's, which
    is the whole truth only when this process is the whole service.
    """

    def __init__(self, limit: int, window_s: float, burst: int | None = None,
                 *, max_keys: int = DEFAULT_MAX_KEYS,
                 burst_window_s: float = DEFAULT_BURST_WINDOW_S,
                 shared: "SharedWindow | None" = None,
                 replicas: int | None = None,
                 clock=time.monotonic) -> None:
        self.limit = max(1, int(limit))
        self.window_s = max(0.001, float(window_s))
        # Default burst: a quarter of the window's budget, at least one. Small
        # budgets (limit <= 4) therefore burst at 1, which is the honest
        # reading of "5 renders per 5 minutes" — not five renders at once.
        self.burst = max(1, int(burst if burst is not None else math.ceil(self.limit / 4)))
        self.burst = min(self.burst, self.limit)
        self.burst_window_s = max(0.001, float(burst_window_s))
        self.max_keys = max(1, int(max_keys))
        self.shared = shared
        self.replicas = max(1, int(replicas if replicas is not None
                                   else replica_count()))
        # A lease is the unit this process buys from the pool. Small enough
        # that an idle replica cannot sit on a meaningful share of the budget,
        # large enough that the file lock is not a per-request cost. Never
        # wider than the burst, or a lease could not be spent in one window.
        self.lease = max(1, min(self.burst,
                                math.ceil(self.limit / (4 * self.replicas))))
        self._clock = clock
        self._lock = threading.Lock()
        # key -> [window_start, window_count, burst_start, burst_count,
        #         leased, pool_exhausted]
        # Insertion-ordered and re-ordered on touch: the FIRST item is always
        # the least recently seen caller, which is the one eviction takes.
        self._keys: "dict[str, list[float]]" = {}

    # -- honesty -----------------------------------------------------------
    @property
    def effective_limit(self) -> int:
        """What the DEPLOYMENT allows one address per window, not what this
        process allows it. The two differ whenever N replicas each keep their
        own count."""
        if self.shared is not None or self.replicas == 1:
            return self.limit
        return self.limit * self.replicas

    def describe(self) -> str:
        """One sentence a 429 can quote without lying about the topology."""
        base = (f"{self.limit} request(s) per {int(self.window_s)}s "
                f"from one address")
        if self.shared is not None:
            return (f"{base}, counted across all {self.replicas} replica(s) "
                    f"(burst {self.burst} per {self.burst_window_s:g}s "
                    f"per replica)")
        if self.replicas > 1:
            return (f"{base} PER REPLICA — with {self.replicas} replicas the "
                    f"pool allows up to {self.effective_limit} "
                    f"(burst {self.burst} per {self.burst_window_s:g}s)")
        return f"{base} (burst {self.burst} per {self.burst_window_s:g}s)"

    def reset(self) -> None:
        """Forget every caller. For tests and for an operator's rescue path."""
        with self._lock:
            self._keys.clear()
        if self.shared is not None:
            self.shared.reset()

    def _allowance(self, key: str, entry: list, now: float) -> float:
        """How many requests this process may spend for `key` this window.

        Without a shared window that is simply the whole budget. With one it is
        what we have leased, topped up from the pool when we run out — and NOT
        topped up again once the pool has said no, so a caller hammering an
        exhausted budget costs us nothing but a dict lookup.
        """
        if self.shared is None:
            return float(self.limit)
        if entry[1] < entry[4] or entry[5]:
            return entry[4]
        start, granted = self.shared.claim(key, now, self.lease)
        if start > entry[0]:
            # The pool's window rolled ahead of ours (this process was idle
            # across a boundary): adopt it, so every replica agrees on when
            # this caller's window ends.
            entry[0], entry[1], entry[4], entry[5] = start, 0.0, 0.0, 0.0
        if granted <= 0:
            entry[5] = 1.0
        entry[4] += granted
        return entry[4]

    def check(self, key: str) -> Decision:
        """Count one request against `key` and say whether it may proceed.

        A DENIED request is not counted. Counting refusals would let a client
        that ignores Retry-After hold its own window shut forever — the point
        of a budget is to shape traffic, not to punish a retry loop into a
        permanent ban nobody asked for.
        """
        now = float(self._clock())
        with self._lock:
            entry = self._keys.pop(key, None)
            if entry is None or now - entry[0] >= self.window_s or now < entry[0]:
                # `now < entry[0]` cannot happen on a monotonic clock; it is the
                # safe reading if someone injects a clock that goes backwards.
                entry = [now, 0.0, now, 0.0, 0.0, 0.0]
            if now - entry[2] >= self.burst_window_s or now < entry[2]:
                entry[2], entry[3] = now, 0.0

            allowance = self._allowance(key, entry, now)

            if entry[1] >= allowance:
                retry = max(1, math.ceil(self.window_s - (now - entry[0])))
                decision = Decision(False, retry, 0, "window")
            elif entry[3] >= self.burst:
                retry = max(1, math.ceil(self.burst_window_s - (now - entry[2])))
                decision = Decision(False, retry,
                                    int(self.limit - entry[1]), "burst")
            else:
                entry[1] += 1
                entry[3] += 1
                decision = Decision(True, 0, int(self.limit - entry[1]), "")

            self._keys[key] = entry  # re-inserted = most recently seen
            while len(self._keys) > self.max_keys:
                self._keys.pop(next(iter(self._keys)))
            return decision


def client_ip(request: Request, trust_proxy: bool | None = None,
              hops: int | None = None) -> str:
    """Who this request is FROM, for budgeting purposes.

    The direct peer, unless proxy trust is on — see the module docstring for why
    that is not the default. An address the server cannot determine at all
    (ASGI transports are not required to report one) budgets as "unknown",
    which shares one bucket: unattributable traffic is still traffic.

    With trust on we take the `TTS_TRUSTED_HOPS`-th entry FROM THE RIGHT, not
    the leftmost: every proxy appends, so the rightmost entries were written by
    the hops nearest us — the ones we actually trust — while the leftmost is
    whatever the client typed. Reading the leftmost is how a limiter behind a
    proxy gets defeated by one header. If the chain is shorter than the hops we
    claim, the oldest entry we have is the best available answer.
    """
    trust = TRUST_PROXY if trust_proxy is None else trust_proxy
    if trust:
        forwarded = request.headers.get("x-forwarded-for", "")
        chain = [part.strip() for part in forwarded.split(",") if part.strip()]
        if chain:
            n = max(1, int(TRUSTED_HOPS if hops is None else hops))
            return chain[max(0, len(chain) - n)][:MAX_KEY_CHARS]
    peer = getattr(request, "client", None)
    host = getattr(peer, "host", "") or ""
    return (host or "unknown")[:MAX_KEY_CHARS]


# Every budget minted in this process, by name. Not bookkeeping for its own
# sake: a test resets them between cases, and an operator can read the live
# shape of the limits a build actually applies.
BUDGETS: "dict[str, RateLimiter]" = {}


def reset_all() -> None:
    for limiter in BUDGETS.values():
        limiter.reset()


def per_ip_budget(name: str, limit: int, window_s: float,
                  burst: int | None = None, *,
                  methods: "tuple[str, ...] | None" = None,
                  shared: bool | None = None,
                  replicas: int | None = None,
                  clock=time.monotonic):
    """A FastAPI dependency that spends one unit of a named per-IP budget.

    Use it as `dependencies=[Depends(per_ip_budget("demo", 60, 60))]` on a
    route, or on `include_router` for a whole surface. `methods` narrows it to
    the verbs that actually cost something — a budget on a router would
    otherwise charge the reads too, and listing voices is not the abuse
    surface that cloning one is.

    The refusal is NAMED and carries Retry-After, so a client is told what to
    do rather than left to guess at a bare 429.

    `shared` defaults to the deployment's answer (`shared_enabled()`): with N
    replicas the budget is counted across them through a file, with one process
    it is counted in memory and nothing touches the disk.
    """
    n = replica_count() if replicas is None else max(1, int(replicas))
    use_shared = shared_enabled() if shared is None else bool(shared)
    window = SharedWindow(name, limit, window_s) if use_shared else None
    limiter = RateLimiter(limit, window_s, burst, shared=window, replicas=n,
                          clock=clock)
    BUDGETS[name] = limiter
    allowed_methods = tuple(m.upper() for m in methods) if methods else None
    def dependency(request: Request) -> None:
        # The test harness drives thousands of requests from ONE fake client
        # address — exactly the shape these budgets exist to refuse — so a
        # heavy suite would 429 itself on infrastructure it is not testing.
        # Read per-request so test_ratelimit can drop the flag and prove the
        # dependency itself. Never set this in a deployment.
        if os.environ.get("GRAVITONE_RATELIMIT_TEST_BYPASS", "0") == "1":
            return
        if allowed_methods is not None and request.method.upper() not in allowed_methods:
            return
        decision = limiter.check(client_ip(request))
        if decision.allowed:
            return
        raise HTTPException(
            status_code=429,
            detail=(f"rate-limited: the '{name}' budget is {limiter.describe()}. "
                    f"Retry in {decision.retry_after}s."),
            headers={"Retry-After": str(decision.retry_after)},
        )

    dependency.limiter = limiter  # type: ignore[attr-defined]
    dependency.budget_name = name  # type: ignore[attr-defined]
    return dependency
