# REPORT — VERIFIED (Verified Speech), Batch 3

> Saved by the orchestrator from the builder's inline report.

**Status: complete.** E4 shipped, strict retry INCLUDED. Full service suite 1193 tests green
(5 skipped; one test_recording newest-first timestamp flake — passes isolated + re-run).

Files: `service/verify.py` (new, pure: shared normalizer w/ numeral + abbreviation
tolerance, numeral-whole diff repair, confidence-floored scorer, word/char alignment
mapper), `service/app.py` (synthesis core extracted to `_render_tts` — pure code motion
shared by both routes; POST /v1/text-to-speech/{voice_id}/with-timestamps; ?verify=true|strict;
ALIGN_CACHE), `service/tests/test_verify.py` (new, 39). No edits to test_compat/handler_modes
needed. Default path pinned: no ?verify ⇒ zero transcriptions, identical bytes/headers.

Deviation: alignments in a sibling ALIGN_CACHE (route-distinguished key), not inside
SYNTH_CACHE — cache.py's stated law: entry shapes never mix in one keyspace.

## Hooks
1. `stt._assemble` drops faster-whisper's per-word `probability` → confidence floor inert on
   a real box (reports `confidence_source: "unrated"`). Patch (orchestrator): `Word` gains
   `confidence: float | None = None`; pass `getattr(w, "probability", None)`.
2. `stt.transcribe_pcm` lacks a word_timestamps passthrough; app falls back to
   `stt.transcribe` (works — optional cleanup, left as-is this batch).
3. Verified routes reuse the `tts` scope (not `stt`) — deliberate.
