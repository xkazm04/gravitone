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
"""
from __future__ import annotations

import math
import os
import threading
import time
from dataclasses import dataclass

from fastapi import HTTPException, Request

# Read once at import, but kept as a MODULE attribute rather than a constant
# folded into the dependencies below, so a deployment can flip it in a wrapper
# (and a test can flip it back) without rebuilding every budget.
TRUST_PROXY: bool = os.environ.get("TTS_TRUST_PROXY", "0").lower() in (
    "1", "true", "yes", "on")

DEFAULT_BURST_WINDOW_S = 1.0
DEFAULT_MAX_KEYS = 4096
MAX_KEY_CHARS = 64  # an address, not a caller-chosen string of any length


@dataclass(frozen=True)
class Decision:
    """What the limiter decided, and what to tell the caller."""
    allowed: bool
    retry_after: int  # seconds, >= 1 when denied, 0 when allowed
    remaining: int    # requests left in the current window
    reason: str       # "" | "window" | "burst"


class RateLimiter:
    """Fixed-window + burst counter over a bounded LRU of callers.

    Thread-safe: the service answers on a threadpool, and two requests from the
    same IP land on two threads routinely.
    """

    def __init__(self, limit: int, window_s: float, burst: int | None = None,
                 *, max_keys: int = DEFAULT_MAX_KEYS,
                 burst_window_s: float = DEFAULT_BURST_WINDOW_S,
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
        self._clock = clock
        self._lock = threading.Lock()
        # key -> [window_start, window_count, burst_start, burst_count]
        # Insertion-ordered and re-ordered on touch: the FIRST item is always
        # the least recently seen caller, which is the one eviction takes.
        self._keys: "dict[str, list[float]]" = {}

    def reset(self) -> None:
        """Forget every caller. For tests and for an operator's rescue path."""
        with self._lock:
            self._keys.clear()

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
                entry = [now, 0.0, now, 0.0]
            if now - entry[2] >= self.burst_window_s or now < entry[2]:
                entry[2], entry[3] = now, 0.0

            if entry[1] >= self.limit:
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


def client_ip(request: Request, trust_proxy: bool | None = None) -> str:
    """Who this request is FROM, for budgeting purposes.

    The direct peer, unless proxy trust is on — see the module docstring for why
    that is not the default. An address the server cannot determine at all
    (ASGI transports are not required to report one) budgets as "unknown",
    which shares one bucket: unattributable traffic is still traffic.
    """
    trust = TRUST_PROXY if trust_proxy is None else trust_proxy
    if trust:
        forwarded = request.headers.get("x-forwarded-for", "")
        first = forwarded.split(",")[0].strip()
        if first:
            return first[:MAX_KEY_CHARS]
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
                  clock=time.monotonic):
    """A FastAPI dependency that spends one unit of a named per-IP budget.

    Use it as `dependencies=[Depends(per_ip_budget("demo", 60, 60))]` on a
    route, or on `include_router` for a whole surface. `methods` narrows it to
    the verbs that actually cost something — a budget on a router would
    otherwise charge the reads too, and listing voices is not the abuse
    surface that cloning one is.

    The refusal is NAMED and carries Retry-After, so a client is told what to
    do rather than left to guess at a bare 429.
    """
    limiter = RateLimiter(limit, window_s, burst, clock=clock)
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
            detail=(f"rate-limited: the '{name}' budget is {limiter.limit} request(s) "
                    f"per {int(limiter.window_s)}s from one address "
                    f"(burst {limiter.burst} per {limiter.burst_window_s:g}s). "
                    f"Retry in {decision.retry_after}s."),
            headers={"Retry-After": str(decision.retry_after)},
        )

    dependency.limiter = limiter  # type: ignore[attr-defined]
    dependency.budget_name = name  # type: ignore[attr-defined]
    return dependency
