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
                 "stems": [{"emotion": str, "src": <wav>, "dst": <safetensors>}, ...]}

    stdout, one line per stem, in order:
        {"emotion": "...", "ok": true}
        {"emotion": "...", "ok": false, "error": "..."}

Exit code is 0 only when every stem exported; nonzero otherwise. The parent
terminates this process to cancel — cleanly, between lines.

pocket_tts / torch are imported INSIDE `main` so the module stays importable
(and `compileall`-clean) on boxes without the model stack; unit tests inject a
fake `pocket_tts` into sys.modules and never touch the real model.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


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
        _emit({"emotion": emo, "ok": err is None, "error": err})
        if err is not None:
            rc = 1
    return rc


def _export_one(model, src, dst: Path) -> str | None:
    """Export one stem; return an error string or None on success.

    The in-process save is only trusted after a LOAD-BACK through
    ``get_state_for_audio_prompt(<dst>)`` — the exact call the serving worker
    makes — so a serializer/format mismatch can never ship a voice that later
    fails to load. Any failure falls back to the proven ``pocket_tts
    export-voice`` CLI for that stem (one cold model load, failure path only).
    """
    import subprocess
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
