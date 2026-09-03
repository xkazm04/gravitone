"""Fill the hottest missing emotion slots from the basis, on demand data.

`service/demand.py` has been counting, on every fallback, exactly which emotion
each Character was asked for and did not have. Until Emotion Algebra that queue
could only be answered by a person with a microphone. This tool answers the top
of it by computing: for each Character, the missing slot with the most unmet
requests is derived through the SAME internal path the endpoint uses --
`voices.derive_emotion` itself, not a copy of it -- so every guard that protects
a hand-made derive protects an automatic one (staging discipline, load-back,
slot re-check under the registry lock, inherited-never-minted consent, the
coherence gate, the transfer-quality gate).

The four rules that make an automatic writer acceptable:

  * **Capped per run.** ``AUTOFILL_CAP`` (env ``GRAVITONE_AUTOFILL_CAP``,
    ``--cap`` on the command line) bounds how many voices one run may create,
    and one run may take at most ONE slot per Character -- a wide, shallow fill
    rather than a deep one, so a single Character with a long demand tail cannot
    consume the whole budget.
  * **Reversible.** A derived Voice is deleted by exactly the normal path,
    `DELETE /v1/voices/{voice_id}` (`voices._unlink_then_forget`): file unlinked,
    row forgotten, slot free to be recorded properly. Nothing here writes
    anything a person could not undo with the button they already have.
  * **Refuses by name.** No basis built, an emotion below the coherence bar, an
    emotion measured deriving worse than a recording, a box that cannot read
    embeddings at all (no `safetensors`/torch) -- four different problems, four
    different sentences, and nothing written for any of them.
  * **Deterministic.** The plan is sorted by (demand, character, emotion), so
    ``--dry-run`` prints exactly what a real run would do, and two runs of the
    same cap cover the same slots in the same order.

Run (``python -m service.tools`` lists the whole pipeline and what each part
needs; this is the last step of it):

    python -m service.tools autofill --dry-run
    python -m service.tools autofill --cap 5
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path

from service import demand as demand_mod
from service import emotion_basis
from service.config import SETTINGS
from service.emotions import BASELINE, EMOTION_SCALE

# The named cap. Small on purpose: this writes voices nobody asked for one by
# one, and a run that fills forty slots is a run nobody reviews.
AUTOFILL_CAP_ENV = "GRAVITONE_AUTOFILL_CAP"
AUTOFILL_CAP = 3

# How this tool tells the user to undo itself, verbatim, in every report line.
UNDO = "DELETE /v1/voices/{voice_id}"


def _out(line: str) -> None:
    """ASCII-only stdout -- this runs on a cp1252 Windows console."""
    print(line.encode("ascii", "replace").decode("ascii"))


def cap_setting(override: int | None = None) -> int:
    """The per-run cap: ``--cap`` beats the environment beats the default."""
    if override is not None:
        return max(0, int(override))
    raw = os.environ.get(AUTOFILL_CAP_ENV, "")
    try:
        return max(0, int(raw))
    except (TypeError, ValueError):
        return AUTOFILL_CAP


def load_registry(voices_dir: Path | str) -> dict:
    """``{"voices": {...}, "characters": {...}}``, without importing the service.

    Same posture as `prosody_backfill.load_meta`: a plan must be printable on a
    box where importing `service.voices` fails (it pulls in the engine), and an
    unreadable registry is an empty plan rather than a traceback. The WRITE path
    does go through voices.py -- and on such a box it never runs anyway.
    """
    path = Path(voices_dir) / "_meta.json"
    if not path.is_file():
        return {"voices": {}, "characters": {}}
    try:
        raw = json.loads(path.read_text("utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        _out(f"derive_autofill: skipped: registry unreadable ({exc})")
        return {"voices": {}, "characters": {}}
    if not isinstance(raw, dict):
        return {"voices": {}, "characters": {}}
    voices = raw.get("voices")
    characters = raw.get("characters")
    return {"voices": voices if isinstance(voices, dict) else {},
            "characters": characters if isinstance(characters, dict) else {}}


@dataclass(frozen=True)
class Candidate:
    """One slot this run would fill, and everything that justified it."""
    character_id: str
    emotion: str
    demand: int
    coherence: float
    quality: float | None   # measured transfer quality, None = never measured
    # The NAME of what `quality` is (emotion_basis.TRANSFER_STATES). Carried
    # beside the number rather than derived from `quality is None` at each read
    # site, for the same reason the derived row carries it: "nobody measured
    # this" is a state, not a missing value.
    state: str = emotion_basis.TRANSFER_UNMEASURED

    def describe(self) -> str:
        measured = ("unmeasured transfer" if self.quality is None
                    else f"transfer {self.quality:.2f}")
        return (f"{self.character_id}/{self.emotion}: {self.demand} unmet "
                f"request(s), coherence {self.coherence:.2f}, {measured}")


@dataclass(frozen=True)
class Skip:
    """A slot that was WANTED and will not be filled, with the reason said."""
    character_id: str
    emotion: str
    demand: int
    reason: str


def _scale(character_row: dict, emotions_present: list[str]) -> list[str]:
    """A Character's effective palette: base scale + declared/held custom slots.

    Mirrors `voices.character_scale` rather than importing it, for the same
    reason `load_registry` exists -- planning must not need the service package.
    """
    scale = list(EMOTION_SCALE)
    declared = character_row.get("custom_emotions") or []
    for e in list(declared) + list(emotions_present):
        if isinstance(e, str) and e not in scale:
            scale.append(e)
    return scale


def plan(registry: dict, demand: dict, basis: emotion_basis.Basis | None, *,
         cap: int) -> tuple[list[Candidate], list[Skip]]:
    """``(what to derive, what was refused and why)`` -- deterministic, pure.

    One slot per Character (its hottest), globally ordered by demand and capped.
    Ordering ties break on character id then emotion so the plan is stable
    across runs and across JSON key order.
    """
    rows = registry.get("voices") or {}
    characters = registry.get("characters") or {}

    held: dict[str, dict[str, dict]] = {}
    for row in rows.values():
        if not isinstance(row, dict):
            continue
        cid, emotion = row.get("character_id"), row.get("emotion")
        if isinstance(cid, str) and isinstance(emotion, str):
            held.setdefault(cid, {})[emotion] = row

    wanted: list[Candidate] = []
    skips: list[Skip] = []
    for cid in sorted(demand):
        counts = demand.get(cid)
        if not isinstance(counts, dict):
            continue
        slots = held.get(cid)
        if not slots:
            # Built-ins (which cannot be extended) and characters whose rows are
            # gone both land here. Demand for them is real telemetry, but there
            # is no cloned Character to write into.
            continue
        scale = _scale(characters.get(cid) or {}, sorted(slots))
        best: Candidate | None = None
        best_skip: Skip | None = None
        for emotion in sorted(counts, key=lambda e: (-_count(counts[e]), e)):
            count = _count(counts.get(emotion))
            if count <= 0 or emotion == BASELINE or emotion in slots:
                continue
            if emotion not in scale:
                continue  # not part of this Character's palette; nothing to fill
            base = slots.get(BASELINE)
            if base is None or base.get("origin") == "derived":
                best_skip = best_skip or Skip(
                    cid, emotion, count,
                    "no recorded baseline to derive from -- record one first")
                continue
            if basis is None:
                best_skip = best_skip or Skip(cid, emotion, count,
                                              "no emotion basis is available")
                continue
            entry, reason = emotion_basis.direction(basis, emotion)
            if entry is None:
                best_skip = best_skip or Skip(cid, emotion, count, reason or
                                              "this emotion cannot be derived")
                continue
            payload, refusal = emotion_basis.transfer_check(basis, emotion)
            if refusal is not None:
                best_skip = best_skip or Skip(cid, emotion, count, refusal)
                continue
            best = Candidate(cid, emotion, count, entry.coherence,
                             payload["quality"], payload["state"])
            break
        if best is not None:
            wanted.append(best)
        elif best_skip is not None:
            skips.append(best_skip)

    wanted.sort(key=lambda c: (-c.demand, c.character_id, c.emotion))
    if cap >= 0 and len(wanted) > cap:
        for extra in wanted[cap:]:
            skips.append(Skip(extra.character_id, extra.emotion, extra.demand,
                              f"over this run's cap of {cap}"))
        wanted = wanted[:cap]
    skips.sort(key=lambda s: (-s.demand, s.character_id, s.emotion))
    return wanted, skips


def _count(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    return int(value)


def derive(candidate: Candidate) -> tuple[str | None, str | None]:
    """Write one derived Voice. ``(voice_id, None)`` or ``(None, reason)``.

    Calls `voices.derive_emotion` -- the endpoint function itself, which is a
    plain `def` -- rather than reimplementing the write. Every refusal it raises
    is an HTTPException whose detail is already a sentence written for a person,
    so it is passed through unchanged instead of being re-worded here.
    """
    try:
        from fastapi import HTTPException

        from service import voices
    except Exception as exc:  # noqa: BLE001 - torch/pocket_tts absent on a dev box
        return None, f"the registry writer is unavailable ({type(exc).__name__}: {exc})"
    try:
        voice = voices.derive_emotion(candidate.character_id, candidate.emotion,
                                      voices.DeriveReq())
    except HTTPException as exc:
        return None, f"{exc.status_code}: {exc.detail}"
    except Exception as exc:  # noqa: BLE001 - one slot, not the run
        return None, f"{type(exc).__name__}: {exc}"
    voices.invalidate()
    return voice.voice_id, None


def run(voices_dir: Path, *, cap: int, dry_run: bool = False,
        derive_fn=derive) -> int:
    """Plan, report, and (unless --dry-run) fill. Always exit code 0."""
    registry = load_registry(voices_dir)
    basis, reason = emotion_basis.load(voices_dir)
    if basis is None:
        # The one refusal that kills the whole run rather than a slot: with no
        # basis there is no direction to step along for ANY emotion.
        _out(f"derive_autofill: skipped: {reason}")
        return 0

    wanted, skips = plan(registry, demand_mod.all_demand(), basis, cap=cap)
    _out(f"derive_autofill: {len(wanted)} slot(s) to fill, cap {cap} "
         f"(registry: {voices_dir / '_meta.json'})")
    for skip in skips:
        _out(f"  {skip.character_id}/{skip.emotion}: skipped ({skip.demand} "
             f"unmet): {skip.reason}")
    if not wanted:
        return 0
    if dry_run:
        for candidate in wanted:
            _out(f"  would derive {candidate.describe()}")
        _out("derive_autofill: --dry-run, nothing was written")
        return 0

    filled = 0
    for candidate in wanted:
        voice_id, refusal = derive_fn(candidate)
        if voice_id is None:
            _out(f"  {candidate.character_id}/{candidate.emotion}: not derived: "
                 f"{refusal}")
            continue
        filled += 1
        _out(f"  derived {candidate.describe()} -> {voice_id} "
             f"(undo: {UNDO.format(voice_id=voice_id)})")
    _out(f"derive_autofill: {filled} of {len(wanted)} slot(s) filled; every one "
         f"is reversible with {UNDO}")
    return 0


def main(argv: list[str] | None = None) -> int:  # pragma: no cover - CLI
    ap = argparse.ArgumentParser(
        prog="derive_autofill",
        description="Derive the hottest missing emotion slot per Character from "
                    "unmet-demand telemetry.")
    ap.add_argument("--voices-dir", default=str(SETTINGS.voices_dir))
    ap.add_argument("--cap", type=int, default=None,
                    help=f"voices to create at most (default {AUTOFILL_CAP}, or "
                         f"${AUTOFILL_CAP_ENV})")
    ap.add_argument("--dry-run", action="store_true",
                    help="print the plan and exit without writing")
    args = ap.parse_args(argv)
    return run(Path(args.voices_dir), cap=cap_setting(args.cap),
               dry_run=args.dry_run)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
