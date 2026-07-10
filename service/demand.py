"""Fallback demand telemetry — the coverage loop's demand signal.

Every time a request asks a Character for an emotion it lacks (and falls back
to baseline), that unmet demand is counted here instead of being discarded.
The studio surfaces it as heat on empty emotion slots ("angry requested 214×
— record it now"), turning real API traffic into a prioritized recording
queue. Counts include emotions outside the standard scale, so the file also
measures appetite for a future custom-emotion vocabulary.

Storage: emotion_demand.json next to api_keys.json — gitignored runtime
state. Writes are lock-guarded per process; multi-replica fleets will
undercount (last-writer-wins), which is acceptable for a demand *signal*.
"""
from __future__ import annotations

import json
import re
import threading
from pathlib import Path

from service.config import SETTINGS

DEMAND_PATH = Path(SETTINGS.voices_dir).parent / "emotion_demand.json"
_LOCK = threading.Lock()
_EMOTION_RE = re.compile(r"^[a-z_]{1,32}$")


def _load() -> dict:
    if not DEMAND_PATH.is_file():
        return {}
    try:
        data = json.loads(DEMAND_PATH.read_text("utf-8"))
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


def record_fallback(character_id: str, requested_emotion: str) -> None:
    """Count one unmet emotion request. Never raises — telemetry must not
    break synthesis."""
    emotion = (requested_emotion or "").strip().lower()
    if not _EMOTION_RE.match(emotion) or emotion == "baseline":
        return
    try:
        with _LOCK:
            data = _load()
            char = data.setdefault(character_id, {})
            char[emotion] = int(char.get(emotion, 0)) + 1
            DEMAND_PATH.parent.mkdir(parents=True, exist_ok=True)
            DEMAND_PATH.write_text(json.dumps(data, indent=2), "utf-8")
    except OSError:
        pass


def demand_for(character_id: str, data: dict | None = None) -> dict[str, int]:
    """emotion -> unmet request count for one Character."""
    src = data if data is not None else _load()
    raw = src.get(character_id, {})
    return {e: int(n) for e, n in raw.items() if isinstance(n, (int, float))}


def all_demand() -> dict:
    return _load()
