# Moonshots — Conversational AI & Speech-In (2026-07-30)

Context read: `service/convai.py`, `service/stt.py`, `service/vad.py`,
`service/recording.py`, `service/cache.py`, `service/dialog.py`,
`service/config.py` (convai_*/stt_* block), `service/tests/test_convai_protocol.py`.

What the scaffold already is: a duplex ElevenLabs-Agents-compatible WebSocket
(ticketed), a level-based `SpeechGate` that finds turn boundaries with no
weights, local faster-whisper with per-request hotwords, three interchangeable
brains (scripted / OpenAI-compat / `claude -p`), Pocket-TTS + Piper mouths, and
a `Recorder` that writes two **sample-aligned** WAVs plus a transcript carrying
`audio_s`, `transcribe_s`, `answer_s` and `interrupted` per turn. Two things
that scaffold makes possible are, right now, not built: conversations cannot be
**re-run**, and a turn cannot **begin before the caller has finished speaking**.

---

## M1. The Conversation Gym — replayable, self-generated voice-agent CI

- **Tier**: 1 (10x category-defining)
- **Category**: platform
- **Impact**: Turns every recorded call into a deterministic, re-runnable fixture, and lets the service synthesize its own adversarial callers — so a voice agent gets a real regression suite (WER, turn latency, barge-in correctness, refusal/disclosure checks) that runs thousands of calls in CI at zero marginal cost.
- **Feasibility**: high
- **Time-horizon**: months
- **Why it's a moonshot**: Nobody who builds on hosted voice agents can test them — every run is metered, nondeterministic, and un-replayable, so the entire category ships spoken products verified by a human listening once. Gravitone is structurally the only place this can exist: the caller side can be *synthesized by the same box* (own TTS, own emotion palette, own Piper languages), the brain has a deterministic `ScriptedBackend`, and `Recorder` already writes the two aligned WAVs a replay needs. It reframes the product from "a cheaper mouth" to "the only place a voice agent can be engineered".
- **Path to implementation**:
  1. Add a replay driver in-process: read `recordings/<id>/user.wav`, stream it as base64 `user_audio_chunk` frames at wire pacing into the socket via `TestClient.websocket_connect` — exactly the loop `test_convai_protocol.py` already performs by hand with `tone()`/`silence()`. Emit a run artifact (turns, latencies, transcripts) using the existing `Recorder`. This is a self-contained script + test today.
  2. Score two runs against each other: a `compare()` that diffs caller transcripts (WER against the *original* recording's transcript as reference), agent turn text, `answer_s`/`transcribe_s` distributions, and interruption events. Fail on regression thresholds; exit-code friendly like `certify.py`.
  3. Promote recordings to **suites**: a directory of golden conversations with per-suite thresholds and expected assertions (e.g. "the opening discloses AI + transcription", "no turn exceeds 2 sentences", "the Czech agent never emits an English sentence").
  4. **Synthesize the caller.** Generate candidate-side audio from scripted personas using the existing TTS pool + emotion addressing + Piper languages, then degrade it deliberately — added room noise, clipping, telephone band-limiting, mid-utterance connect (the documented `vad.py` first-frame case), overlapping barge-in. The suite stops being a fixed corpus and becomes a generator; this is where the ear's real failure boundary gets mapped.
  5. Expose it as `POST /v1/convai/replay` + a `gravitone gym` runner so downstream apps (an interview harness, a support bot) run their own suites against their own agent JSON in their own CI.
  6. Ship a **coverage report**: per-agent, which languages / noise levels / interruption patterns have passing evidence — the same shape as the emotion demand/coverage loop, applied to listening.
- **Dependencies**: `Recorder` (aligned WAVs — already correct), `SpeechGate.flush()`, `ScriptedBackend` determinism, TTS pool for caller synthesis, `stt.transcribe` word timestamps for WER alignment. No new models.
- **Risks**: Synthetic callers are not human callers — `diarize.py` already warns that synthetic speech confuses speaker logic, and a suite that only passes on TTS-generated audio can enshrine the wrong ear (mitigate: every suite keeps at least one real recording as an anchor). Recording is privacy-gated and off by default, so suite corpora must be explicitly authored, not harvested. WER against an ASR-produced reference measures *drift*, not truth, and must be labelled as such.
- **What changes if we ship it**: A voice agent stops being a demo you listen to and becomes software with a red/green signal — and Gravitone becomes the test environment even for teams still shipping on a hosted vendor in production.

---

## M2. Zero-gap turn-taking — the agent answers before the caller stops talking

- **Tier**: 1 (10x category-defining on the metric users actually feel)
- **Category**: functionality
- **Impact**: Collapses perceived turn latency from "hangover + whole-utterance decode + whole-reply prefill + first synthesis" to a sub-half-second response on a CPU-only Arm box, by transcribing and thinking *during* the caller's speech instead of after it.
- **Feasibility**: medium
- **Time-horizon**: months
- **Why it's a moonshot**: Today every turn pays its costs strictly in series after the caller falls silent — `_on_speech_end` → threadpool Whisper decode → brain (4–6 s for the Claude CLI) → first sentence synthesis. The physics say a small local stack should beat a round-trip to a datacenter, and it currently loses on the one number a human notices. Winning it means making the pipeline *speculative*: decode the utterance-so-far while it is still being spoken, prefill the brain on the partial text, and have audio ready to play at the instant the hangover expires. That is the difference between "impressively cheap" and "the best-feeling voice agent available", and it is a claim no per-minute cloud vendor can answer with a price cut.
- **Path to implementation**:
  1. Incremental hearing, in place: `_Session._on_audio` currently only reacts to gate events. Have the gate expose the in-progress voiced buffer (it already holds `self._voiced` and `speaking`) and run a cheap partial decode (`beam_size=1`, no word timestamps) on the growing utterance every ~600 ms on the threadpool, keeping the newest partial. At `SPEECH_END`, the final decode starts from a warm model with most of the audio already seen — and the partial is emittable as an interim `user_transcript`, which is protocol-legal today.
  2. Speculative prefill: when a partial transcript stabilizes (last two partials agree on their prefix) and the gate is in hangover, start the brain on the partial. If the caller resumes, cancel — `_begin_turn` / `_cancel_turn` already model exactly this replace-in-flight semantics, and `ClaudeCliBackend` already kills an orphaned process on cancel.
  3. Instant floor-taking: pre-render a small set of turn-opening tokens per voice ("Mm-hm.", "Right —", "Got it,") through `SynthCache`, which is byte-budgeted and single-flighted already. On turn end, the cached opener is on the wire in milliseconds while sentence one renders behind it. Gate it per agent — an interviewer wants it, a legal read-back does not.
  4. Stop the agent barging in on itself: `Recorder.spoke()` proves we know exactly which PCM we sent and when. Feed that as a **reference signal** to the gate so frames correlated with our own output do not trigger `_on_speech_start`. This is the honest local answer to acoustic echo, and it is the precondition for making onset detection more aggressive without false interruptions.
  5. Make the onset adaptive: with the reference signal in place, drop `onset_frames`/`hangover_ms` toward the aggressive end during agent speech and back off in silence, and publish the resulting turn-latency distribution as a first-class metric on the existing recording/latency reporting.
  6. Prove it with M1: every step above is a latency regression candidate, so land each behind a config flag and gate it on a Gym suite that asserts both `answer_s` improvement *and* no rise in false interruptions or truncated turns.
- **Dependencies**: `SpeechGate` internals exposed read-only, `stt._RUN_LOCK` (partial decodes compete with the final one — needs a "drop the partial if the final is waiting" policy), `SynthCache` for openers, `resample_pcm16`, per-agent config for opener/aggressiveness. Benefits enormously from M1 existing first.
- **Risks**: Partial decodes spend the same pinned CPU the TTS pool needs — on a small box this can make throughput worse while making latency better, so it must be measurable and default-off on constrained replicas. A wrong speculation that has already been *spoken* (a backchannel over a caller who was only pausing) is worse than latency; keep speculation invisible until the turn is confirmed, and never let an opener commit the agent to content. `condition_on_previous_text=False` and Whisper's silence-hallucination behavior mean partial text is noisier than final text — never write a partial into `history` or the recorded transcript.
- **What changes if we ship it**: The local, sovereign, unmetered option also becomes the *fastest-feeling* one — which turns the sovereignty story from a compromise buyers accept into the option they'd choose anyway.
