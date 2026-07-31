"""Does an emotion TRAVEL? The measurement that decides Emotion Algebra.

The whole of `service/emotions.py` rests on one stated law: "Pocket TTS has no
emotion/style conditioner -- expression lives entirely in the reference audio",
so an emotion is literally a different recording of the same person. Emotion
Algebra proposes to break that law by treating expression as a **transferable
direction in embedding space**: if `(angry - baseline)` points the same way for
Mary as it does for Paul, then that averaged direction is portable, and
`baseline + alpha * direction` is a synthetic `angry` for a speaker who never
recorded one.

**That "if" is the whole feature, and this module is the only thing allowed to
answer it.** Nothing else in the batch may assume the answer: `emotion_basis`
refuses to build below the coherence bar this module computes, and the derive
endpoint refuses to write a Voice for an emotion the basis would not carry.

What it does:

  * group every registered embedding by `(character_id, emotion)` straight out
    of the registry (`voices/_meta.json`);
  * for each speaker holding `baseline` plus at least one other slot, compute
    `emotion - baseline` -- that speaker's residual for the emotion;
  * report the pairwise cosine of same-emotion residuals ACROSS speakers, per
    emotion, plus a go / no-go summary.

Two honesty rules, both asserted in `test_emotion_residuals`:

  * **A single speaker is not evidence.** One residual has nothing to be
    compared with, so the emotion reports `no-data` -- never a cosine of 1.0
    against itself.
  * **Between the bars is not a "yes".** Anything from `NOGO_COSINE` to
    `GO_COSINE` is `inconclusive` (record more speakers), and inconclusive is
    not a licence to derive.

**This box cannot run the real thing.** Reading a `.safetensors` needs the
`safetensors` package, which (like torch) is absent outside the container -- so
:func:`load_embedding` degrades NAMED (`TensorsUnavailable`) and the CLI reports
`skipped: <reason>` per speaker instead of pretending. The arithmetic above is
pure numpy and is exercised on synthetic tensors with KNOWN geometry, so the
math is proven here and only the corpus needs the Arm box.

Run:

    python -m service.tools.emotion_residuals
    python -m service.tools.emotion_residuals --json
    python -m service.tools.emotion_residuals --emotion angry
"""
from __future__ import annotations

import argparse
import itertools
import json
import sys
from collections.abc import Mapping
from pathlib import Path

import numpy as np

from service.emotions import BASELINE

# The bars. A residual direction that transfers between two DIFFERENT speakers
# is the claim; cosine is how much of the claim survives. Random high-dimensional
# vectors sit at ~0, so these are absolute, not relative to a null model:
#   >= GO_COSINE     the direction is shared -- derive from it
#   <  NOGO_COSINE   the direction is personal -- Emotion Algebra is dead here
#   between          not enough agreement to act on, not enough to give up on
GO_COSINE = 0.35
NOGO_COSINE = 0.15

# One residual cannot be compared with anything. Two speakers give exactly one
# pair, which is the minimum that is evidence at all (and is reported as such --
# `pairs` travels with every verdict so a thin corpus is visible).
MIN_SPEAKERS = 2

_ZERO_NORM = 1e-12


class TensorsUnavailable(RuntimeError):
    """The embedding files cannot be read HERE, and we say which and why.

    Not an empty result: "no residuals" and "nothing could be loaded" are
    different findings, and only one of them is a verdict about the product.
    """


def tensor_backend():
    """``(load_file, save_file)`` for ``.safetensors``, or TensorsUnavailable.

    ``safetensors.numpy`` on purpose: the embeddings are a plain tensor dict, so
    the numpy backend reads and writes exactly the same bytes as the torch one
    while needing neither torch nor a model load. That keeps every path in this
    batch runnable on any box that has the (pure-python + numpy) package, and
    keeps the failure honest on a box that has neither.
    """
    try:
        from safetensors.numpy import load_file, save_file
    except Exception as exc:  # noqa: BLE001 - any import failure is "unavailable"
        raise TensorsUnavailable(
            f"safetensors is not installed ({type(exc).__name__}: {exc}) -- "
            "embeddings cannot be read or written on this box") from exc
    return load_file, save_file


def load_embedding(path: Path | str) -> dict[str, np.ndarray]:
    """One embedding as ``{tensor name: ndarray}``. Raises TensorsUnavailable.

    THE seam. Every embedding-touching path in this feature (the tool, the basis
    builder, the derive endpoint) reads through this one function, so a test can
    substitute synthetic tensors in a single place and a box without
    `safetensors` fails in a single, named way.
    """
    load_file, _save = tensor_backend()
    return {k: np.asarray(v) for k, v in load_file(str(path)).items()}


def save_embedding(path: Path | str, tensors: Mapping[str, np.ndarray]) -> None:
    """Write ``{tensor name: ndarray}`` to a ``.safetensors``. The seam's other half."""
    _load, save_file = tensor_backend()
    save_file({k: np.asarray(v) for k, v in tensors.items()}, str(path))


# -- pure geometry (numpy only; no model, no files) ---------------------------
def layout_of(tensors: Mapping[str, np.ndarray]) -> tuple[tuple[str, tuple[int, ...]], ...]:
    """The (name, shape) list, in SORTED key order.

    Sorted because :func:`flatten` concatenates in this order and two embeddings
    are only comparable if they flatten the same way -- dict order would make
    the arithmetic depend on which file was written first.
    """
    return tuple((k, tuple(np.asarray(tensors[k]).shape)) for k in sorted(tensors))


def flatten(tensors: Mapping[str, np.ndarray]) -> np.ndarray:
    """Every tensor concatenated into one float64 vector, in layout order."""
    parts = [np.asarray(tensors[k], dtype=np.float64).reshape(-1) for k in sorted(tensors)]
    if not parts:
        return np.zeros(0, dtype=np.float64)
    return np.concatenate(parts)


def unflatten(vec: np.ndarray, layout) -> dict[str, np.ndarray]:
    """The inverse of :func:`flatten`. ValueError if the vector does not fit.

    A mismatch is refused rather than truncated: a derived embedding that is
    silently the wrong shape is a file the serving worker cannot load, found at
    synthesis time long after the user has left.
    """
    vec = np.asarray(vec, dtype=np.float64).reshape(-1)
    out: dict[str, np.ndarray] = {}
    at = 0
    for key, shape in layout:
        shape = tuple(int(d) for d in shape)
        n = 1
        for d in shape:
            n *= d
        if at + n > vec.size:
            raise ValueError(f"vector is too short for layout at '{key}'")
        out[key] = vec[at:at + n].reshape(shape)
        at += n
    if at != vec.size:
        raise ValueError("vector is longer than the layout accounts for")
    return out


def cosine(a: np.ndarray, b: np.ndarray) -> float | None:
    """Cosine similarity, or None when the question cannot be asked.

    None for a shape mismatch (two embeddings of different models are not two
    opinions about the same thing) and for a zero vector (no direction at all).
    """
    a = np.asarray(a, dtype=np.float64).reshape(-1)
    b = np.asarray(b, dtype=np.float64).reshape(-1)
    if a.size == 0 or a.shape != b.shape:
        return None
    na = float(np.linalg.norm(a))
    nb = float(np.linalg.norm(b))
    if na <= _ZERO_NORM or nb <= _ZERO_NORM:
        return None
    return float(np.clip(np.dot(a, b) / (na * nb), -1.0, 1.0))


def unit(vec: np.ndarray) -> np.ndarray | None:
    """``vec`` scaled to length 1, or None when it points nowhere."""
    vec = np.asarray(vec, dtype=np.float64).reshape(-1)
    n = float(np.linalg.norm(vec))
    if n <= _ZERO_NORM:
        return None
    return vec / n


def residuals_by_emotion(
    vectors: Mapping[str, Mapping[str, np.ndarray]],
) -> dict[str, dict[str, np.ndarray]]:
    """``{emotion: {character_id: emotion - baseline}}`` over multi-slot speakers.

    ``vectors`` is ``{character_id: {emotion: flattened embedding}}``. A speaker
    with no baseline contributes nothing (there is no origin to subtract from),
    and so does a slot whose vector is a different length than that speaker's
    baseline.
    """
    out: dict[str, dict[str, np.ndarray]] = {}
    for cid in sorted(vectors):
        slots = vectors[cid]
        base = slots.get(BASELINE)
        if base is None:
            continue
        base = np.asarray(base, dtype=np.float64).reshape(-1)
        for emotion in sorted(slots):
            if emotion == BASELINE:
                continue
            vec = np.asarray(slots[emotion], dtype=np.float64).reshape(-1)
            if vec.shape != base.shape:
                continue
            out.setdefault(emotion, {})[cid] = vec - base
    return out


def coherence(residuals: Mapping[str, np.ndarray]) -> dict:
    """Pairwise cosine of one emotion's residuals ACROSS speakers.

    ``{"speakers", "pairs", "mean", "min", "max"}``. `mean` is None when there
    was no pair to measure -- one speaker's residual has nothing to agree with,
    and a self-comparison of 1.0 would be the single most misleading number this
    feature could print.
    """
    speakers = sorted(residuals)
    scores: list[float] = []
    for a, b in itertools.combinations(speakers, 2):
        c = cosine(residuals[a], residuals[b])
        if c is not None:
            scores.append(c)
    if not scores:
        return {"speakers": speakers, "pairs": 0,
                "mean": None, "min": None, "max": None}
    return {
        "speakers": speakers,
        "pairs": len(scores),
        "mean": round(sum(scores) / len(scores), 4),
        "min": round(min(scores), 4),
        "max": round(max(scores), 4),
    }


def verdict(entry: Mapping[str, object], *, go: float = GO_COSINE,
            nogo: float = NOGO_COSINE) -> str:
    """`no-data` | `no-go` | `inconclusive` | `go` for one emotion's coherence."""
    speakers = entry.get("speakers") or []
    mean = entry.get("mean")
    if len(speakers) < MIN_SPEAKERS or not entry.get("pairs") or mean is None:
        return "no-data"
    if mean >= go:
        return "go"
    if mean < nogo:
        return "no-go"
    return "inconclusive"


def analyze(vectors: Mapping[str, Mapping[str, np.ndarray]], *,
            go: float = GO_COSINE, nogo: float = NOGO_COSINE) -> dict:
    """The whole measurement: per-emotion coherence plus a go/no-go summary.

    The summary's `verdict` is deliberately conservative:

      * `go` -- at least one emotion cleared the bar (that emotion, and only
        that emotion, may be derived);
      * `no-go` -- every emotion that COULD be measured came back below
        `NOGO_COSINE`: residuals are personal, and the feature is dead as
        designed;
      * `inconclusive` -- something was measured, nothing was decided;
      * `no-data` -- no emotion had two speakers. Not a verdict about the idea,
        a verdict about the corpus.
    """
    residuals = residuals_by_emotion(vectors)
    emotions: dict[str, dict] = {}
    for emotion in sorted(residuals):
        entry = coherence(residuals[emotion])
        entry["verdict"] = verdict(entry, go=go, nogo=nogo)
        emotions[emotion] = entry

    decided = [e for e in emotions.values() if e["verdict"] != "no-data"]
    if any(e["verdict"] == "go" for e in emotions.values()):
        overall = "go"
    elif not decided:
        overall = "no-data"
    elif all(e["verdict"] == "no-go" for e in decided):
        overall = "no-go"
    else:
        overall = "inconclusive"

    return {
        "emotions": emotions,
        "summary": {
            "verdict": overall,
            "go_threshold": go,
            "nogo_threshold": nogo,
            "speakers": sorted(vectors),
            "emotions_measured": len(decided),
            "derivable": sorted(e for e, v in emotions.items() if v["verdict"] == "go"),
        },
    }


# -- registry + files ---------------------------------------------------------
def _out(line: str) -> None:
    """ASCII-only stdout -- this runs on a cp1252 Windows console."""
    print(line.encode("ascii", "replace").decode("ascii"))


def load_meta(voices_dir: Path) -> dict:
    """The registry as JSON, without importing the service.

    Same posture as `tools/prosody_backfill`: this tool must be able to report a
    plan on a box where the service package will not import. Read-only -- this
    tool NEVER writes to the registry.
    """
    path = Path(voices_dir) / "_meta.json"
    if not path.is_file():
        return {"voices": {}}
    try:
        raw = json.loads(path.read_text("utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        _out(f"emotion_residuals: skipped: registry unreadable ({exc})")
        return {"voices": {}}
    voices = raw.get("voices") if isinstance(raw, dict) else None
    return {"voices": voices if isinstance(voices, dict) else {}}


def group_registry(meta: Mapping[str, object]) -> dict[str, dict[str, str]]:
    """``{character_id: {emotion: voice_id}}`` from registry rows.

    Duplicate slots are resolved the way the rest of the service resolves them
    (`voices._by_emotion`): the first id in sorted order wins and the rest are
    ignored, so this tool measures the voice that actually speaks.
    """
    rows = meta.get("voices") or {}
    grouped: dict[str, dict[str, str]] = {}
    if not isinstance(rows, Mapping):
        return grouped
    for vid in sorted(rows):
        row = rows[vid]
        if not isinstance(row, Mapping):
            continue
        cid, emotion = row.get("character_id"), row.get("emotion")
        if not isinstance(cid, str) or not isinstance(emotion, str):
            continue
        grouped.setdefault(cid, {}).setdefault(emotion, vid)
    return grouped


def load_vectors(voices_dir: Path, grouped: Mapping[str, Mapping[str, str]],
                 *, on_skip=None) -> dict[str, dict[str, np.ndarray]]:
    """``{character_id: {emotion: flattened embedding}}`` for multi-slot speakers.

    Speakers with fewer than two slots are never even opened: they cannot
    produce a residual, so loading them would be work with no possible answer.
    A file that will not read is a NAMED skip (via ``on_skip``), never a silent
    absence -- "we could not read Mary's angry" and "Mary has no angry" are
    different facts. Propagates TensorsUnavailable: that one is about the BOX,
    not about a file, and the caller reports it once instead of per voice.
    """
    vectors: dict[str, dict[str, np.ndarray]] = {}
    for cid in sorted(grouped):
        slots = grouped[cid]
        if len(slots) < 2 or BASELINE not in slots:
            continue
        loaded: dict[str, np.ndarray] = {}
        for emotion in sorted(slots):
            path = Path(voices_dir) / f"{slots[emotion]}.safetensors"
            try:
                loaded[emotion] = flatten(load_embedding(path))
            except TensorsUnavailable:
                raise
            except Exception as exc:  # noqa: BLE001 - one unreadable file, not the run
                if on_skip is not None:
                    on_skip(cid, emotion, f"{type(exc).__name__}: {exc}")
        if BASELINE in loaded and len(loaded) >= 2:
            vectors[cid] = loaded
    return vectors


def run(voices_dir: Path, *, as_json: bool = False,
        emotion: str | None = None) -> int:
    meta = load_meta(voices_dir)
    grouped = group_registry(meta)
    multi = {c: s for c, s in grouped.items() if len(s) >= 2 and BASELINE in s}
    if emotion:
        multi = {c: s for c, s in multi.items() if emotion in s}

    skips: list[str] = []
    try:
        vectors = load_vectors(
            voices_dir, multi,
            on_skip=lambda c, e, why: skips.append(f"{c}/{e}: {why}"))
    except TensorsUnavailable as exc:
        # The degrade this box takes. Named, and NOT a verdict: nothing was
        # measured, so nothing is claimed about whether emotions transfer.
        report = {"emotions": {}, "summary": {
            "verdict": "no-data", "skipped": str(exc),
            "speakers": sorted(multi), "emotions_measured": 0, "derivable": []}}
        if as_json:
            _out(json.dumps(report, indent=2))
        else:
            _out(f"emotion_residuals: skipped: {exc}")
            _out(f"emotion_residuals: {len(multi)} multi-slot speaker(s) would "
                 f"have been measured: {', '.join(sorted(multi)) or '(none)'}")
        return 0

    report = analyze(vectors)
    if emotion:
        report["emotions"] = {k: v for k, v in report["emotions"].items() if k == emotion}
    if skips:
        report["summary"]["unreadable"] = skips

    if as_json:
        _out(json.dumps(report, indent=2))
        return 0

    _out(f"emotion_residuals: {len(vectors)} multi-slot speaker(s) "
         f"(registry: {Path(voices_dir) / '_meta.json'})")
    for why in skips:
        _out(f"  skipped: {why}")
    if not report["emotions"]:
        _out("  no emotion has a residual on any speaker -- nothing to compare")
    for name, entry in report["emotions"].items():
        mean = entry["mean"]
        _out(f"  {name}: {entry['verdict']} "
             f"(mean cosine {'n/a' if mean is None else f'{mean:+.4f}'}, "
             f"{entry['pairs']} pair(s) across {len(entry['speakers'])} speaker(s))")
    s = report["summary"]
    _out(f"emotion_residuals: VERDICT {s['verdict']} "
         f"(go >= {s['go_threshold']}, no-go < {s['nogo_threshold']}); "
         f"derivable: {', '.join(s['derivable']) or '(none)'}")
    return 0


def main(argv: list[str] | None = None) -> int:
    from service.config import SETTINGS

    ap = argparse.ArgumentParser(
        prog="emotion_residuals",
        description="Measure whether (emotion - baseline) residuals transfer "
                    "between speakers. The go/no-go gate for Emotion Algebra.")
    ap.add_argument("--voices-dir", default=str(SETTINGS.voices_dir),
                    help="registry directory (default: the configured voices dir)")
    ap.add_argument("--json", action="store_true", dest="as_json",
                    help="emit the full report as JSON")
    ap.add_argument("--emotion", default=None,
                    help="report on one emotion only")
    args = ap.parse_args(argv)
    return run(Path(args.voices_dir), as_json=args.as_json, emotion=args.emotion)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
