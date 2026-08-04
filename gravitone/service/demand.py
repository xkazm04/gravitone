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
    if not DEMAND_PATH.is_file():
        return {}
    try:
        data = json.loads(DEMAND_PATH.read_text("utf-8"))
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        # With atomic writes below, a torn file no longer happens from our own
        # (even multi-replica) writes; if it's still corrupt, don't silently
        # zero the whole demand history — surface it.
        logger.warning("emotion_demand.json is corrupt; treating as empty (%s)", DEMAND_PATH)
        return {}


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
            char = data.setdefault(character_id, {})
            char[emotion] = int(char.get(emotion, 0)) + 1
            atomic_write_text(DEMAND_PATH, json.dumps(data, indent=2))
    except OSError:
        pass


def demand_for(character_id: str, data: dict | None = None) -> dict[str, int]:
    """emotion -> unmet request count for one Character."""
    src = data if data is not None else _load()
    raw = src.get(character_id, {})
    return {e: int(n) for e, n in raw.items() if isinstance(n, (int, float))}


def all_demand() -> dict:
    return _load()
