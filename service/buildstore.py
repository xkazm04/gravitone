"""Speech as a build artifact: the identity function and the durable store.

Two things live here, and only these two:

1. **The identity of a piece of speech** — ``speech_digest``. The in-process
   synthesis cache (``service/cache.py`` + ``service.app._cache_key``) already
   computed a complete request identity, but it was a PRIVATE tuple: usable as a
   dict key inside one process and nothing else. This module turns the same idea
   into a public, sharable NAME — ``sha256:<hex>`` — that a lockfile can hold, a
   CI diff can compare and a second machine can resolve. A digest is over the
   INPUTS, so it is known before a single frame is synthesized: that is what lets
   ``If-None-Match`` answer 304 without touching a worker, and what lets
   ``POST /v1/build/plan`` say "2 of your 5000 lines changed" for free.

2. **A durable content-addressed store** — ``BuildStore``. Bytes on disk under
   their own digest, written with ``service/atomicio.py``'s discipline (atomic
   ``os.replace`` + a cross-PROCESS file lock), so the artifact survives a
   restart and is visible to every replica sharing the directory. Capped by a
   named byte budget and pruned least-recently-USED first.

DIGEST LAW
----------
``IDENTITY_VERSION`` below is the single named constant that stands for
"everything about how this service turns text into bytes". **Any** change to
text normalization, chunking/segmentation, resampling/encoding, or the model
weights MUST bump a version component (``IDENTITY_VERSION``, ``MODEL_VERSION``
or ``SEGMENTATION_VERSION``). If it does not, a lockfile that says "unchanged"
is lying: the same digest would name different audio, which is the one failure
mode a build system cannot survive. ``service/tests/test_buildstore.py`` pins a
golden fixture manifest to exact digest strings, so a silent identity change
fails loudly there rather than quietly in someone's repository.

Scope, stated plainly: no billing, no entitlements, no lockfile emission and no
zip delivery here — a digest is a name and this is where the named bytes live.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path

from service.atomicio import atomic_write_text, file_lock
from service.config import REPO_ROOT

logger = logging.getLogger("gravitone")

# --- The DIGEST LAW constants ----------------------------------------------
# Bump IDENTITY_VERSION when the SHAPE of the identity changes (a component is
# added, removed or re-ordered). Bump MODEL_VERSION when the weights or the
# engine that renders them change. Bump SEGMENTATION_VERSION when _chunk_text /
# _split_sentences / the concat discipline changes. Never edit one of those code
# paths without touching one of these three strings.
IDENTITY_VERSION = "gravitone-speech-identity/1"
MODEL_VERSION = "pocket_tts/1"
SEGMENTATION_VERSION = "sentence-coalesce/1"

# --- Named settings ---------------------------------------------------------
# Where the artifacts live and how much disk they may claim. Named here rather
# than in service/config.py because the store is the only thing that reads them
# and a setting nobody else can see is a setting nobody else can misread.
_STORE_DIR_ENV = "GRAVITONE_BUILD_STORE_DIR"
_STORE_BYTES_ENV = "GRAVITONE_BUILD_STORE_BYTES"
STORE_DIR_DEFAULT = str(REPO_ROOT / "build_store")
STORE_MAX_BYTES_DEFAULT = 512 * 1024 * 1024  # half a gig of audio, then LRU.

# How many lines ONE manifest may carry. A build is submitted through the same
# admission window as every other request, so an unbounded manifest is a way for
# one caller to hold the pool for as long as it likes.
BUILD_MANIFEST_MAX_LINES = 500

# The 404 body, by name: an absent digest is a normal, expected answer (that is
# the whole point of asking), so it says what to do about it.
AUDIO_NOT_FOUND = (
    "no audio is stored under this digest on this replica. A digest names the "
    "inputs, not a promise that they were ever rendered — render it first with "
    "POST /v1/build (or POST /v1/text-to-speech with the same inputs) and it "
    "will be stored under exactly this name."
)

BAD_DIGEST = (
    "not a speech digest: expected 'sha256:<64 hex chars>' (the value of the "
    "X-Speech-Digest header, with or without the 'sha256:' prefix)"
)

_HEX64 = re.compile(r"^[0-9a-f]{64}$")


def store_dir() -> Path:
    """The configured store root (read per call so tests can repoint it)."""
    return Path(os.environ.get(_STORE_DIR_ENV) or STORE_DIR_DEFAULT)


def store_max_bytes() -> int:
    raw = os.environ.get(_STORE_BYTES_ENV)
    if not raw:
        return STORE_MAX_BYTES_DEFAULT
    try:
        return max(0, int(raw))
    except ValueError:
        logger.warning("%s=%r is not an integer; using the default budget",
                       _STORE_BYTES_ENV, raw)
        return STORE_MAX_BYTES_DEFAULT


# --- Identity ---------------------------------------------------------------

def normalize_text(text: str) -> str:
    """The text as the digest sees it.

    Deliberately CONSERVATIVE: line-ending normalization and outer whitespace
    only. Anything cleverer (case folding, punctuation squashing, whitespace
    collapse inside the line) would let two inputs that really do render
    differently share one name — and a digest that is wrong is worse than a
    digest that is merely too strict, because "too strict" only costs a
    re-render. Changing this function is a DIGEST LAW event.
    """
    return (text or "").replace("\r\n", "\n").replace("\r", "\n").strip()


def speech_digest(*, voice_id: str, voice_fingerprint: str, text: str,
                  overrides: dict | None, frames_after_eos: int | None,
                  output_format: str, engine_version: str,
                  segmentation: str) -> str:
    """``sha256:<hex>`` — the public name of one piece of speech.

    Every component is one of the things that can change the BYTES:

      * ``voice_id`` + ``voice_fingerprint`` — the resolved voice and the
        identity of its weights (mtime+size), so a re-cloned Character does not
        answer to its old audio's name.
      * ``text`` — normalized (``normalize_text``).
      * ``overrides`` — the sampling knobs that actually reach the model.
      * ``frames_after_eos`` — the trailing-frames control.
      * ``engine_version`` — model/engine identity and the process-wide
        generation config it was rendered under.
      * ``output_format`` — format-aware BY DESIGN: ``mp3_24000_128`` and
        ``wav_24000`` are different bytes, so they must be different names or
        the store would serve an mp3 to a caller holding a wav's digest.
      * ``segmentation`` — how the text was cut into synthesis units, because
        the concat seams are audible and are part of the artifact.

    Canonical JSON (sorted keys, no whitespace, ensure_ascii) is hashed, so the
    digest depends on the VALUES and never on Python's dict ordering.
    """
    payload = {
        "v": IDENTITY_VERSION,
        "voice_id": voice_id,
        "voice_fingerprint": voice_fingerprint,
        "text": normalize_text(text),
        "overrides": sorted((str(k), v) for k, v in (overrides or {}).items()),
        "frames_after_eos": frames_after_eos,
        "engine": engine_version,
        "format": (output_format or "").strip().lower(),
        "segmentation": segmentation,
    }
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True).encode("utf-8")
    return "sha256:" + hashlib.sha256(blob).hexdigest()


def parse_digest(value: str) -> str:
    """Normalize a caller-supplied digest to its bare 64-hex form.

    Accepts ``sha256:<hex>`` or the bare hex. Raises ``ValueError`` for anything
    else — which is also the path-traversal guard: nothing that is not 64 hex
    characters ever reaches a filesystem path.
    """
    raw = (value or "").strip().lower()
    if raw.startswith("sha256:"):
        raw = raw[len("sha256:"):]
    if not _HEX64.match(raw):
        raise ValueError(BAD_DIGEST)
    return raw


def etag_matches(if_none_match: str | None, digest: str) -> bool:
    """Whether an ``If-None-Match`` header names this digest.

    Tolerates the shapes real clients send: a bare digest, a quoted ETag, a weak
    ETag, a comma-separated list, and ``*``.
    """
    if not if_none_match:
        return False
    bare = digest.split(":", 1)[-1]
    for candidate in if_none_match.split(","):
        token = candidate.strip()
        if token == "*":
            return True
        if token.startswith("W/"):
            token = token[2:].strip()
        token = token.strip('"').strip().lower()
        if token.startswith("sha256:"):
            token = token[len("sha256:"):]
        if token == bare:
            return True
    return False


# --- The store --------------------------------------------------------------

@dataclass(frozen=True)
class StoredAudio:
    """One artifact read back out of the store."""
    digest: str          # bare hex
    data: bytes
    content_type: str
    audio_seconds: float
    sample_rate: int


class BuildStore:
    """Durable content-addressed audio, capped and LRU-pruned.

    Layout: ``<root>/<aa>/<digest>.bin`` plus a ``<digest>.json`` sidecar
    carrying what a response needs to stay truthful (content type, duration,
    sample rate). Sharded by the first two hex characters so a store with a
    hundred thousand artifacts does not become one directory a filesystem hates.

    Writes go through ``atomicio``: the sidecar and the payload are each written
    to a per-process temp file and ``os.replace``d into position, under a
    cross-process ``file_lock`` — the service ships as N single-worker replica
    PROCESSES, so an in-process lock would serialize nothing between them.
    Readers take no lock: ``os.replace`` means a reader sees the complete old
    file or the complete new one, never a torn one.

    Reads TOUCH the payload's mtime, which is what makes the prune order
    least-recently-USED rather than least-recently-written: the digest a team
    keeps fetching is the one the store keeps.
    """

    def __init__(self, root: Path | str | None = None,
                 max_bytes: int | None = None) -> None:
        self._root = Path(root) if root is not None else None
        self._max_bytes = max_bytes

    # -- configuration ----------------------------------------------------
    @property
    def root(self) -> Path:
        return self._root if self._root is not None else store_dir()

    @property
    def max_bytes(self) -> int:
        return self._max_bytes if self._max_bytes is not None else store_max_bytes()

    @property
    def enabled(self) -> bool:
        return self.max_bytes > 0

    # -- paths ------------------------------------------------------------
    def _paths(self, digest: str) -> tuple[Path, Path]:
        bare = parse_digest(digest)
        shard = self.root / bare[:2]
        return shard / f"{bare}.bin", shard / f"{bare}.json"

    # -- reads ------------------------------------------------------------
    def has(self, digest: str) -> bool:
        try:
            payload, _meta = self._paths(digest)
        except ValueError:
            return False
        return payload.is_file()

    def head(self, digest: str) -> StoredAudio | None:
        """Metadata only — the HEAD request's answer, no payload read."""
        return self._read(digest, with_data=False)

    def get(self, digest: str) -> StoredAudio | None:
        return self._read(digest, with_data=True)

    def _read(self, digest: str, *, with_data: bool) -> StoredAudio | None:
        payload, meta = self._paths(digest)
        try:
            data = payload.read_bytes() if with_data else b""
        except OSError:
            return None
        try:
            info = json.loads(meta.read_text("utf-8"))
        except (OSError, ValueError):
            info = {}
        # LRU is about USE. Touching here is best-effort: a store on a read-only
        # mount still serves, it just prunes by write order.
        try:
            os.utime(payload, None)
        except OSError:
            pass
        if not with_data:
            try:
                size = payload.stat().st_size
            except OSError:
                return None
            info.setdefault("bytes", size)
        return StoredAudio(
            digest=parse_digest(digest), data=data,
            content_type=str(info.get("content_type") or "application/octet-stream"),
            audio_seconds=float(info.get("audio_seconds") or 0.0),
            sample_rate=int(info.get("sample_rate") or 0),
        )

    def size_of(self, digest: str) -> int:
        payload, _meta = self._paths(digest)
        try:
            return payload.stat().st_size
        except OSError:
            return 0

    # -- writes -----------------------------------------------------------
    def put(self, digest: str, data: bytes, *, content_type: str,
            audio_seconds: float = 0.0, sample_rate: int = 0) -> bool:
        """Store ``data`` under ``digest``. Returns whether it is now stored.

        Blocking (disk + a lock) — callers on the event loop must offload it.
        An artifact larger than the whole budget is REFUSED rather than admitted
        and immediately pruned; a disabled store (budget 0) stores nothing. Both
        are silent no-ops for the caller: the audio was still rendered and is
        still being served, only the durable copy is declined.
        """
        if not self.enabled or not data or len(data) > self.max_bytes:
            return False
        payload, meta = self._paths(digest)
        info = {
            "digest": payload.stem,
            "content_type": content_type,
            "audio_seconds": round(float(audio_seconds), 3),
            "sample_rate": int(sample_rate),
            "bytes": len(data),
            "stored_at": round(time.time(), 3),
            "identity_version": IDENTITY_VERSION,
        }
        try:
            with file_lock(self.root / ".store.lock"):
                payload.parent.mkdir(parents=True, exist_ok=True)
                tmp = payload.with_name(f"{payload.name}.{os.getpid()}.tmp")
                try:
                    tmp.write_bytes(data)
                    os.replace(tmp, payload)
                finally:
                    if tmp.exists():
                        tmp.unlink(missing_ok=True)
                atomic_write_text(meta, json.dumps(info, sort_keys=True))
                self._prune_locked()
        except (OSError, TimeoutError) as exc:
            # A full disk or a stuck lock must never fail a synthesis that has
            # already succeeded: the caller's audio is in the response either way.
            logger.warning("build store write failed for %s: %s", payload.name, exc)
            return False
        return True

    # -- retention --------------------------------------------------------
    def entries(self) -> list[tuple[float, int, Path]]:
        """(mtime, size, payload path) for every stored artifact."""
        out: list[tuple[float, int, Path]] = []
        root = self.root
        if not root.is_dir():
            return out
        for payload in root.glob("*/*.bin"):
            try:
                st = payload.stat()
            except OSError:
                continue
            out.append((st.st_mtime, st.st_size, payload))
        return out

    def total_bytes(self) -> int:
        return sum(size for _mtime, size, _p in self.entries())

    def prune(self) -> int:
        """Evict least-recently-used artifacts until the budget is met."""
        try:
            with file_lock(self.root / ".store.lock"):
                return self._prune_locked()
        except (OSError, TimeoutError) as exc:
            logger.warning("build store prune skipped: %s", exc)
            return 0

    def _prune_locked(self) -> int:
        budget = self.max_bytes
        items = sorted(self.entries())  # oldest mtime first = least recently used
        total = sum(size for _m, size, _p in items)
        removed = 0
        for _mtime, size, payload in items:
            if total <= budget:
                break
            meta = payload.with_suffix(".json")
            try:
                payload.unlink()
            except OSError:
                continue
            try:
                meta.unlink(missing_ok=True)
            except OSError:
                pass
            total -= size
            removed += 1
        return removed

    def stats(self) -> dict:
        items = self.entries()
        return {
            "enabled": self.enabled,
            "root": str(self.root),
            "entries": len(items),
            "bytes": sum(size for _m, size, _p in items),
            "max_bytes": self.max_bytes,
        }


# The process-wide store the routes use. A plain module-level instance (not a
# singleton behind a getter) so a test can repoint `service.app.BUILD_STORE`
# exactly the way it already repoints SYNTH_CACHE.
STORE = BuildStore()
