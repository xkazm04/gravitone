"""Fallback demand telemetry — the coverage loop's demand signal.

Every time a request asks a Character for an emotion it lacks (and falls back
to baseline), that unmet demand is counted here instead of being discarded.
The studio surfaces it as heat on empty emotion slots ("angry requested 214×
— record it now"), turning real API traffic into a prioritized recording
queue. Counts include emotions outside the standard scale, so the file also
measures appetite for a future custom-emotion vocabulary.

Storage: emotion_demand.json next to api_keys.json — gitignored runtime state.
Writes take BOTH locks (`voices.mutate_meta`'s discipline): a `threading.Lock`
for this process's threads and `atomicio.file_lock` for the other replicas,
then an atomic replace. The multi-replica undercount this file used to
document is gone, and it was never as small as "a lost increment": a
last-writer-wins whole-file replace loses every count the loser accumulated
between its read and its write, on the file that is supposed to be the
recording queue's evidence. A signal that quietly under-reports the emotions
people ask for most is worse than no signal, because it is still believed.
"""
from __future__ import annotations

import json
import logging
import re
import threading
from pathlib import Path

from service.atomicio import atomic_write_text, file_lock
from service.config import SETTINGS

logger = logging.getLogger(__name__)

DEMAND_PATH = Path(SETTINGS.voices_dir).parent / "emotion_demand.json"
_LOCK = threading.Lock()


def _lock_path() -> Path:
    """The cross-process mutex, derived from the store at CALL time so that
    redirecting DEMAND_PATH (deployments do; tests do) moves both."""
    return DEMAND_PATH.with_name("." + DEMAND_PATH.name + ".lock")
_EMOTION_RE = re.compile(r"^[a-z_]{1,32}$")


def _load() -> dict:
    """The store, or `{}` with the reason logged. NEVER raises.

    Three readers depend on that promise and none of them can afford an
    exception: `record_fallback` runs inside a synthesis request,
    `voices._demand()` decorates the studio roster, and `derive_autofill`
    plans from it. So every way a file can refuse to become a dict is caught
    here, not just malformed JSON — `read_text` raises `OSError` when the file
    is unreadable and `UnicodeDecodeError` (a `ValueError`, NOT an `OSError`)
    on bytes that are not UTF-8, and both used to escape this function: past
    `record_fallback`'s `except OSError`, out of `all_demand()`, and into the
    roster. Same posture as `direction._load`: report it, treat it as empty,
    and let the next write re-establish the file.
    """
    if not DEMAND_PATH.is_file():
        return {}
    try:
        data = json.loads(DEMAND_PATH.read_text("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError, OSError):
        # With atomic writes below, a torn file no longer happens from our own
        # (even multi-replica) writes; if it's still corrupt, don't silently
        # zero the whole demand history — surface it.
        logger.warning("emotion_demand.json is unreadable; treating as empty (%s)",
                       DEMAND_PATH)
        return {}
    return data if isinstance(data, dict) else {}


def record_fallback(character_id: str, requested_emotion: str) -> None:
    """Count one unmet emotion request. Never raises — telemetry must not
    break synthesis."""
    emotion = (requested_emotion or "").strip().lower()
    if not _EMOTION_RE.match(emotion) or emotion == "baseline":
        return
    try:
        # Thread lock first, then the cross-process one (the order
        # voices.mutate_meta established): the whole read-modify-write is
        # inside both, so no replica can read a count we are about to replace.
        # TimeoutError from a wedged lock is an OSError and lands in the
        # handler below — telemetry never costs a caller their synthesis.
        with _LOCK, file_lock(_lock_path()):
            data = _load()
            char = data.get(character_id)
            if not isinstance(char, dict):
                # A well-formed JSON file whose shape is wrong (hand-edited, or
                # written by something else) must not become an AttributeError
                # in the middle of a synthesis request. The bad branch is
                # replaced, not the whole file.
                char = {}
                data[character_id] = char
            char[emotion] = _count(char.get(emotion)) + 1
            atomic_write_text(DEMAND_PATH, json.dumps(data, indent=2))
    except (OSError, ValueError) as exc:
        # OSError covers a wedged lock (TimeoutError) and an unwritable disk;
        # ValueError covers anything the store's own contents can still throw.
        # Losing a count is acceptable — losing the caller's audio is not — but
        # it is LOGGED, because a telemetry file that silently stops counting
        # is a recording queue that silently stops being evidence.
        logger.warning("emotion demand not recorded for %s/%s (%s)",
                       character_id, emotion, exc)


def _count(value: object) -> int:
    """A stored count as an int, treating anything that is not one as zero.

    `True` is an `int` in Python and would count as 1; a string count from a
    hand-edited file would raise inside the lock. Neither may happen here.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    return int(value)


def demand_for(character_id: str, data: dict | None = None) -> dict[str, int]:
    """emotion -> unmet request count for one Character. NEVER raises.

    A Character whose branch is not a dict (corrupt, or hand-edited) reads as
    no demand rather than as an `AttributeError` on the roster: this decorates
    a list of voices, and it may not be able to take that list down.
    """
    src = data if data is not None else _load()
    raw = src.get(character_id) if isinstance(src, dict) else None
    if not isinstance(raw, dict):
        return {}
    return {str(e): _count(n) for e, n in raw.items() if _count(n)}


def all_demand() -> dict:
    return _load()
