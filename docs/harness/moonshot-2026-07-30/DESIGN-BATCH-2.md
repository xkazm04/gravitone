# Batch 2 Design — "The Living Stage"

> Five features, one story: **the conversational layer the service already has becomes a
> product you can see, use, test, and trust.** The playground learns to hold a live
> conversation (Table Read), takes become editable instead of disposable (Punch-in), the
> agent answers with near-zero gap (Zero-gap), conversations become replayable CI
> (Conversation Gym), and the brain starts directing the performance — language, emotion,
> end-of-call — instead of feeding bare text (Polyglot Turn).
>
> Branch: `vibeman/moonshot-batch-1` (continues; batch-2 commits land on the same branch).
> Builders NEVER run git. Orchestrator integrates and commits per feature.
> Batch-1 UX vocabulary is BINDING here too: Signal chips for measured facts, TakePlayer
> for all playback, tokens/`--gt-*` only, absent=invisible, advisory-never-blocking,
> named refusals ("line busy"), a11y keyboard paths.

## 1. UX narrative
The playground's composer gains a third mode — **Live** — beside Solo/Script. You talk to a
Character; it answers in its cloned voice; you talk over it and it stops. Every turn lands in
the takes log as a real Take, so a rehearsal WRITES the script. Any take — live or rendered —
now carries a **segment timeline**: click a region to seek, retake just that region, splice,
and keep provenance. Under the hood the agent feels instant (speculative hearing + cached
openers, flag-gated), every conversation can be replayed as a deterministic test, and the
brain can switch language mid-call while keeping one character identity.

## 2. Shared contracts

### D1. TurnPart (dialog.py, owned by POLYGLOT)
```python
@dataclass(frozen=True)
class TurnPart:
    text: str
    language: str | None = None   # None = agent default
    emotion: str | None = None    # None = agent default
    end_call: bool = False
```
`_SentenceBuffer` emits TurnParts; a compatibility shim keeps every existing `reply()`
consumer that expects `str` working unchanged (existing dialog tests must pass unmodified).

### D2. Directive grammar (dialog.py, owned by POLYGLOT)
Inline `[lang:cs]`, `[emotion:warm]`, `[end_call]` stripped by the buffer BEFORE text reaches
any synthesizer or transcript. Guarantees (each pinned by a test): no directive text can ever
be spoken; unknown directives dropped-and-logged, never voiced; `ScriptedBackend` gains
optional per-line directives so tests stay deterministic; partial/streamed chunks can never
leak a half-parsed directive.

### D3. Gym artifacts (gym.py, owned by GYM)
`service/gym.py` with its OWN `APIRouter` (orchestrator wires it into app.py at integration —
do not edit app.py). Run artifact (JSON): `{run_id, agent_id, source_recording, turns: [{i,
role, text, audio_s, transcribe_s, answer_s, interrupted}], totals}`. `compare(run_a, run_b)`
→ exit-code-friendly result like certify.py: WER drift (labelled as drift vs an ASR
reference, not truth), answer_s/transcribe_s distribution deltas, interruption diffs,
threshold verdicts. Suites = a directory of golden recordings + `suite.json` thresholds.

### D4. Live conversation client (web, owned by TABLE-READ)
`web/app/playground/_live/conversation.ts`: mic → AudioWorklet downsample → 16 kHz PCM16
base64 `user_audio_chunk` frames; inbound `audio` chunks → jitter-buffered Web Audio queue
**registered with the batch-1 AudioBus** (`registerStream`) so the whole frame reacts;
handles `user_transcript`, `agent_response`, `interruption`, `ping`/`pong`. Proxies:
`web/app/api/convai/signed-url/route.ts`, `web/app/api/convai/agents/route.ts` (thin
`proxyJson`; key attachment stays server-side). The WS itself connects to the service origin
from the signed URL.

### D5. Take edits provenance (web shared.ts, owned by PUNCH-IN)
```ts
edits?: { v: 1; source: string; regions: { i: number; text: string; emotion?: string }[] }
```
Versioned so older stored takes restore cleanly; `TakeCode` export includes the patch calls.

### D6. Speculation flags (convai config, owned by ZERO-GAP)
`convai_partial_decode` (default OFF), `convai_openers` (per-agent opt-in, default OFF).
Invariants (each pinned by a test): a partial transcript is NEVER written into `history` or
the recorded transcript; an opener never commits the agent to content; cancelled speculation
leaves no audio on the wire; flags off = byte-identical behaviour to today.

## 3. File ownership (HARD)

| Agent | Owns | Must NOT touch |
|---|---|---|
| **GYM** | `service/gym.py` (new), `service/tests/test_gym.py` (new), `service/tests/fixtures/gym/**` | `service/convai.py`, `service/app.py`, `service/recording.py`, all web |
| **ZERO-GAP** | `service/convai.py`, `service/stt.py`, `service/vad.py`, `service/cache.py`, their test modules | `service/dialog.py`, `service/piper.py`, `service/gym.py`, all web |
| **POLYGLOT** | `service/dialog.py`, `service/piper.py`, `service/tests/test_dialog.py`, `test_piper.py`, `test_claude_cli_brain.py` | `service/convai.py` (hooks → report), `service/stt.py`, all web |
| **TABLE-READ** | `web/app/playground/_live/**` (new), `web/app/api/convai/**` (new), `web/app/playground/page.tsx` | `web/app/playground/_variants/PlaygroundConsole.tsx` (mount hook → report), `engine.ts`, `shared.ts`, service/** |
| **PUNCH-IN** | `web/app/playground/_variants/` (PlaygroundConsole.tsx, engine.ts, shared.ts, TakeTimeline.tsx new), `web/lib/wavEncode.ts` (new), `web/app/api/stt/route.ts` (new) | `web/app/playground/_live/**`, `web/app/api/convai/**`, service/** |

PlaygroundConsole.tsx has ONE owner: PUNCH-IN. TABLE-READ builds Live as a self-contained
component tree under `_live/` and documents a ≤10-line mount diff (mode switch entry) for the
orchestrator. convai.py has ONE owner: ZERO-GAP. POLYGLOT's convai wiring (per-part mouth
re-resolution in `_Session._speak`, `Agent.languages`) is delivered as an exact patch in its
report; the orchestrator applies it after both land and re-runs both suites.

## 4. Per-feature batch-2 scope

### GYM — Conversation Gym (proposal `conversational-ai.md` M1, steps 1–3)
Replay driver (stream a recording's `user.wav` as wire-paced frames via
`TestClient.websocket_connect`, emit a run artifact), `compare()` with thresholds,
suites-of-goldens. CLI: `python -m service.gym run|compare|suite`. `POST /v1/convai/replay`
on gym's own router. Synthesized adversarial callers (step 4) + coverage report (step 6)
deferred. Tests: replay a fixture recording end-to-end against the in-process app with the
scripted brain (fully deterministic, no weights); compare() verdicts both directions;
ASCII-safe output. If no recording fixture exists, generate one in-test via the scripted
brain + tone frames (the pattern test_convai_protocol.py already uses).

### ZERO-GAP — Zero-gap turn-taking (proposal `conversational-ai.md` M2, steps 1–4)
All behind D6 flags, default OFF, byte-identical when off (pinned): (1) incremental partial
decode of the in-progress voiced buffer every ~600ms (`beam_size=1`, drop-if-final-waiting
policy on `stt._RUN_LOCK`), interim `user_transcript` emission (protocol-legal); (2)
speculative brain prefill when the last two partials agree on a prefix during hangover;
cancel via the existing `_begin_turn`/`_cancel_turn` semantics; (3) per-agent opener cache
through SynthCache — an opener never commits content; (4) self-echo reference: use
`Recorder.spoke()` timing to suppress gate onsets correlated with our own output. Adaptive
onset (step 5) deferred. Latency numbers go on the existing recording/latency reporting.

### POLYGLOT — The Polyglot Turn (proposal `dialog-brain-engines.md` M2, steps 1–2 + 6-lite)
D1 TurnPart + compat shim (existing tests pass unmodified — that IS the safety proof);
D2 directive grammar with strip/guard tests; ScriptedBackend per-line directives; prompt
clause + history language feed DESIGNED (exact convai patch in report, applied by
orchestrator); `piper.voice_for_language` pre-warm helper so a declared second language
doesn't pay a cold ONNX load. Per-sentence mouth re-resolution in `_Session._speak` +
`Agent.languages` matrix: exact patch in report (orchestrator applies). Two-consecutive-
utterance language-switch hysteresis documented for the convai patch.

### TABLE-READ — Table Read (proposal `tts-playground.md` M1, steps 1–5)
D4 module + proxies; `_live/LiveStage.tsx`: Character rail reuse (agent voice =
`convai._resolve_voice` server-side), scene note, growing turn list in the take-card visual
language, live input meter via AudioBus + EqBars, honest "line busy" when sessions are
capped, headphones-recommended notice (no AEC), Live and Generate mutually gated (console
already models busy). Turn round-trip: agent turns → real `Take` (WAV encode + computePeaks)
so player/share/review/code-export work unchanged; completed turns → `ScriptLine[]`;
"rehearse this script" seeds a ScriptedBackend agent so Live works with NO LLM configured.
Mount hook for PlaygroundConsole documented as ≤10-line diff in the report. Call-master
download (step 6) deferred.

### PUNCH-IN — Punch-in timeline (proposal `tts-playground.md` M2, steps 1–3 + 5)
Segment timeline on take cards (`TakeTimeline.tsx`, offsets from cumulative
`segment.seconds`, click-to-seek through the existing player seam); splice kernel
(`engine.ts` + `lib/wavEncode.ts`: decode take + re-rendered fragment, crossfade concat, WAV
master, patched `segments`, decoded-duration-as-truth); "retake this segment" via
`/api/speak` with per-region emotion/Expression override, up to N variants per region as A/B
lanes, cap+prune IndexedDB (surface `storageErr` honestly); D5 provenance + TakeCode patch
export. Word-granularity STT pass (step 4): build the `/api/stt` proxy route; the word-region
UI only if it lands cleanly — otherwise defer and say so. Decode failure degrades like
`refinePeaks` — never cost the user their take. Splice boundaries snap to segment edges;
full re-render is always the escape hatch.

## 5. Gates
Service builders: your new/touched modules + `test_convai_protocol`, `test_dialog`,
`test_piper`, `test_stt`, `test_recording`, `test_private_surface` — all green; py_compile.
Web builders: `npx tsc --noEmit` clean; full `npx vitest run` green EXCEPT the known
pre-existing PlaygroundConsole "keyed backend/unkeyed studio" flake (red under full-suite
load on main too — not yours unless your diff touches its subject). No `next build` (orchestrator).
NO git. ASCII console output. Windows box: no torch outside test shims; faster-whisper/piper
weights may be absent — degrade + stub per existing test conventions.

## 6. Reports
Reply <150 words (status, files, tests, hooks y/n). Since the harness may block .md writes,
include IN YOUR REPLY: the exact hook patches you need applied (POLYGLOT: convai diff;
TABLE-READ: PlaygroundConsole mount diff), your test evidence, and key UX decisions. The
orchestrator persists reports to `docs/harness/moonshot-2026-07-30/batch1/REPORT-<agent>.md`
equivalents under `batch2/`.
