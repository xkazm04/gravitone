"""One-load stem exporter — load the Pocket TTS model ONCE, export every
selected stem to a .safetensors embedding in a single process.

`ingest.commit` spawns exactly one of these per commit, instead of one
`pocket_tts export-voice` subprocess (i.e. one cold ~15s CPU model load) per
emotion. Loading the model a single time and exporting stem-by-stem is the big
CPU win and keeps RAM flat.

Protocol (so the parent can stream per-emotion progress and cancel between
emotions without a control channel): read a JSON spec, then print ONE JSON
status line to stdout per finished stem — flushed immediately — and exit.

    python -m service.export_stems <spec.json>

    spec.json = {"language": str, "quantize": bool,
                 "stems": [{"emotion": str, "src": <wav>, "dst": <safetensors>,
                            "say": {"text": str, "out": <wav>}?}, ...]}

    stdout, one line per stem, in order:
        {"emotion": "...", "ok": true}
        {"emotion": "...", "ok": false, "error": "..."}

`say` is the AUDITION half (see :func:`audition`): when present, the stem's
freshly-exported voice state is used to synthesize that sentence into
``say["out"]`` in the SAME child, so the audition costs one model load rather
than an export load plus a serving load. The status line then also carries
``{"audio": <path>, "audio_seconds": float}``. A stem whose export succeeded but
whose synthesis failed reports ``ok: false`` with the synthesis error named —
"the voice exported but could not speak" is a distinct outcome from "the export
failed", and an audition that cannot be heard is not a success.

Exit code is 0 only when every stem exported; nonzero otherwise. The parent
terminates this process to cancel — cleanly, between lines.

Two parents, one exporter. `ingest.commit` drives the child with Popen because
it streams per-emotion progress and cancels between stems; the direct-upload
clone (`voices.create_voice`) has a single stem and no progress to stream, so it
calls :func:`export_batch`, which runs the same child to completion and returns
the parsed statuses. Both therefore get the load-back verification and the CLI
fallback in `_export_one` — the direct clone used to spawn `pocket_tts
export-voice` itself, with NO verification, so a serializer/format mismatch
registered a voice that only failed later, at synthesis time.

pocket_tts / torch are imported INSIDE `main` so the module stays importable
(and `compileall`-clean) on boxes without the model stack; unit tests inject a
fake `pocket_tts` into sys.modules and never touch the real model.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import time
import wave
from pathlib import Path

# Every scratch artefact an audition creates is named with this prefix, at every
# level (the directory, the .safetensors state, the synthesized wav). It is what
# makes a leak identifiable: `_gc_scratch` sweeps by prefix, so a crash between
# the export and the cleanup leaves rubbish that a later sweep can recognise as
# rubbish instead of guessing. NOTHING with this prefix is ever registered in the
# voice roster — an audition voice does not exist as far as `service/voices.py`
# is concerned, and the only way to keep that true is to never hand it to it.
AUDITION_PREFIX = "_audition_"


def export_batch(stems: list[dict], *, language: str, quantize: bool,
                 spec_dir: Path, timeout: float | None = None) -> dict[str, str | None]:
    """Export ``stems`` in ONE child process; return ``{emotion: error or None}``.

    The blocking half of the protocol above, for callers with nothing to stream:
    write the spec, run the child to completion, parse its status lines. Each
    stem is ``{"emotion", "src", "dst"}``; an emotion the child never reported
    on gets the child's stderr tail as its error, so "no status line" is never
    mistaken for success.

    ``subprocess.run`` (not Popen) on purpose — it communicates on both pipes,
    so the two-pipe deadlock `ingest.commit` has to spawn a stderr drain thread
    to avoid cannot happen here. Use Popen if you need progress or cancellation
    between stems; use this if you just need the embeddings.
    """
    spec_path = Path(spec_dir) / "export_spec.json"
    spec_path.write_text(json.dumps({
        "language": language, "quantize": quantize,
        "stems": [{"emotion": s["emotion"], "src": str(s["src"]), "dst": str(s["dst"])}
                  for s in stems],
    }), "utf-8")

    ex = subprocess.run(
        [sys.executable, "-m", "service.export_stems", str(spec_path)],
        capture_output=True, timeout=timeout)

    results: dict[str, str | None] = {}
    for line in ex.stdout.decode(errors="ignore").splitlines():
        if not line.strip():
            continue
        try:
            evt = json.loads(line)
        except json.JSONDecodeError:
            continue
        emo = evt.get("emotion")
        if emo is None:
            continue
        results[emo] = None if evt.get("ok") else (evt.get("error") or "export failed")

    silent = ex.stderr.decode(errors="ignore")[-300:].strip() or \
        f"exporter exited {ex.returncode} without reporting this stem"
    for s in stems:
        results.setdefault(s["emotion"], silent)
    return results


def audition(*, src: Path | str, text: str, language: str, quantize: bool,
             scratch_dir: Path, timeout: float | None = None) -> dict:
    """Clone `src` into a THROWAWAY voice, speak `text` with it, return the wav.

    The scratch half of this module, and the whole of the Audition Room's
    service dependency. Three properties are the point:

    * **Ephemeral.** Everything is written under `scratch_dir` (which the caller
      places inside the ingest job's own workdir) with the `_audition_` prefix,
      and the directory is removed in a `finally` — on success AND on every
      failure path. The wav is READ before the sweep and returned as bytes, so
      there is nothing left on disk for the caller to forget about.
    * **Never registered.** No `voices.py` call, no `VOICES_DIR` write, no
      `meta.json` mutation, no slot-holder check. An audition voice is not a
      Voice; it is a sound. That is why a candidate can be heard before any
      irreversible commit exists.
    * **No length gate.** `commit` refuses a stem under `MIN_STEM_SECONDS`
      because a short stem clones badly — but refusing to LET SOMEONE HEAR that
      is how the flow ended up asking users to buy blind. This is the
      `allow_short=True` path: a 2.1s stem auditions, and the user's ear decides
      whether "badly" means "unusable".

    Returns ``{"ok", "error", "audio", "seconds"}``: `audio` is wav bytes on
    success and None otherwise, `error` is a named reason on failure and None on
    success. Never raises for an audition that simply did not work.
    """
    scratch_dir = Path(scratch_dir)
    stem_name = f"{AUDITION_PREFIX}{int(time.time() * 1000) % 10_000_000}"
    out_wav = scratch_dir / f"{stem_name}.wav"
    try:
        scratch_dir.mkdir(parents=True, exist_ok=True)
        spec_path = scratch_dir / f"{AUDITION_PREFIX}spec.json"
        spec_path.write_text(json.dumps({
            "language": language, "quantize": quantize,
            "stems": [{"emotion": stem_name, "src": str(src),
                       "dst": str(scratch_dir / f"{stem_name}.safetensors"),
                       "say": {"text": text, "out": str(out_wav)}}],
        }), "utf-8")
        try:
            ex = subprocess.run(
                [sys.executable, "-m", "service.export_stems", str(spec_path)],
                capture_output=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            # Named, not a generic failure: a CPU model load plus one line of
            # synthesis is a minute-scale operation, and "it is still going" is
            # a different thing to tell a user than "it broke".
            return {"ok": False, "error": "audition timed out before the voice spoke",
                    "audio": None, "seconds": None}

        status: dict = {}
        for line in ex.stdout.decode(errors="ignore").splitlines():
            if not line.strip():
                continue
            try:
                evt = json.loads(line)
            except json.JSONDecodeError:
                continue
            if evt.get("emotion") == stem_name:
                status = evt
        if not status:
            tail = ex.stderr.decode(errors="ignore")[-300:].strip()
            return {"ok": False, "audio": None, "seconds": None,
                    "error": tail or f"audition child exited {ex.returncode} without reporting"}
        if not status.get("ok"):
            return {"ok": False, "audio": None, "seconds": None,
                    "error": status.get("error") or "audition failed"}
        if not out_wav.is_file():
            return {"ok": False, "audio": None, "seconds": None,
                    "error": "audition reported success but wrote no audio"}
        return {"ok": True, "error": None, "audio": out_wav.read_bytes(),
                "seconds": status.get("audio_seconds")}
    except OSError as exc:
        return {"ok": False, "error": f"audition scratch failed: {exc}",
                "audio": None, "seconds": None}
    finally:
        # The cleanup that keeps "ephemeral" true. `ignore_errors` because a
        # failed sweep must not turn a working audition into an error — the
        # prefix sweep below is the second line of defence.
        shutil.rmtree(scratch_dir, ignore_errors=True)


def gc_scratch(root: Path | str, max_age_s: float = 900.0) -> list[str]:
    """Remove `_audition_` leftovers under `root` older than `max_age_s`.

    The crash path. `audition` cleans up in a `finally`, so this only ever has
    work to do when the process died between the export and that `finally` — but
    that is exactly the case the proposal called out (scratch voices leaking),
    and a prefix without a sweep is only half a mitigation. Returns what it
    removed so the caller can log a leak rather than fix it silently.
    """
    root = Path(root)
    removed: list[str] = []
    if not root.is_dir():
        return removed
    now = time.time()
    for p in sorted(root.iterdir()):
        if not p.name.startswith(AUDITION_PREFIX):
            continue
        try:
            if now - p.stat().st_mtime <= max_age_s:
                continue
            if p.is_dir():
                shutil.rmtree(p, ignore_errors=True)
            else:
                p.unlink(missing_ok=True)
        except OSError:
            continue
        removed.append(p.name)
    return removed


def _emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _save_voice_state(model, state, dst: Path) -> None:
    """Persist a voice state to <dst> (.safetensors) so the serving worker can
    reload it via ``TTSModel.get_state_for_audio_prompt(<dst>)`` — the exact
    round-trip `pocket_tts export-voice` relies on. We reuse the library's own
    serializer when it exposes one (so the bytes match export-voice), and fall
    back to a plain safetensors tensor-dict dump only if none is found."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    # 1) a model-level exporter (mirrors the export-voice CLI most faithfully)
    for attr in ("save_voice_state", "export_voice_state", "save_voice"):
        fn = getattr(model, attr, None)
        if callable(fn):
            fn(state, str(dst))
            return
    # 2) a state object that knows how to serialize itself
    for attr in ("save", "save_file", "to_safetensors", "export"):
        fn = getattr(state, attr, None)
        if callable(fn):
            fn(str(dst))
            return
    # 3) a flat {name: tensor} state -> safetensors
    from safetensors.torch import save_file
    save_file(dict(state), str(dst))


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv:
        sys.stderr.write("usage: python -m service.export_stems <spec.json>\n")
        return 2
    spec = json.loads(Path(argv[0]).read_text("utf-8"))
    stems = spec.get("stems", [])

    # Load the model ONCE for the whole batch — the entire point of this module.
    try:
        from pocket_tts import TTSModel
        model = TTSModel.load_model(
            language=spec.get("language", "english"),
            quantize=bool(spec.get("quantize", False)))
    except Exception as exc:  # noqa: BLE001 - load is fatal for the whole batch
        for st in stems:
            _emit({"emotion": st.get("emotion"), "ok": False,
                   "error": f"model load failed: {exc}"})
        sys.stderr.write(f"export_stems: model load failed: {exc}\n")
        return 1

    rc = 0
    for st in stems:
        emo, src, dst = st.get("emotion"), st.get("src"), Path(st.get("dst"))
        err = _export_one(model, src, dst)
        line = {"emotion": emo, "ok": err is None, "error": err}
        say = st.get("say")
        if err is None and isinstance(say, dict):
            # AUDITION: speak with the state we just wrote, in this same process.
            out = Path(say.get("out"))
            serr, seconds = _say_one(model, dst, str(say.get("text") or ""), out)
            if serr is None:
                line.update({"audio": str(out), "audio_seconds": seconds})
            else:
                # Export ok, speech not: report the FAILURE (the caller wants
                # audio, not a state file), and name which half broke.
                line.update({"ok": False, "error": serr})
                err = serr
        _emit(line)
        if err is not None:
            rc = 1
    return rc


def _say_one(model, state_path: Path, text: str, out: Path) -> tuple[str | None, float | None]:
    """Synthesize `text` with the exported voice at `state_path` into `out`.

    Loads the state back through the same ``get_state_for_audio_prompt`` call the
    serving worker makes, so an audition hears what the roster would have heard
    had this stem been committed — not an in-memory shortcut that skips the
    round-trip the real path takes. Returns (error or None, seconds or None).
    """
    if not text.strip():
        return "nothing to say (empty audition line)", None
    try:
        state = model.get_state_for_audio_prompt(str(state_path), truncate=True)
        try:
            audio = model.generate_audio(state, text, copy_state=True)
        except TypeError:
            # An older/leaner model signature. The kwarg is an optimisation, not
            # a requirement, so its absence must not fail the audition.
            audio = model.generate_audio(state, text)
        rate = int(getattr(model, "sample_rate", 24000) or 24000)
        return None, _write_wav(audio, rate, out)
    except Exception as exc:  # noqa: BLE001 - one audition, never the process
        return f"synthesis failed: {str(exc)[:200]}", None


def _write_wav(audio, rate: int, dst: Path) -> float:
    """Serialize generated audio to 16-bit PCM mono wav; return its seconds.

    Deliberately does NOT import service.engine (whose module import pulls in the
    whole serving stack and its settings): this module's contract is that it
    stays importable on a box with no model stack, and the child is the only
    place a tensor ever appears. Same conversion, locally.
    """
    import numpy as np

    a = audio
    for attr in ("detach", "cpu", "squeeze"):   # torch tensors; no-ops otherwise
        fn = getattr(a, attr, None)
        if callable(fn):
            a = fn()
    fn = getattr(a, "numpy", None)
    if callable(fn):
        a = fn()
    arr = np.asarray(a).reshape(-1)
    if not np.issubdtype(arr.dtype, np.integer):
        arr = (np.clip(arr.astype(np.float32), -1.0, 1.0) * 32767.0).astype("<i2")
    else:
        arr = arr.astype("<i2")
    dst.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(dst), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(arr.tobytes())
    return round(arr.size / float(rate), 2)


def _export_one(model, src, dst: Path) -> str | None:
    """Export one stem; return an error string or None on success.

    The in-process save is only trusted after a LOAD-BACK through
    ``get_state_for_audio_prompt(<dst>)`` — the exact call the serving worker
    makes — so a serializer/format mismatch can never ship a voice that later
    fails to load. Any failure falls back to the proven ``pocket_tts
    export-voice`` CLI for that stem (one cold model load, failure path only).

    The fallback triggers on ANY failure of the in-process route: the model
    refusing the source, no serializer being found for the state, nothing
    written, or — the case that matters — the round-trip load-back raising. It
    is kept because the CLI is the proven invocation; the load-back is what
    makes trusting the fast path safe.
    """
    try:
        state = model.get_state_for_audio_prompt(str(src), truncate=True)
        _save_voice_state(model, state, dst)
        if dst.is_file():
            model.get_state_for_audio_prompt(str(dst), truncate=True)  # round-trip check
            return None
        first_err = "no output written"
    except Exception as exc:  # noqa: BLE001 - fall back to the CLI below
        first_err = str(exc)[:200]
    dst.unlink(missing_ok=True)  # never leave a half-written/unloadable file
    ex = subprocess.run(
        [sys.executable, "-m", "pocket_tts", "export-voice", str(src), str(dst)],
        capture_output=True)
    if ex.returncode == 0 and dst.is_file():
        return None
    cli_err = ex.stderr.decode(errors="ignore")[-150:]
    return f"in-process export failed ({first_err}); CLI fallback failed: {cli_err}"


if __name__ == "__main__":
    sys.exit(main())
