"""Direction telemetry — what humans CHANGE when they re-perform a take.

`demand.py` records the emotions a Character was asked for and could not give.
This file records the other half of the signal: the emotions a human moved a
line TO after hearing it. Every derived take (a child minted from a parent in
`takes.py`) carries the exact metatagged text of its parent plus the edit, so
the diff between the two is a human direction decision — "line 3: baseline ->
angry", "swapped Sarah for Tom". Counted here, those decisions become the
corpus a future auto-direction pass learns from; uncounted, they are thrown
away the moment the child is written.

Storage: direction_deltas.json next to emotion_demand.json — gitignored runtime
state, written with demand.py's discipline: a per-process lock for threads, a
`atomicio.file_lock` for the other replicas, and an atomic replace so no reader
ever sees a half-written corpus. All three are load-bearing and none of them
substitutes for another. `os.replace` keeps the FILE intact; it does not keep
an UPDATE — two replicas that each read, each add their delta and each write
produce a file with one replica's work in it, and this is a whole-file replace
of a document that only ever grows, so the loss is every increment the loser
had accumulated, not one. That is why the cross-process lock is here and not
just a comment about a "demand signal" that undercounts. The store is BOUNDED:
MAX_CHARACTERS characters and MAX_KEYS keys per bucket, past which new keys are
dropped (existing counts keep incrementing) — a telemetry file must not grow
without limit on a box that is also synthesizing.

record_delta NEVER raises. Losing a statistic must never cost a user the take
that produced it.
"""
from __future__ import annotations

import json
import logging
import re
import threading
from pathlib import Path

from fastapi import APIRouter

from service.atomicio import atomic_write_text, file_lock
from service.config import SETTINGS

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/direction", tags=["direction"])

DIRECTION_PATH = Path(SETTINGS.voices_dir).parent / "direction_deltas.json"
_LOCK = threading.Lock()


def _lock_path() -> Path:
    """The cross-process mutex, derived from the store at CALL time so that
    redirecting DIRECTION_PATH (deployments do; tests do) moves both."""
    return DIRECTION_PATH.with_name("." + DIRECTION_PATH.name + ".lock")
_EMOTION_RE = re.compile(r"^[a-z_]{1,32}$")

MAX_CHARACTERS = 200  # distinct characters tracked
MAX_KEYS = 200        # distinct "from>to" keys per bucket
MAX_SEGMENTS = 200    # mirrors takes.MAX_SEGMENTS — never walk more than a take


def _empty() -> dict:
    return {"characters": {}, "swaps": {}}


def _load() -> dict:
    if not DIRECTION_PATH.is_file():
        return _empty()
    try:
        data = json.loads(DIRECTION_PATH.read_text("utf-8"))
    except (json.JSONDecodeError, OSError):
        # Atomic writes mean our own writes cannot tear the file; if it is
        # still unreadable, say so rather than silently zeroing the corpus.
        logger.warning("direction_deltas.json is unreadable; treating as empty (%s)",
                       DIRECTION_PATH)
        return _empty()
    if not isinstance(data, dict):
        return _empty()
    chars = data.get("characters")
    swaps = data.get("swaps")
    return {
        "characters": chars if isinstance(chars, dict) else {},
        "swaps": swaps if isinstance(swaps, dict) else {},
    }


def _emotion(seg: object) -> str:
    """The emotion a segment was DIRECTED to. `requested` is the human's
    instruction; `used` is what the engine could deliver — direction is about
    the instruction, so `requested` wins and `used` is only the fallback for
    records written without it."""
    if not isinstance(seg, dict):
        return ""
    value = str(seg.get("requested") or seg.get("used") or "").strip().lower()
    return value if _EMOTION_RE.match(value) else ""


def _bump(bucket: dict, key: str) -> None:
    if key in bucket:
        bucket[key] = int(bucket[key]) + 1
    elif len(bucket) < MAX_KEYS:  # read at call time — the cap is patchable
        bucket[key] = 1
    # else: bounded store, this new key is dropped (documented, not silent —
    # `stats()` reports `bounded: true` when a bucket is at its cap).


def emotion_deltas(parent: dict, child: dict) -> list[tuple[str, str]]:
    """(from, to) per segment position where the human moved the direction.

    Pure, so the counting rule is testable without touching the store. Pairs
    segments BY POSITION: a re-performed take is the same script with edited
    tags, and positions that only exist on one side are not a change anyone
    made — they are a different script, and are ignored.
    """
    p_segs = parent.get("segments") or []
    c_segs = child.get("segments") or []
    if not isinstance(p_segs, list) or not isinstance(c_segs, list):
        return []
    out: list[tuple[str, str]] = []
    for i in range(min(len(p_segs), len(c_segs), MAX_SEGMENTS)):
        before, after = _emotion(p_segs[i]), _emotion(c_segs[i])
        if before and after and before != after:
            out.append((before, after))
    return out


def record_delta(parent: dict, child: dict) -> None:
    """Count one re-performance: the emotions it moved and the voice it swapped.

    Never raises — this is called on the write path of a take that has already
    been rendered and persisted.
    """
    try:
        if not isinstance(parent, dict) or not isinstance(child, dict):
            return
        child_cid = str(child.get("character_id") or "")[:100]
        parent_cid = str(parent.get("character_id") or "")[:100]
        deltas = emotion_deltas(parent, child)
        swapped = bool(parent_cid and child_cid and parent_cid != child_cid)
        if not child_cid and not swapped:
            return
        # Both locks, in this order, exactly like voices.mutate_meta: the
        # thread lock keeps this process's requests off each other, the file
        # lock keeps the other replicas off the read-modify-write. A file lock
        # alone would let two threads here contend on the filesystem; a thread
        # lock alone is what this module had, and it excluded nothing.
        with _LOCK, file_lock(_lock_path()):
            data = _load()
            chars = data["characters"]
            if child_cid:
                entry = chars.get(child_cid)
                if entry is None:
                    if len(chars) >= MAX_CHARACTERS:
                        entry = None
                    else:
                        entry = {"deltas": {}, "children": 0}
                        chars[child_cid] = entry
                if entry is not None:
                    if not isinstance(entry.get("deltas"), dict):
                        entry["deltas"] = {}
                    entry["children"] = int(entry.get("children", 0)) + 1
                    for before, after in deltas:
                        _bump(entry["deltas"], before + ">" + after)
            if swapped:
                _bump(data["swaps"], parent_cid + ">" + child_cid)
            atomic_write_text(DIRECTION_PATH, json.dumps(data, indent=2))
    except Exception:  # noqa: BLE001 - telemetry must never break a render
        logger.debug("direction delta not recorded", exc_info=True)


def _split(key: str) -> tuple[str, str]:
    before, _, after = str(key).partition(">")
    return before, after


def stats(character_id: str | None = None, limit: int = 10) -> dict:
    """Per character, the direction changes clients actually make.

    Feeds the studio's recommendation surface (and, later, auto-direction):
    "line-level emotion moved to angry 41x on this Character".
    """
    limit = max(1, min(int(limit or 10), 100))
    data = _load()
    characters = []
    for cid, entry in data["characters"].items():
        if character_id and cid != character_id:
            continue
        if not isinstance(entry, dict):
            continue
        raw = entry.get("deltas") if isinstance(entry.get("deltas"), dict) else {}
        top = sorted(raw.items(), key=lambda kv: (-int(kv[1]), kv[0]))[:limit]
        characters.append({
            "character_id": cid,
            "children": int(entry.get("children", 0)),
            "changes": sum(int(n) for n in raw.values()),
            "bounded": len(raw) >= MAX_KEYS,
            "top": [{"from": _split(k)[0], "to": _split(k)[1], "count": int(n)}
                    for k, n in top],
        })
    characters.sort(key=lambda c: (-c["children"], c["character_id"]))
    swaps = sorted(data["swaps"].items(), key=lambda kv: (-int(kv[1]), kv[0]))[:limit]
    return {
        "characters": characters,
        "swaps": [{"from": _split(k)[0], "to": _split(k)[1], "count": int(n)}
                  for k, n in swaps],
    }


@router.get("/stats")
def get_direction_stats(character_id: str | None = None, limit: int = 10) -> dict:
    return stats(character_id, limit)
