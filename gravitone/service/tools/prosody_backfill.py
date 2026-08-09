"""Measure the Voices that were created before anything listened.

``service/prosody.py`` runs where the audio is already in hand — the clone path
probes ``clean.wav`` on its way past. Every Voice registered BEFORE that existed
has no ``prosody`` row, and its source audio is long gone (the clone path keeps
the embedding, never the recording). Built-ins never had source audio at all.

So the only way to measure an old slot is to make it speak: synthesize one FIXED
calibration sentence through the engine and probe the output. Same sentence for
every slot, on purpose — the comparison in ``emotions.nearest_measured`` is
between slots of one Character, so any content difference between them would be
measured as an emotion difference.

Run (``python -m service.tools`` lists the whole pipeline and what each part
needs; this one needs the engine):

    python -m service.tools prosody --dry-run
    python -m service.tools prosody --limit 20

**This box cannot do the real thing.** ``service/engine.py`` imports torch and
pocket_tts, neither of which is installed outside the container, so the tool
plans honestly (the registry read needs no model) and then reports
``skipped: engine unavailable`` per slot instead of failing. That is the same
"name the outcome" posture the pipeline uses everywhere else: an operator running
this on a dev box learns exactly why nothing was written.

Writes go through ``voices.mutate_meta`` — the ONE registry write path — so a
backfill cannot race a clone or a pack import. Nothing else is touched: the
embedding files, the consent receipts and every other field are left alone.
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

from service import prosody
from service.config import SETTINGS

# One fixed sentence, phonetically broad enough that f0 and tilt are measurable
# and long enough (~3 s spoken) to clear prosody's minimum duration.
CALIBRATION_TEXT = (
    "The quick brown fox jumps over the lazy dog while the sun sets slowly "
    "behind the quiet blue hills."
)


def _out(line: str) -> None:
    """ASCII-only stdout — this runs on a cp1252 Windows console."""
    print(line.encode("ascii", "replace").decode("ascii"))


def load_meta(voices_dir: Path) -> dict:
    """The registry as JSON, without importing the service.

    Deliberately NOT ``voices._load_meta``: this tool must be able to report a
    plan on a box where importing the service package fails. A missing or
    unreadable registry is an empty plan, not a crash — the write path (which
    does go through voices.py) never runs in that case anyway.
    """
    path = voices_dir / "_meta.json"
    if not path.is_file():
        return {"voices": {}, "characters": {}}
    try:
        raw = json.loads(path.read_text("utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        _out(f"prosody_backfill: skipped: registry unreadable ({exc})")
        return {"voices": {}, "characters": {}}
    if not isinstance(raw, dict):
        return {"voices": {}, "characters": {}}
    voices = raw.get("voices")
    return {"voices": voices if isinstance(voices, dict) else {}}


def needs_probe(row: object) -> bool:
    """True when this registry row has no usable prosody measurement.

    A row whose stored probe is from an OLDER ``prosody.VERSION``, or which only
    ever recorded a named failure (``{"reason": "silent", ...}`` with no
    numbers), counts as unmeasured — re-measuring is cheap and comparing across
    feature definitions is not.
    """
    if not isinstance(row, dict):
        return False
    stored = row.get("prosody")
    if not isinstance(stored, dict):
        return True
    if stored.get("version") != prosody.VERSION:
        return True
    return not any(isinstance(stored.get(f), (int, float))
                   and not isinstance(stored.get(f), bool)
                   for f in prosody.FIELDS)


def plan(meta: dict, limit: int | None = None) -> list[str]:
    """Voice ids to measure, in a stable (sorted) order.

    Sorted so two runs of ``--limit N`` cover the same slots instead of whatever
    the JSON happened to hold — a partial backfill should be resumable, not
    random.
    """
    rows = meta.get("voices") or {}
    targets = sorted(vid for vid, row in rows.items() if needs_probe(row))
    return targets if limit is None else targets[:max(0, limit)]


def open_engine():
    """A started engine, or (None, reason). Never raises.

    The import itself is the gate: torch/pocket_tts are absent outside the
    container, so this is where a dev box turns into a named skip.
    """
    try:
        from service.engine import TtsEngine
    except Exception as exc:  # noqa: BLE001 - any import failure is "unavailable"
        return None, f"engine unavailable ({type(exc).__name__}: {exc})"
    try:
        eng = TtsEngine()
        eng.start()
    except Exception as exc:  # noqa: BLE001 - a model that won't load is the same story
        return None, f"engine unavailable ({type(exc).__name__}: {exc})"
    return eng, None


def measure(engine, voice_id: str, text: str, workdir: Path) -> dict:
    """Synthesize the calibration line for one Voice and probe it."""
    job = engine.submit(voice_id, text)
    result = job.future.result()
    wav = workdir / f"{voice_id}.wav"
    wav.write_bytes(result.wav_bytes)
    return prosody.probe(wav)


def store(measured: dict[str, dict]) -> int:
    """Write probes onto their registry rows through the canonical write path.

    Rows that vanished between the plan and the write (a delete mid-backfill)
    are skipped rather than recreated — this tool measures, it never resurrects.
    """
    if not measured:
        return 0
    try:
        from service import voices
    except Exception as exc:  # noqa: BLE001
        _out(f"prosody_backfill: skipped: registry writer unavailable "
             f"({type(exc).__name__}: {exc})")
        return 0

    def _mut(meta: dict) -> int:
        written = 0
        for vid, probe_result in measured.items():
            row = meta["voices"].get(vid)
            if isinstance(row, dict):
                row["prosody"] = probe_result
                written += 1
        return written

    return voices.mutate_meta(_mut)


def run(voices_dir: Path, *, limit: int | None, dry_run: bool,
        text: str = CALIBRATION_TEXT) -> int:
    meta = load_meta(voices_dir)
    targets = plan(meta, limit)
    _out(f"prosody_backfill: {len(targets)} voice(s) need measuring "
         f"(registry: {voices_dir / '_meta.json'})")
    if not targets:
        return 0
    if dry_run:
        for vid in targets:
            _out(f"  {vid}: would measure")
        return 0

    engine, reason = open_engine()
    if engine is None:
        for vid in targets:
            _out(f"  {vid}: skipped: {reason}")
        _out(f"prosody_backfill: 0 of {len(targets)} measured, "
             f"skipped: {reason}")
        return 0

    measured: dict[str, dict] = {}
    try:
        with tempfile.TemporaryDirectory(prefix="prosody-backfill-") as tmp:
            for vid in targets:
                try:
                    measured[vid] = measure(engine, vid, text, Path(tmp))
                    named = measured[vid].get("reason")
                    _out(f"  {vid}: measured"
                         + (f" (reason: {named})" if named else ""))
                except Exception as exc:  # noqa: BLE001 - one bad slot, not the run
                    _out(f"  {vid}: skipped: probe failed "
                         f"({type(exc).__name__}: {exc})")
    finally:
        try:
            engine.stop()
        except Exception:  # noqa: BLE001 - shutdown must not mask results
            pass

    written = store(measured)
    _out(f"prosody_backfill: {written} of {len(targets)} rows updated")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="prosody_backfill",
        description="Measure prosody for Voices registered before the probe existed.")
    ap.add_argument("--dry-run", action="store_true",
                    help="list what would be measured and exit")
    ap.add_argument("--limit", type=int, default=None,
                    help="measure at most N voices (resumable: stable order)")
    ap.add_argument("--voices-dir", default=str(SETTINGS.voices_dir),
                    help="registry directory (default: the configured voices dir)")
    ap.add_argument("--text", default=CALIBRATION_TEXT,
                    help="calibration sentence (keep it identical across runs)")
    args = ap.parse_args(argv)
    return run(Path(args.voices_dir), limit=args.limit,
               dry_run=args.dry_run, text=args.text)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
