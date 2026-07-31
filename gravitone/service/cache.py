"""Bounded synthesis-result cache with single-flight.

Nothing used to cache synthesis: an identical (voice, text, settings) request
re-rendered from scratch every time, and N identical CONCURRENT requests each
took a worker permit to compute the same bytes. On a CPU-only Arm box that is
the difference between an instant demo replay and another full render, and it
is the cheapest protection the admission queue can get during a demo or a load
test.

Two mechanisms, one object:

* **LRU cache** — byte-budgeted (``TTS_CACHE_BYTES``), evicting least-recently
  used first. The caller owns the key; this module never guesses request
  identity (see ``service.app._cache_key``, which folds in the resolved voice
  id AND a fingerprint of the voice's safetensors so a re-cloned voice cannot
  serve stale audio).
* **Single-flight** — while one request is synthesizing a key, later requests
  for the SAME key await that one result instead of taking their own permit.

Scope, stated plainly: this cache is **per process**. The service runs as N
single-worker replicas (``service/replicas.py``), so each replica has its own
cache and its own single-flight registry — a hit in one is not a hit in
another, and the effective memory cost is ``TTS_CACHE_BYTES`` × replicas.
Nothing here is persisted; a restart starts cold. That is deliberate: the value
is protecting the queue from repeated identical renders inside a process, not
being a CDN.

Threading: every entry point is called from the FastAPI event loop and does no
blocking work, so the state needs no lock — but it is NOT safe to call from a
worker thread.

**Two shapes of entry, one mechanism.** ``CachedAudio`` is a WAV for the HTTP
synthesis routes; ``CachedPcm`` is raw PCM at a wire rate, for the conversation
socket's pre-rendered turn openers (service/convai.py). They are stored in
separate cache instances and never mix in one keyspace — this object only ever
needs an entry to report its ``nbytes``, so the byte budget, the LRU order and
the single-flight are shared code rather than copied code.
"""
from __future__ import annotations

import asyncio
from collections import OrderedDict
from dataclasses import dataclass
from typing import Awaitable, Callable, Generic, Hashable, Protocol, TypeVar


class Cacheable(Protocol):
    """The only thing this cache needs to know about what it is holding."""

    @property
    def nbytes(self) -> int: ...


# Whatever a given cache instance holds, it hands back the same type: a cache of
# openers never returns a WAV to a caller that asked for PCM.
E = TypeVar("E", bound=Cacheable)


@dataclass(frozen=True)
class CachedAudio:
    """One cacheable synthesis result: the native-rate WAV plus what the
    response headers need to stay truthful on a hit."""
    wav_bytes: bytes
    sample_rate: int
    audio_seconds: float
    segments: int = 1

    @property
    def nbytes(self) -> int:
        return len(self.wav_bytes)


@dataclass(frozen=True)
class CachedPcm:
    """Raw PCM16 mono at a conversation's wire rate, ready to put on the socket.

    Stored rather than a WAV because the conversation path never wants a
    container: the bytes here are handed straight to ``_send_audio``, so a hit
    costs a base64 encode and nothing else.
    """
    pcm: bytes
    sample_rate: int

    @property
    def nbytes(self) -> int:
        return len(self.pcm)

    @property
    def audio_seconds(self) -> float:
        return round(len(self.pcm) / 2 / max(1, self.sample_rate), 3)


class _Flight(Generic[E]):
    """The in-flight state one leader shares with its followers.

    Exactly one of ``value`` / ``error`` is set before ``event`` fires, unless
    the leader was CANCELLED (client hung up) — then both stay None and the
    followers elect a new leader rather than inheriting a cancellation that was
    never theirs.
    """

    __slots__ = ("event", "value", "error")

    def __init__(self) -> None:
        self.event = asyncio.Event()
        self.value: E | None = None
        self.error: BaseException | None = None


class SynthCache(Generic[E]):
    def __init__(self, max_bytes: int) -> None:
        self._max_bytes = max(0, int(max_bytes))
        self._entries: "OrderedDict[Hashable, E]" = OrderedDict()
        self._bytes = 0
        self._inflight: dict[Hashable, "_Flight[E]"] = {}
        self.hits = 0
        self.misses = 0
        self.evictions = 0
        self.collapsed = 0  # requests served by someone else's in-flight render
        self.bypassed = 0   # requests that asked to skip the cache entirely

    # -- configuration ----------------------------------------------------
    @property
    def enabled(self) -> bool:
        return self._max_bytes > 0

    def resize(self, max_bytes: int) -> None:
        """Change the byte budget (evicting immediately if it shrank)."""
        self._max_bytes = max(0, int(max_bytes))
        if not self.enabled:
            self._entries.clear()
            self._bytes = 0
            return
        self._evict()

    def clear(self) -> None:
        self._entries.clear()
        self._bytes = 0
        self.hits = self.misses = self.evictions = self.collapsed = 0
        self.bypassed = 0

    def note_bypass(self) -> None:
        """Record a request that skipped the cache on purpose (``Cache-Control:
        no-store`` / ``X-Gravitone-Cache: bypass``).

        The caller does the bypassing — this object never sees the request — so
        the count would otherwise be invisible. It matters because it is how an
        operator can tell "the cache is doing nothing" (a benchmark run, or a
        client that disabled it) apart from "the cache is missing constantly".
        """
        self.bypassed += 1

    def stats(self) -> dict:
        return {
            "enabled": self.enabled,
            "entries": len(self._entries),
            "bytes": self._bytes,
            "max_bytes": self._max_bytes,
            "hits": self.hits,
            "misses": self.misses,
            "evictions": self.evictions,
            "collapsed": self.collapsed,
            "bypassed": self.bypassed,
            "in_flight": len(self._inflight),
        }

    # -- storage ----------------------------------------------------------
    def get(self, key: Hashable) -> E | None:
        entry = self._entries.get(key)
        if entry is None:
            return None
        self._entries.move_to_end(key)  # most-recently-used
        return entry

    def put(self, key: Hashable, value: E) -> None:
        if not self.enabled or value.nbytes > self._max_bytes:
            # An entry larger than the whole budget would evict everything and
            # then itself; never admit it.
            return
        old = self._entries.pop(key, None)
        if old is not None:
            self._bytes -= old.nbytes
        self._entries[key] = value
        self._bytes += value.nbytes
        self._evict()

    def _evict(self) -> None:
        while self._bytes > self._max_bytes and self._entries:
            _, evicted = self._entries.popitem(last=False)  # least recently used
            self._bytes -= evicted.nbytes
            self.evictions += 1

    # -- single-flight ----------------------------------------------------
    async def get_or_synthesize(
        self, key: Hashable,
        produce: Callable[[], Awaitable[E]],
    ) -> tuple[E, bool]:
        """Return ``(audio, was_cached)``, synthesizing at most once per key.

        ``was_cached`` is True both for a stored hit and for a request that
        collapsed onto someone else's in-flight render — in either case this
        request performed no synthesis and took no worker permit.

        The leader ALWAYS resolves its flight (value, error, or "gone") in a
        ``finally``, so a follower can never wait forever.
        """
        if not self.enabled:
            # Disabled means disabled: no storage, no collapsing, no surprise
            # coupling between two callers' failures.
            return await produce(), False

        while True:
            entry = self.get(key)
            if entry is not None:
                self.hits += 1
                return entry, True

            flight = self._inflight.get(key)
            if flight is None:
                self.misses += 1
                flight = _Flight()
                self._inflight[key] = flight
                try:
                    value = await produce()
                except asyncio.CancelledError:
                    # The leader's caller hung up. Its followers didn't — leave
                    # value/error unset so they elect a new leader.
                    raise
                except BaseException as exc:  # noqa: BLE001 - shared verbatim
                    flight.error = exc
                    raise
                else:
                    flight.value = value
                    self.put(key, value)
                    return value, False
                finally:
                    self._inflight.pop(key, None)
                    flight.event.set()

            # Follower: wait for the leader instead of synthesizing again.
            await flight.event.wait()
            if flight.value is not None:
                self.collapsed += 1
                return flight.value, True
            if flight.error is not None:
                raise flight.error
            # Leader was cancelled — loop and become the leader ourselves.
