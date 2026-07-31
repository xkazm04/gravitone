"""Blind A/B: does a DERIVED voice land where the recording it replaces lands?

`service/tools/emotion_residuals.py` asks whether the residuals agree. That is a
question about geometry, and it can be answered without ever making a sound.
This module asks the question a listener cares about: for a speaker who DOES
have a real take of emotion E, synthesize one fixed line through the real voice
and through the voice we would have DERIVED for them, and see which of the two
renders sits closer to what that real slot was measured to sound like.

The method, and why each half of it is shaped this way:

  * **One fixed line**, the same sentence `prosody_backfill` calibrates with --
    imported, not copied, so the two tools cannot drift. Different words would
    show up in the probe as a difference in delivery.
  * **The target is the real slot's STORED prosody**, measured when it was
    cloned (or backfilled), never a fresh probe of the arm under test. Both arms
    are scored against the same fixed point, so neither can be scored against
    itself.
  * **Blind.** :func:`compare` hands the scorer two arms named `A` and `B`, in an
    order derived from the pair's own key, and unblinds only after both
    distances are in. There is no model here to be biased -- the blinding is so
    that a future scorer (a human listen set is the named next step) plugs into
    the same seam without the harness having to change.
  * **Quality is relative to the real render, not absolute.** The real voice
    speaking a DIFFERENT sentence already sits some distance from its stored
    probe; that distance is the floor, and what we measure is how much FURTHER
    the derived render sits. See :func:`quality`.

Two honesty rules:

  * **The engine is required, and its absence is named.** Nothing here can be
    simulated: torch and pocket_tts are absent outside the container, so a dev
    box gets `skipped: engine unavailable (...)` and writes nothing. The
    ARITHMETIC (distance, blinding, quality, aggregation) is pure and is unit
    tested against synthetic prosody vectors with a stubbed measure hook, so
    only the corpus needs the Arm box.
  * **In-sample speakers are counted, not hidden.** The basis was averaged from
    whichever speakers had the emotion -- often the same ones tested here. That
    flatters the result, so `in_sample` travels with every published number.

Run:

    python -m service.tools.derive_ab --dry-run
    python -m service.tools.derive_ab --emotion angry
"""
from __future__ import annotations

import argparse
import hashlib
import math
import sys
import tempfile
import uuid
from pathlib import Path

import numpy as np

from service import emotion_basis
from service.config import SETTINGS
from service.emotions import BASELINE, prosody_vector
from service.tools import emotion_residuals as res
from service.tools.derive_autofill import load_registry
from service.tools.prosody_backfill import CALIBRATION_TEXT, measure, open_engine

# The line every arm speaks. Imported from the backfill tool on purpose: the
# stored prosody these renders are scored against was measured on this sentence
# for every backfilled slot, and two tools disagreeing about the calibration
# text would show up as an emotion difference.
AB_TEXT = CALIBRATION_TEXT

# One "noticeable step" per probe field, in that field's own units (energy is
# already in dB by the time `prosody_vector` hands it over). These are the
# denominators that make five incomparable features into one distance; they are
# deliberately coarse round numbers, chosen so that a difference of 1.0 in the
# scaled space is a difference a listener would plausibly notice, and they are
# the ONLY tuning surface in this module.
FIELD_STEP: dict[str, float] = {
    "f0_mean": 20.0,        # Hz -- about a musical third at speech pitch
    "f0_sd": 15.0,          # Hz -- monotone vs animated
    "energy_rms": 3.0,      # dB -- the classic "just noticeable" loudness step
    "rate_proxy": 1.0,      # peaks/second
    "spectral_tilt": 3.0,   # dB of brightness
}

# Fewer shared measurable fields than this and the comparison is a coin flip
# dressed as a number: it is reported as unmeasured instead.
MIN_SHARED_FIELDS = 2

# Prefix for the throwaway embedding an arm is rendered from. Leading underscore
# on purpose: `voices._cloned_voices` skips underscore files, so a crashed run
# leaves a file the roster will not turn into a phantom Character.
STAGE_PREFIX = "_ab-"


def _out(line: str) -> None:
    """ASCII-only stdout -- this runs on a cp1252 Windows console."""
    print(line.encode("ascii", "replace").decode("ascii"))


# -- the arithmetic (pure; unit tested with synthetic vectors) -----------------
def distance(a: object, b: object) -> float | None:
    """Prosody distance in noticeable steps, or None when it is not measurable.

    Root-MEAN-square (not root-sum-square) over the fields both sides actually
    measured, so a pair that shares three features is comparable with a pair
    that shares five: the answer stays "how many steps apart, per field" instead
    of growing with how much happened to be measurable.
    """
    va, vb = prosody_vector(a), prosody_vector(b)
    if not va or not vb:
        return None
    shared = [f for f in FIELD_STEP if f in va and f in vb]
    if len(shared) < MIN_SHARED_FIELDS:
        return None
    total = 0.0
    for field in shared:
        step = FIELD_STEP[field]
        total += ((va[field] - vb[field]) / step) ** 2
    value = math.sqrt(total / len(shared))
    return None if not math.isfinite(value) else round(value, 6)


def quality(real: float, derived: float) -> float:
    """How well a derived render stands in for a real one. 1.0 is "as well".

    `1 / (1 + excess)` where `excess` is how many noticeable steps FURTHER from
    the target the derived arm sits than the real arm does. A ratio
    (`real / (real + derived)`) was the obvious alternative and is wrong here:
    the real arm's own distance can be near zero, and then every derived voice
    ever measured would score zero regardless of how good it was. Excess is
    stable at that boundary and reads in units a person can argue with -- 0.5 is
    "one step worse than the recording".
    """
    excess = max(0.0, float(derived) - float(real))
    return round(1.0 / (1.0 + excess), 4)


def arm_order(key: str) -> tuple[str, str]:
    """``(arm of the real render, arm of the derived render)`` for one pair.

    Deterministic (a re-run scores identically) but not systematic: the real
    arm is `A` for about half the pairs, so a scorer with a position bias shows
    up as noise rather than as a verdict.
    """
    flip = hashlib.sha256(key.encode("utf-8")).digest()[0] % 2
    return ("B", "A") if flip else ("A", "B")


def score_blind(arms: dict[str, object], target: object) -> dict[str, float | None]:
    """Distance from each arm to the target. Knows nothing about which is which."""
    return {name: distance(probe_result, target) for name, probe_result in arms.items()}


def compare(key: str, target: object, real_probe: object,
            derived_probe: object) -> dict:
    """One blind comparison, unblinded. Returns a report, never raises.

    ``{"quality": float|None, "real": float|None, "derived": float|None,
    "excess": float|None, "real_arm": "A"|"B", "reason": str|None}`` -- a pair
    that could not be measured reports `quality: None` with the reason NAMED,
    and contributes nothing to the published number.
    """
    real_arm, derived_arm = arm_order(key)
    scored = score_blind({real_arm: real_probe, derived_arm: derived_probe}, target)
    d_real, d_derived = scored[real_arm], scored[derived_arm]
    report: dict = {"quality": None, "real": d_real, "derived": d_derived,
                    "excess": None, "real_arm": real_arm, "reason": None}
    if d_real is None or d_derived is None:
        report["reason"] = ("too few measurable prosody fields in common to "
                            "compare these renders")
        return report
    report["excess"] = round(max(0.0, d_derived - d_real), 6)
    report["quality"] = quality(d_real, d_derived)
    return report


def aggregate(qualities: list[float]) -> float | None:
    """The published number for one emotion: the MEDIAN of its pairs.

    Median for the same reason `calibrate_alpha` uses one -- one speaker whose
    derived take happens to land badly must not be able to condemn an emotion
    for every other speaker, and one that lands perfectly must not license it.
    """
    if not qualities:
        return None
    return round(float(np.median(np.asarray(qualities, dtype=np.float64))), 4)


# -- planning (pure; reads the registry, needs no engine) ---------------------
def _recorded(row: dict) -> bool:
    return row.get("origin") != "derived"


def candidates(voices: dict, basis: emotion_basis.Basis,
               emotions: list[str] | None = None) -> list[tuple[str, str, str, str]]:
    """``[(emotion, character_id, real_voice_id, baseline_voice_id)]``, sorted.

    A pair is testable only when the speaker has BOTH a recorded baseline (to
    derive from) and a recorded take of the emotion (to be judged against), and
    that take carries a stored prosody probe (the target). Sorted so two runs
    with `--limit` cover the same pairs.
    """
    wanted = set(emotions or basis.emotions)
    by_char: dict[str, dict[str, tuple[str, dict]]] = {}
    for vid, row in (voices or {}).items():
        if not isinstance(row, dict):
            continue
        cid, emotion = row.get("character_id"), row.get("emotion")
        if not cid or not emotion or not _recorded(row):
            continue
        by_char.setdefault(str(cid), {})[str(emotion)] = (vid, row)

    out: list[tuple[str, str, str, str]] = []
    for cid in sorted(by_char):
        slots = by_char[cid]
        base = slots.get(BASELINE)
        if base is None:
            continue
        for emotion in sorted(wanted & set(slots)):
            if emotion == BASELINE or emotion not in basis.emotions:
                continue
            vid, row = slots[emotion]
            if not isinstance(row.get("prosody"), dict):
                continue  # nothing to be judged against
            out.append((emotion, cid, vid, base[0]))
    out.sort()
    return out


# -- rendering (needs the engine) ---------------------------------------------
def stage_derived(voices_dir: Path, baseline_voice_id: str,
                  entry: emotion_basis.EmotionBasis) -> tuple[str, Path]:
    """Write the derived embedding the engine will speak. ``(voice_id, path)``.

    Written INTO the voices directory because that is the only place the engine
    resolves a voice id from (`engine._voice_state`), under a unique underscore
    name so it is invisible to the roster and cannot collide with a real slot or
    with a concurrent run. The caller deletes it; a crash leaves a file that
    nothing but this tool will ever look at.
    """
    tensors = res.load_embedding(voices_dir / f"{baseline_voice_id}.safetensors")
    derived, reason = emotion_basis.derive_tensors(tensors, entry.vector, entry.alpha)
    if derived is None:
        raise ValueError(reason or "the derived embedding could not be built")
    voice_id = f"{STAGE_PREFIX}{entry.emotion}-{uuid.uuid4().hex[:8]}"
    path = voices_dir / f"{voice_id}.safetensors"
    res.save_embedding(path, derived)
    return voice_id, path


def run(voices_dir: Path, *, emotions: list[str] | None = None,
        limit: int | None = None, dry_run: bool = False, text: str = AB_TEXT,
        measure_fn=measure, write: bool = True) -> int:
    """Measure, then publish. Returns a process exit code (always 0 here).

    `measure_fn(engine, voice_id, text, workdir) -> probe dict` is the ONE seam
    the tests replace: everything above it is arithmetic this box can prove, and
    everything below it needs a model.
    """
    registry = load_registry(voices_dir)
    basis, reason = emotion_basis.load(voices_dir)
    if basis is None:
        _out(f"derive_ab: skipped: {reason}")
        return 0

    pairs = candidates(registry["voices"], basis, emotions)
    if limit is not None:
        pairs = pairs[:max(0, limit)]
    _out(f"derive_ab: {len(pairs)} testable pair(s) across "
         f"{len(basis.emotions)} basis emotion(s)")
    if not pairs:
        _out("derive_ab: nothing to measure -- a pair needs a speaker with BOTH "
             "a recorded baseline and a recorded, probed take of the emotion")
        return 0
    if dry_run:
        for emotion, cid, vid, base in pairs:
            _out(f"  {emotion}: would compare {cid} real {vid} vs derived from {base}")
        return 0

    engine, why = open_engine()
    if engine is None:
        for emotion, cid, _vid, _base in pairs:
            _out(f"  {emotion}/{cid}: skipped: {why}")
        _out(f"derive_ab: 0 of {len(pairs)} pairs measured, skipped: {why}")
        return 0

    scored: dict[str, list[float]] = {}
    tested: dict[str, set[str]] = {}
    try:
        with tempfile.TemporaryDirectory(prefix="derive-ab-") as tmp:
            work = Path(tmp)
            for emotion, cid, real_vid, base_vid in pairs:
                entry = basis.emotions[emotion]
                staged: Path | None = None
                try:
                    derived_vid, staged = stage_derived(voices_dir, base_vid, entry)
                    real_probe = measure_fn(engine, real_vid, text, work)
                    derived_probe = measure_fn(engine, derived_vid, text, work)
                except Exception as exc:  # noqa: BLE001 - one pair, not the run
                    _out(f"  {emotion}/{cid}: skipped: render failed "
                         f"({type(exc).__name__}: {exc})")
                    continue
                finally:
                    if staged is not None:
                        staged.unlink(missing_ok=True)
                target = (registry["voices"].get(real_vid) or {}).get("prosody")
                report = compare(f"{emotion}/{cid}", target, real_probe, derived_probe)
                if report["quality"] is None:
                    _out(f"  {emotion}/{cid}: unmeasured: {report['reason']}")
                    continue
                scored.setdefault(emotion, []).append(report["quality"])
                tested.setdefault(emotion, set()).add(cid)
                _out(f"  {emotion}/{cid}: quality {report['quality']:.2f} "
                     f"(real {report['real']:.2f} vs derived {report['derived']:.2f} "
                     f"steps from the stored probe)")
    finally:
        try:
            engine.stop()
        except Exception:  # noqa: BLE001 - shutdown must not mask results
            pass

    results = publishable(scored, tested, basis)
    for emotion, entry in sorted(results.items()):
        verdict = ("PASSES" if entry["quality"] >= emotion_basis.MIN_TRANSFER_QUALITY
                   else "FAILS")
        _out(f"derive_ab: {emotion}: quality {entry['quality']:.2f} across "
             f"{entry['speakers']} speaker(s), {entry['in_sample']} of them in the "
             f"basis -- {verdict} the {emotion_basis.MIN_TRANSFER_QUALITY:.2f} bar")
    if not results:
        _out("derive_ab: nothing measurable -- writing nothing")
        return 0
    if not write:
        _out("derive_ab: --no-write, the basis manifest was not touched")
        return 0
    refusal = emotion_basis.write_transfer(voices_dir, results)
    _out(f"derive_ab: {len(results)} emotion(s) recorded" if refusal is None
         else f"derive_ab: not recorded: {refusal}")
    return 0


def publishable(scored: dict[str, list[float]], tested: dict[str, set[str]],
                basis: emotion_basis.Basis) -> dict[str, dict]:
    """The per-emotion rows :func:`emotion_basis.write_transfer` stores.

    `in_sample` is the count of tested speakers who ALSO contributed to the
    direction being tested. It is published rather than corrected for: with a
    small corpus every testable speaker is usually a contributor, and a number
    labelled optimistic is more use than a number silently withheld.
    """
    out: dict[str, dict] = {}
    for emotion, qualities in scored.items():
        value = aggregate(qualities)
        if value is None:
            continue
        speakers = sorted(tested.get(emotion, ()))
        contributors = set(basis.emotions[emotion].contributors)
        out[emotion] = {
            "quality": value,
            "speakers": len(speakers),
            "in_sample": len([c for c in speakers if c in contributors]),
        }
    return out


def main(argv: list[str] | None = None) -> int:  # pragma: no cover - CLI
    ap = argparse.ArgumentParser(
        prog="derive_ab",
        description="Blind A/B the derived voices against the recordings they "
                    "stand in for, and publish per-emotion transfer quality.")
    ap.add_argument("--voices-dir", default=str(SETTINGS.voices_dir))
    ap.add_argument("--emotion", action="append", dest="emotions", default=None,
                    help="measure only this emotion (repeatable)")
    ap.add_argument("--limit", type=int, default=None,
                    help="test at most N pairs (resumable: stable order)")
    ap.add_argument("--dry-run", action="store_true",
                    help="list the pairs that would be compared and exit")
    ap.add_argument("--no-write", action="store_true",
                    help="report only; leave _basis.json untouched")
    args = ap.parse_args(argv)
    return run(Path(args.voices_dir), emotions=args.emotions, limit=args.limit,
               dry_run=args.dry_run, write=not args.no_write)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
