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

"How the weights are executed" includes WHICH KERNELS execute them. The
``engine_version`` component (built by ``service.app._engine_version``) therefore
carries the RESOLVED int8 backend whenever quantization is on —
``quant=1:qnnpack`` — not the configured request, because ``TTS_QUANTIZED_ENGINE``
defaults to ``"auto"`` and ``"auto"`` names a different backend on every box.
fbgemm and qnnpack are not two spellings of one computation: fbgemm requantizes
with reduced-range activations to stay overflow-safe on x86, qnnpack uses the
full 8-bit range on Arm, so the same weights and the same text produce different
samples under the two. A digest that ignored the backend would name both.

This did NOT bump ``IDENTITY_VERSION``: the payload's SHAPE is unchanged (no
component added, removed or re-ordered) — one component's VALUE gained an axis,
exactly as ``lang=`` and ``max_tokens=`` already encode config inside it. The
blast radius is bounded on purpose: with ``TTS_QUANTIZE`` off (the shipped
default) the string is still ``quant=0``, so every digest ever minted on an fp32
box keeps its name and every stored artifact stays reachable. On a
``quantize=True`` box the names DO move, which is the point — those digests were
answering the wrong question. Nothing is deleted: the old artifacts remain
served under ``GET /v1/audio/{digest}`` (they were correct for the identity that
minted them), the next build re-mints under the backend-qualified name, and the
now-unreferenced bytes age out through the store's ordinary LRU budget. Bumping
``IDENTITY_VERSION`` instead would have invalidated the overwhelming majority of
digests — the fp32 ones, which were never wrong — to fix the minority.

Two more things joined them once the build plane grew teeth, and they are the
same idea one level up:

3. **The identity of a BUILD** — ``build_id``, a digest over the (line id →
   digest) map. Deterministic, so re-posting an unchanged manifest names the
   same build rather than minting a new one, and the record that backs
   ``GET /v1/build/{build_id}.zip`` is content-addressed exactly like the audio.

4. **The lockfile** — ``lockfile()`` renders the ``gravitone.lock`` document:
   sorted keys, no timestamps, no host names, nothing that moves when nothing
   changed. A lockfile whose diff is noisy is a lockfile nobody keeps in git.

Scope, stated plainly: no billing and no entitlements — a digest is a name and
this is where the named bytes live.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
import zipfile
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

# --- The lockfile / build-record plane --------------------------------------
# Two documents leave this service and land in somebody's git repository, so
# both are VERSIONED and both are rendered with sorted keys and no timestamps:
# a document that changes when nothing changed is a document that gets deleted
# from the repo after the third noisy diff.
LOCKFILE_SCHEMA_VERSION = "gravitone.lock/1"
BUILD_RECORD_SCHEMA_VERSION = "gravitone.build/1"

# How many build records the store keeps. A record is a few kilobytes of JSON
# naming digests it does not own, so this is a bound on clutter, not on disk;
# the artifacts have their own (byte) budget and their own LRU.
BUILD_RECORDS_MAX = 500

# The largest zip this service will assemble. Checked BEFORE a byte is streamed
# (from the stored sizes, which are free), because a refusal a client can read
# is worth more than a truncated download it cannot distinguish from success.
_ZIP_BYTES_ENV = "GRAVITONE_BUILD_ZIP_MAX_BYTES"
BUILD_ZIP_MAX_BYTES_DEFAULT = 256 * 1024 * 1024

# A fixed DOS timestamp for every zip member: the archive of an unchanged build
# is then byte-identical on every machine and every day. Zip cannot store a year
# before 1980, so this is the epoch the format allows, not an invented one.
ZIP_EPOCH = (1980, 1, 1, 0, 0, 0)

BUILD_NOT_FOUND = (
    "no build is stored under this build id on this replica. A build id names "
    "the lines of a manifest, and the record is written by POST /v1/build — "
    "re-post the manifest and fetch the zip under the build_id it returns."
)

BAD_BUILD_ID = (
    "not a build id: expected 64 hex characters (the value of build_id in a "
    "POST /v1/build response), optionally with the 'sha256:' prefix"
)

DUPLICATE_LINE_ID = (
    "a lockfile is keyed by line id, so a manifest with two lines sharing one "
    "id cannot be locked: it would silently drop one of them. Duplicate ids: "
)

BUILD_PRUNED = (
    "this build's audio is no longer stored: the artifacts below were evicted "
    "by the store's LRU budget (GRAVITONE_BUILD_STORE_BYTES) or never rendered "
    "on this replica. Re-run POST /v1/build with the same manifest to restore "
    "them under the same names. Missing digests: "
)

ZIP_TOO_LARGE = (
    "this build's artifacts exceed the zip budget "
    "(GRAVITONE_BUILD_ZIP_MAX_BYTES); fetch the lines individually with "
    "GET /v1/audio/{digest} instead. Bytes requested/allowed: "
)

_UNSAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


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


def zip_max_bytes() -> int:
    raw = os.environ.get(_ZIP_BYTES_ENV)
    if not raw:
        return BUILD_ZIP_MAX_BYTES_DEFAULT
    try:
        return max(0, int(raw))
    except ValueError:
        logger.warning("%s=%r is not an integer; using the default zip budget",
                       _ZIP_BYTES_ENV, raw)
        return BUILD_ZIP_MAX_BYTES_DEFAULT


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


# --- Build identity, the lockfile, and the zip ------------------------------

def build_id(lines: list[dict]) -> str:
    """The name of a BUILD: 64 hex characters over its (id, digest, format) map.

    Deterministic and order-insensitive (the lines are sorted first), so
    re-posting a manifest that did not change names the same build instead of
    minting a new record every time CI runs. Two manifests that differ in a
    single line's text differ in that line's digest and therefore in this id —
    which is what makes ``GET /v1/build/{build_id}.zip`` a stable URL for a
    stable set of audio, and a changing URL for changing audio.
    """
    payload = {
        "v": BUILD_RECORD_SCHEMA_VERSION,
        "lines": sorted(
            [str(ln["id"]), str(ln["digest"]), str(ln.get("format") or "")]
            for ln in lines),
    }
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()


def parse_build_id(value: str) -> str:
    """Normalize a caller-supplied build id, or raise ``ValueError``.

    Same discipline as ``parse_digest`` and for the same reason: a build id
    becomes a filename, so nothing that is not 64 hex characters is ever
    allowed to become one.
    """
    raw = (value or "").strip().lower()
    if raw.startswith("sha256:"):
        raw = raw[len("sha256:"):]
    if not _HEX64.match(raw):
        raise ValueError(BAD_BUILD_ID)
    return raw


def duplicate_line_ids(lines: list[dict]) -> list[str]:
    """The ids that appear more than once, sorted. Empty when the manifest is ok."""
    seen: dict[str, int] = {}
    for line in lines:
        key = str(line["id"])
        seen[key] = seen.get(key, 0) + 1
    return sorted(k for k, n in seen.items() if n > 1)


def lockfile(lines: list[dict], *, identity_version: str | None = None) -> dict:
    """Render ``gravitone.lock``.

    Schema (``schema_version`` = ``gravitone.lock/1``)::

        {
          "schema_version":   "gravitone.lock/1",
          "identity_version": "gravitone-speech-identity/1",
          "lines": {
            "<line id>": {
              "digest":         "sha256:<64 hex>",
              "engine_version": "pocket_tts/1/lang=english/quant=0/max_tokens=50",
              "voice":          "<resolved voice id>",
              "format":         "wav_24000"
            }
          }
        }

    Deliberately absent: any timestamp, host, build id or counter. Everything in
    here is a function of the INPUTS, so the file changes when and only when the
    audio would — which is the only property that makes it worth committing.
    ``json.dumps(..., sort_keys=True, indent=2)`` renders it; the ordering is
    total, so two machines building the same script write identical bytes.

    Raises ``ValueError`` (named, ``DUPLICATE_LINE_ID``) when two lines share an
    id: the document is keyed by id, so it cannot represent that manifest.
    """
    dupes = duplicate_line_ids(lines)
    if dupes:
        raise ValueError(DUPLICATE_LINE_ID + ", ".join(dupes))
    return {
        "schema_version": LOCKFILE_SCHEMA_VERSION,
        "identity_version": identity_version or IDENTITY_VERSION,
        "lines": {
            str(line["id"]): {
                "digest": str(line["digest"]),
                "engine_version": str(line.get("engine_version") or ""),
                "voice": str(line.get("voice") or ""),
                "format": str(line.get("format") or ""),
            }
            for line in sorted(lines, key=lambda ln: str(ln["id"]))
        },
    }


def lockfile_bytes(doc: dict) -> bytes:
    """The lockfile as it should be written to disk: sorted, indented, newline."""
    return (json.dumps(doc, sort_keys=True, indent=2, ensure_ascii=True)
            + "\n").encode("utf-8")


def zip_member_names(lines: list[dict]) -> list[str]:
    """One archive path per line, in manifest order — safe, stable, unique.

    A line id is whatever the caller's script called it, which means it can hold
    slashes, dots and worse. Those are replaced rather than escaped, and a
    collision (or an id that sanitizes to nothing) falls back to a numbered
    suffix, so an archive can never contain two members with one name or a
    member that writes outside the extraction directory.
    """
    names: list[str] = []
    taken: set[str] = set()
    for index, line in enumerate(lines):
        stem = _UNSAFE_NAME.sub("_", str(line["id"])).strip("._-")[:80]
        if not stem:
            stem = f"line-{index}"
        ext = (str(line.get("format") or "wav").split("_", 1)[0]
               or "bin").lower()
        ext = _UNSAFE_NAME.sub("", ext) or "bin"
        name = f"audio/{stem}.{ext}"
        if name in taken:
            suffix = 2
            while f"audio/{stem}-{suffix}.{ext}" in taken:
                suffix += 1
            name = f"audio/{stem}-{suffix}.{ext}"
        taken.add(name)
        names.append(name)
    return names


class _ZipSink:
    """A write-only, non-seekable file object that hands its bytes back.

    ``zipfile`` writes to this; the generator below drains it after every
    member. That is what makes the zip STREAMED: exactly one artifact is in
    memory at a time, never the whole archive.
    """

    def __init__(self) -> None:
        self._buf = bytearray()
        self._pos = 0

    def write(self, data) -> int:
        self._buf += data
        self._pos += len(data)
        return len(data)

    def flush(self) -> None:  # pragma: no cover - required by the file protocol
        pass

    def tell(self) -> int:
        return self._pos

    def seekable(self) -> bool:
        return False

    def drain(self) -> bytes:
        out = bytes(self._buf)
        del self._buf[:]
        return out


def stream_zip(members):
    """Yield the bytes of a zip over ``(name, data)`` pairs, one member at a time.

    ``ZIP_STORED``: the payload is already-encoded audio (mp3 does not deflate,
    and wav's few percent are not worth spending a core on a request path that
    is bounded by the manifest cap). With a fixed ``ZIP_EPOCH`` per member, the
    archive of an unchanged build is byte-identical every time it is fetched.

    ``members`` is consumed lazily, so the caller can read each artifact off
    disk only when it is about to be written.
    """
    sink = _ZipSink()
    with zipfile.ZipFile(sink, "w", zipfile.ZIP_STORED) as archive:
        for name, data in members:
            info = zipfile.ZipInfo(filename=name, date_time=ZIP_EPOCH)
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = 0o644 << 16
            archive.writestr(info, data)
            chunk = sink.drain()
            if chunk:
                yield chunk
    tail = sink.drain()
    if tail:
        yield tail


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

    # -- build records ----------------------------------------------------
    # A record is the manifest's SKELETON: line id -> digest -> format, and
    # nothing else. It owns no bytes (the artifacts are content-addressed and
    # shared with every other build that names them), which is why it is capped
    # by COUNT and why a pruned artifact makes the zip a named 410 rather than
    # making the record wrong.

    @property
    def records_dir(self) -> Path:
        return self.root / "builds"

    def _record_path(self, build: str) -> Path:
        return self.records_dir / f"{parse_build_id(build)}.json"

    def put_record(self, record: dict) -> bool:
        """Persist a build record. Returns whether it is now stored.

        Blocking; same failure posture as ``put`` — a build whose record could
        not be written still returned every digest it rendered, so the only
        thing lost is the zip convenience route, and that is logged, not raised.
        """
        if not self.enabled:
            return False
        try:
            path = self._record_path(str(record.get("build_id") or ""))
        except ValueError:
            return False
        try:
            with file_lock(self.root / ".store.lock"):
                path.parent.mkdir(parents=True, exist_ok=True)
                atomic_write_text(path, json.dumps(record, sort_keys=True))
                self._prune_records_locked()
        except (OSError, TimeoutError) as exc:
            logger.warning("build record write failed for %s: %s", path.name, exc)
            return False
        return True

    def get_record(self, build: str) -> dict | None:
        try:
            path = self._record_path(build)
        except ValueError:
            return None
        try:
            record = json.loads(path.read_text("utf-8"))
        except (OSError, ValueError):
            return None
        if not isinstance(record, dict):
            return None
        try:
            os.utime(path, None)  # records prune least-recently-USED too
        except OSError:
            pass
        return record

    def records(self) -> list[tuple[float, Path]]:
        out: list[tuple[float, Path]] = []
        if not self.records_dir.is_dir():
            return out
        for path in self.records_dir.glob("*.json"):
            try:
                out.append((path.stat().st_mtime, path))
            except OSError:
                continue
        return out

    def _prune_records_locked(self) -> int:
        items = sorted(self.records())
        removed = 0
        for _mtime, path in items[:max(0, len(items) - BUILD_RECORDS_MAX)]:
            try:
                path.unlink()
            except OSError:
                continue
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
            "builds": len(self.records()),
        }


# The process-wide store the routes use. A plain module-level instance (not a
# singleton behind a getter) so a test can repoint `service.app.BUILD_STORE`
# exactly the way it already repoints SYNTH_CACHE.
STORE = BuildStore()
