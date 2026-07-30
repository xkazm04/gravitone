"""The shared emotion basis: averaged residuals, per-emotion coherence, alpha.

`service/tools/emotion_residuals.py` asks whether `(emotion - baseline)`
transfers between speakers. This module is what you build ONCE that answer is
yes: for every emotion that cleared the bar, the residuals of all contributing
speakers are averaged into a single unit direction and persisted as

    voices/_basis.safetensors   one tensor per emotion: the unit direction
    voices/_basis.json          version, layout, contributors, coherence, alpha

`baseline + alpha * direction` is then a synthetic embedding for that emotion on
ANY speaker whose baseline flattens to the same layout.

Three rules the rest of the batch depends on:

  * **Built on demand, never at request time.** :func:`build` walks every
    embedding in the registry (seconds to minutes); the derive endpoint only
    ever :func:`load`s the result. A missing basis is a NAMED refusal, not a
    lazy rebuild inside somebody's HTTP request.
  * **The coherence gate is inside the file.** Every emotion carries the mean
    pairwise cosine it was built from, and :func:`direction` refuses anything
    below :data:`MIN_COHERENCE`. An emotion that does not transfer cannot be
    derived even by a caller that asks for it directly.
  * **alpha is measured, not chosen.** It is calibrated LEAVE-ONE-SPEAKER-OUT:
    for each contributor, the direction is re-averaged from the OTHER speakers
    and alpha is how far that speaker's REAL take actually sits along it. The
    stored alpha is the median of those held-out answers, so it is a fit to
    speakers the direction had never seen -- not to the ones that built it.

On a box without `safetensors` every path here degrades the same named way as
the tool (:class:`~service.tools.emotion_residuals.TensorsUnavailable`), and the
arithmetic is unit-tested over synthetic tensors with known geometry.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from service.emotions import BASELINE
from service.tools import emotion_residuals as res
from service.tools.emotion_residuals import TensorsUnavailable

logger = logging.getLogger("gravitone")

BASIS_VERSION = 1
BASIS_TENSORS = "_basis.safetensors"
BASIS_JSON = "_basis.json"

# The same bar the measurement gate calls `go`. Named separately because THIS is
# the one the product enforces: an emotion below it is refused at derive time
# with its own number in the message.
MIN_COHERENCE = res.GO_COSINE

# A speaker whose slot count is below this contributes no residual at all (it
# has no baseline to subtract from, or nothing to subtract).
MIN_CONTRIBUTORS = res.MIN_SPEAKERS


@dataclass(frozen=True)
class EmotionBasis:
    """One emotion's portable direction, with everything needed to doubt it."""
    emotion: str
    vector: np.ndarray          # unit length, in `layout` order
    alpha: float                # calibrated step, held out from the contributors
    coherence: float            # mean pairwise cosine across contributors
    contributors: tuple[str, ...]
    held_out: int               # how many speakers alpha was fitted against


@dataclass(frozen=True)
class Basis:
    """A loaded `_basis` pair. `emotions` is keyed by emotion name."""
    version: int
    created: str
    layout: tuple[tuple[str, tuple[int, ...]], ...]
    emotions: dict[str, EmotionBasis] = field(default_factory=dict)

    @property
    def dim(self) -> int:
        n = 0
        for _key, shape in self.layout:
            size = 1
            for d in shape:
                size *= int(d)
            n += size
        return n


def paths(voices_dir: Path | str) -> tuple[Path, Path]:
    """``(tensors, json)`` for a voices directory."""
    d = Path(voices_dir)
    return d / BASIS_TENSORS, d / BASIS_JSON


# -- calibration --------------------------------------------------------------
def calibrate_alpha(residuals: dict[str, np.ndarray]) -> tuple[float | None, int]:
    """``(alpha, held_out)`` -- how far along the direction a real take sits.

    Leave-one-speaker-out, which is the only version of this number worth
    storing: fitting alpha against the same residuals that built the direction
    would measure how well the average describes its own inputs, and would grow
    with speaker count rather than with truth.

    For each speaker: build the direction from everyone ELSE, then project that
    speaker's real residual onto it (`dot`, since the direction is unit length).
    The result is the MEDIAN of those projections -- a mean lets one outlying
    take set the step size for every future derived voice. Returns
    ``(None, 0)`` when fewer than two speakers contributed, because with one
    speaker "held out" means nothing.
    """
    names = sorted(residuals)
    if len(names) < MIN_CONTRIBUTORS:
        return None, 0
    projections: list[float] = []
    for name in names:
        others = [residuals[n] for n in names if n != name]
        direction = res.unit(np.mean(np.stack(others), axis=0))
        if direction is None:
            continue
        projections.append(float(np.dot(
            np.asarray(residuals[name], dtype=np.float64).reshape(-1), direction)))
    if not projections:
        return None, 0
    return float(np.median(projections)), len(projections)


def _basis_for(emotion: str, residuals: dict[str, np.ndarray],
               coherence_mean: float) -> EmotionBasis | None:
    """One EmotionBasis, or None when the emotion cannot carry one."""
    direction = res.unit(np.mean(np.stack([residuals[n] for n in sorted(residuals)]),
                                 axis=0))
    if direction is None:
        # The residuals cancel out: they disagree so completely that their
        # average points nowhere. There is no direction to store.
        return None
    alpha, held_out = calibrate_alpha(residuals)
    if alpha is None or not np.isfinite(alpha) or abs(alpha) <= 0.0:
        return None
    return EmotionBasis(
        emotion=emotion, vector=direction, alpha=round(float(alpha), 6),
        coherence=round(float(coherence_mean), 4),
        contributors=tuple(sorted(residuals)), held_out=held_out)


# -- build --------------------------------------------------------------------
def build(voices_dir: Path | str, *, min_coherence: float = MIN_COHERENCE,
          on_skip=None) -> dict:
    """Regenerate `_basis.safetensors` + `_basis.json`. Returns a report.

    Raises :class:`TensorsUnavailable` when the embeddings cannot be read on
    this box -- the caller (a CLI, a test, an operator) is told once, in the one
    place that knows why.

    Emotions BELOW ``min_coherence`` are reported with their number and their
    verdict and are NOT written: a basis file that contains a direction nobody
    may use is a trap for the next reader.
    """
    voices_dir = Path(voices_dir)
    meta = res.load_meta(voices_dir)
    grouped = res.group_registry(meta)
    vectors = res.load_vectors(voices_dir, grouped, on_skip=on_skip)
    report = res.analyze(vectors)

    layout: tuple[tuple[str, tuple[int, ...]], ...] | None = None
    for cid in sorted(grouped):
        if cid in vectors and BASELINE in grouped[cid]:
            path = voices_dir / f"{grouped[cid][BASELINE]}.safetensors"
            try:
                layout = res.layout_of(res.load_embedding(path))
            except TensorsUnavailable:
                raise
            except Exception:  # noqa: BLE001 - try the next speaker's baseline
                continue
            break

    residuals = res.residuals_by_emotion(vectors)
    built: dict[str, EmotionBasis] = {}
    rejected: dict[str, dict] = {}
    for emotion in sorted(residuals):
        entry = report["emotions"][emotion]
        mean = entry.get("mean")
        if entry["verdict"] == "no-data" or mean is None or mean < min_coherence:
            rejected[emotion] = {"coherence": mean, "verdict": entry["verdict"],
                                 "speakers": entry["speakers"]}
            continue
        basis = _basis_for(emotion, residuals[emotion], float(mean))
        if basis is None:
            rejected[emotion] = {"coherence": mean, "verdict": "no-direction",
                                 "speakers": entry["speakers"]}
            continue
        built[emotion] = basis

    created = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    if built and layout is not None:
        write(voices_dir, layout=layout, emotions=built, created=created)

    return {
        "created": created,
        "version": BASIS_VERSION,
        "written": bool(built and layout is not None),
        "min_coherence": min_coherence,
        "derived_from": report["summary"],
        "emotions": {
            e: {"coherence": b.coherence, "alpha": b.alpha,
                "contributors": list(b.contributors), "held_out": b.held_out}
            for e, b in built.items()
        },
        "rejected": rejected,
    }


def write(voices_dir: Path | str, *, layout, emotions: dict[str, EmotionBasis],
          created: str | None = None) -> None:
    """Persist a basis. Tensors first, manifest second -- see :func:`load`."""
    voices_dir = Path(voices_dir)
    voices_dir.mkdir(parents=True, exist_ok=True)
    tensors_path, json_path = paths(voices_dir)
    created = created or datetime.now(timezone.utc).isoformat(
        timespec="seconds").replace("+00:00", "Z")

    # Tensors BEFORE the manifest: `load` requires both, and reads the manifest
    # first, so a crash between the two writes leaves a basis that reports
    # "not built" rather than a manifest promising vectors that are not there.
    res.save_embedding(tensors_path, {e: np.asarray(b.vector, dtype=np.float32)
                                      for e, b in emotions.items()})
    json_path.write_text(json.dumps({
        "version": BASIS_VERSION,
        "created": created,
        "layout": [[k, list(shape)] for k, shape in layout],
        "emotions": {
            e: {"alpha": b.alpha, "coherence": b.coherence,
                "contributors": list(b.contributors), "held_out": b.held_out}
            for e, b in sorted(emotions.items())
        },
    }, indent=2), "utf-8")


def load(voices_dir: Path | str) -> tuple[Basis | None, str | None]:
    """``(basis, None)`` or ``(None, reason)``. NEVER raises.

    Every failure is a sentence the derive endpoint can hand to a user
    verbatim: no basis has been built, the manifest is damaged, the tensors are
    unreadable on this box. "It did not work" is not one of them.
    """
    voices_dir = Path(voices_dir)
    tensors_path, json_path = paths(voices_dir)
    if not json_path.is_file() or not tensors_path.is_file():
        return None, ("no emotion basis has been built for this install -- run "
                      "'python -m service.emotion_basis' once the residual gate "
                      "reports a go")
    try:
        raw = json.loads(json_path.read_text("utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        return None, f"the emotion basis manifest is unreadable ({exc})"
    if not isinstance(raw, dict) or raw.get("version") != BASIS_VERSION:
        return None, (f"the emotion basis was built by a different version "
                      f"({raw.get('version') if isinstance(raw, dict) else 'unknown'}, "
                      f"this service reads {BASIS_VERSION}) -- rebuild it")
    try:
        tensors = res.load_embedding(tensors_path)
    except TensorsUnavailable as exc:
        return None, str(exc)
    except Exception as exc:  # noqa: BLE001
        return None, f"the emotion basis tensors are unreadable ({exc})"

    layout = tuple((str(k), tuple(int(d) for d in shape))
                   for k, shape in (raw.get("layout") or []))
    emotions: dict[str, EmotionBasis] = {}
    for emotion, meta in (raw.get("emotions") or {}).items():
        vector = tensors.get(emotion)
        if vector is None or not isinstance(meta, dict):
            continue
        try:
            emotions[emotion] = EmotionBasis(
                emotion=emotion,
                vector=np.asarray(vector, dtype=np.float64).reshape(-1),
                alpha=float(meta["alpha"]), coherence=float(meta["coherence"]),
                contributors=tuple(str(c) for c in (meta.get("contributors") or [])),
                held_out=int(meta.get("held_out") or 0))
        except (KeyError, TypeError, ValueError):
            continue  # one malformed entry, not the whole basis
    if not emotions:
        return None, "the emotion basis contains no usable directions -- rebuild it"
    return Basis(version=BASIS_VERSION, created=str(raw.get("created") or ""),
                 layout=layout, emotions=emotions), None


def direction(basis: Basis, emotion: str, *,
              min_coherence: float = MIN_COHERENCE) -> tuple[EmotionBasis | None, str | None]:
    """``(entry, None)`` or ``(None, reason)`` -- the coherence gate, enforced.

    The refusal names the number AND the bar, because "not confident enough" is
    not something a user can act on and "0.21, needs 0.35" is: it says record
    another speaker's take of this emotion and rebuild.
    """
    entry = basis.emotions.get(emotion)
    if entry is None:
        return None, (f"the emotion basis has no '{emotion}' direction "
                      f"(it carries: {', '.join(sorted(basis.emotions)) or 'nothing'})")
    if entry.coherence < min_coherence:
        return None, (f"'{emotion}' does not transfer between speakers well enough "
                      f"to derive (coherence {entry.coherence:.2f}, needs "
                      f"{min_coherence:.2f}) -- record it, or add another speaker's "
                      f"take and rebuild the basis")
    return entry, None


def donor_direction(baseline: dict[str, np.ndarray], emotion_take: dict[str, np.ndarray],
                    ) -> tuple[np.ndarray | None, float, str | None]:
    """One speaker's own residual: ``(unit vector, alpha, None)`` or a reason.

    The other half of the merged feature (character-voice-management M1): rather
    than the roster-wide average, use ONE named donor's take. `alpha` is the
    LENGTH of that donor's residual, so `unit * alpha` reproduces the donor's
    delta exactly -- this path transplants a specific performance rather than
    stepping along an average, and there is no calibration to do because the
    donor already showed how far it went.

    Weaker evidence than the basis -- a single speaker is not a measurement of
    transferability -- which is exactly why the derived Voice records who it came
    from and the rack never shows it as recorded.
    """
    base = res.flatten(baseline)
    take = res.flatten(emotion_take)
    if base.size == 0 or base.shape != take.shape:
        return None, 0.0, ("the donor's embedding does not have the same shape as "
                           "this character's baseline -- they were made by "
                           "different models")
    delta = take - base
    vec = res.unit(delta)
    if vec is None:
        return None, 0.0, ("the donor's take is identical to its own baseline, so "
                           "there is no emotion in it to transfer")
    return vec, float(np.linalg.norm(delta)), None


def derive_tensors(baseline: dict[str, np.ndarray], vector: np.ndarray, alpha: float,
                   ) -> tuple[dict[str, np.ndarray] | None, str | None]:
    """``baseline + alpha * vector``, back in the baseline's own tensor layout.

    Returns ``(tensors, None)`` or ``(None, reason)``. Each output tensor keeps
    its source dtype, so the derived file is byte-compatible with what the
    exporter writes and the serving worker loads.
    """
    flat = res.flatten(baseline)
    vector = np.asarray(vector, dtype=np.float64).reshape(-1)
    if flat.size == 0:
        return None, "this character's baseline embedding is empty"
    if flat.shape != vector.shape:
        return None, (f"the emotion basis was built for embeddings of "
                      f"{vector.size} values and this baseline has {flat.size} "
                      "-- rebuild the basis")
    moved = flat + float(alpha) * vector
    if not np.all(np.isfinite(moved)):
        return None, "the derived embedding is not finite -- refusing to write it"
    try:
        parts = res.unflatten(moved, res.layout_of(baseline))
    except ValueError as exc:
        return None, f"the derived embedding does not fit the baseline layout ({exc})"
    return {k: parts[k].astype(np.asarray(baseline[k]).dtype, copy=False)
            for k in parts}, None


def main(argv: list[str] | None = None) -> int:  # pragma: no cover - CLI
    import argparse

    from service.config import SETTINGS

    ap = argparse.ArgumentParser(
        prog="emotion_basis",
        description="Average per-emotion residuals into a portable emotion basis.")
    ap.add_argument("--voices-dir", default=str(SETTINGS.voices_dir))
    ap.add_argument("--min-coherence", type=float, default=MIN_COHERENCE)
    args = ap.parse_args(argv)

    def _out(line: str) -> None:
        print(line.encode("ascii", "replace").decode("ascii"))

    try:
        report = build(Path(args.voices_dir), min_coherence=args.min_coherence,
                       on_skip=lambda c, e, why: _out(f"  skipped {c}/{e}: {why}"))
    except TensorsUnavailable as exc:
        _out(f"emotion_basis: skipped: {exc}")
        return 0
    for emotion, meta in report["emotions"].items():
        _out(f"  {emotion}: coherence {meta['coherence']:.4f}, alpha {meta['alpha']:.4f}, "
             f"{len(meta['contributors'])} contributor(s)")
    for emotion, meta in report["rejected"].items():
        _out(f"  {emotion}: NOT built ({meta['verdict']}, coherence {meta['coherence']})")
    _out(f"emotion_basis: {'written' if report['written'] else 'nothing written'} "
         f"({len(report['emotions'])} emotion(s))")
    return 0


if __name__ == "__main__":  # pragma: no cover
    import sys
    sys.exit(main())
