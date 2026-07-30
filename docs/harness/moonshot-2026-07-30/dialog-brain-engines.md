# Moonshots — Dialog Brain & Alternative Engines (2026-07-30)

Context read: `service/dialog.py`, `service/piper.py`, `service/errors.py`,
`service/convai.py` (`backend()`, `_resolve_voice`, `_describe_agent`, `_Session`),
tests `test_dialog.py`, `test_claude_cli_brain.py`, `test_piper.py`.

What is already latent here and under-exploited:

* `DialogBackend` is a clean, stateless, **sentence-streaming brain interface**
  with three implementations, one of which (`ClaudeCliBackend`) is a frontier
  model with **no API key, no server, a tool denylist AND a name-independent
  tool-use abort** — an unusually safe local agent runtime.
* `_resolve_voice()` is a private 4-rule `if` in `convai.py` that already
  performs **capability-based engine dispatch** (Pocket TTS vs Piper, by
  language, refusing rather than mispronouncing) — a router in disguise, with
  no registry, no manifest, and no third engine possible.
* The ear (faster-whisper) understands dozens of languages; the mouth is
  resolved **once, at connect**, and the brains explicitly "cannot follow the
  speaker into another language" (`ScriptedBackend` docstring).

---

## M1. The Speech Engine Plane: capability-declared adapters, a conformance kit, and an open engine ecosystem

- **Tier**: 1 (10x category-defining)
- **Category**: platform
- **Impact**: Turns Gravitone from "a Pocket TTS service with a Czech fallback" into the **local speech plane** — one ElevenLabs-compatible API in front of N pluggable CPU engines, each declaring what it can do (languages, cloning, emotion, native rate, license), with the router picking the best mouth per request. Anyone can add an engine in ~40 lines and prove it with one command.
- **Feasibility**: high
- **Time-horizon**: months
- **Why it's a moonshot**: The value of a local TTS API is bounded by the single model behind it; the value of an engine *plane* compounds with every adapter anyone writes, and none of them cost us training, hosting or GPUs. It also flips the multilingual story from "Pocket TTS speaks en/fr, sorry" to "the plane speaks whatever is installed" without weakening the local/no-key/no-GPU claim. Piper already proves the seam exists — it is just hard-coded in two places instead of being a contract.
- **Path to implementation**:
  1. **In the current scaffold**: add `service/engines.py` with an `EngineCapabilities` frozen dataclass (`engine_id`, `languages`, `clones: bool`, `emotions: bool`, `native_rate`, `license`, `install_hint`) and register exactly the two engines that exist today — Pocket TTS from `convai._POCKET_LANGUAGES` + the voice registry, Piper from `piper.list_voices()`/`piper.info()`. Pure description, zero behaviour change; expose it as `GET /v1/engines` (and fold it into the `piper` key already returned by `/v1/convai/agents`).
  2. Move `_resolve_voice` into `engines.py` as `resolve(language, voice_id) -> (engine_id, voice_id)` implementing the same four rules and raising the same authored `VoiceUnavailable` text; keep a thin re-export in `convai.py` so `test_piper.VoiceResolutionTests` stays green unmodified — that suite becomes the router's spec.
  3. Define the `SpeechEngine` protocol (`capabilities()`, `list_voices()`, `synthesize_pcm(voice_id, text) -> (pcm, rate)`), wrap the Pocket TTS worker pool and `piper.py` as the first two adapters, and route both `_Session._synthesize*` and the HTTP `/v1/text-to-speech` path through the registry instead of an `is_piper` boolean.
  4. Ship `service/tests/engine_conformance.py`: a parameterized suite every adapter must pass — honest sample rate, empty text is silence not an error, unknown voice message names how to install it, single-synthesis lock respected under concurrency, WAV container correctness, capability claims match observed behaviour (a Czech claim must actually produce >1 s of audio for a Czech sentence). One command per adapter.
  5. Prove the seam with a **third** engine (Kokoro-ONNX or espeak-ng as the trivial always-available floor), plus `ENGINES=` allow/deny and a per-language preference policy so an operator can say "German → Piper, English → Pocket TTS".
  6. Open it: load out-of-tree adapters from a `gravitone.engines` entry-point group, document the adapter guide next to the conformance kit, and have `/v1/engines` report which adapters passed conformance at boot.
- **Dependencies**: `piper.py` and the Pocket TTS pool as-is; the shipped `/benchmarks` capacity story (per-engine numbers become a natural extension); core-budget/thread accounting in `config.py` (each adapter needs its own run lock inside one global CPU budget).
- **Risks**: license mixing — an adapter under a viral license must be declarable and refusable, hence `license` in the manifest; CPU contention if two engines run unsynchronized (mitigated by the per-engine run lock the conformance kit asserts); capability drift, where an adapter claims a language it mangles (mitigated by the behavioural conformance assertion); voice-id namespace collisions across engines (prefix or registry-arbitrated).
- **What changes if we ship it**: Gravitone stops competing as one model and starts competing as the *place local speech engines plug in* — the language and quality ceiling becomes the community's, not ours.

---

## M2. The Polyglot Turn: a directing brain that follows the speaker into another language, mid-call

- **Tier**: 1 (10x category-defining)
- **Category**: functionality
- **Impact**: A conversation can start in English and continue in Czech because the *caller* switched — the ear already hears it, the brain answers in it, and the mouth is re-resolved **per sentence** while keeping one character identity. No hosted voice agent does honest mid-call code-switching on a CPU box with no API key.
- **Feasibility**: medium
- **Time-horizon**: months
- **Why it's a moonshot**: Every voice-agent product on the market fixes the language at session start, because voice, prompt and engine are bound at connect. Here the pieces are already separate — a language-aware ear, a stateless brain, and a router that dispatches by language — so the impossible feature is mostly a *contract* change: the brain must be allowed to say more than words. That same envelope carries emotion and end-of-call, so the brain starts **directing the performance** instead of feeding text to a synthesizer.
- **Path to implementation**:
  1. **In the current scaffold**: introduce a `TurnPart` frozen dataclass in `dialog.py` (`text`, `language`, `emotion`, `end_call`) and have `_SentenceBuffer` emit parts whose fields default to the agent's own language/emotion. Add a compatibility shim so `reply()` consumers that expect `str` keep working — `test_dialog.py` and `test_claude_cli_brain.py` pass unchanged, which is the proof the refactor is safe.
  2. Teach the model-backed brains an inline directive grammar the buffer strips before the text is ever spoken or transcribed — `[lang:cs]`, `[emotion:warm]`, `[end_call]` — reusing the emotion vocabulary already shipped on the synthesis side. Guard it the way the tool-use abort is guarded: a test asserting no directive text can reach the synthesizer, and an unknown directive is dropped-and-logged, never voiced. `ScriptedBackend` gains optional per-line directives so language-switch tests stay deterministic.
  3. Feed the transcriber's detected language into the history the brain sees and add a prompt clause ("answer in the language the caller just used"); `Agent` gains `languages: []` so an agent declares which switches it will honour and `/v1/convai/agents` reports a speakable **matrix** rather than one boolean.
  4. Re-resolve the mouth per part in `_Session._speak` when the language changes: a `character` alias maps one identity to a per-engine voice (cloned Pocket TTS voice for English, the installed Piper voice for Czech), each part is resampled from its own engine's native rate to the conversation rate, and an unspeakable switch produces a short authored apology **in the language we can still speak** instead of English phonemes over Czech words.
  5. Wire `end_call` into the session close path with a real reason string for the recording, and log directive telemetry (which languages callers actually switch into) — the same demand-signal shape the emotion coverage loop uses, feeding "install a Piper voice for X".
  6. Keep the second voice hot: pre-resolve and pre-load the declared languages' voices at connect (Piper's LRU is already bounded at 3), so the first switched sentence does not pay a cold ONNX load mid-conversation.
- **Dependencies**: M1's engine registry (or, without it, `piper.voice_for_language` directly); `stt` language detection; `_SentenceBuffer`; the per-part resampling path in `convai.wav_to_pcm`.
- **Risks**: audible discontinuity when the character changes engine mid-turn (mitigate by switching only at sentence boundaries and by loudness-matching); a model that hallucinates directives or announces them out loud (strip + guard test + refuse-unknown); latency spike on the switching sentence (pre-warm); scripted determinism (directives opt-in only); the ear mis-detecting language on a short utterance and flapping the voice (require two consecutive utterances in the new language before switching).
- **What changes if we ship it**: Gravitone becomes the only local voice-agent runtime whose conversation is genuinely bilingual in flight — and the brain gains a performance channel, so future direction (emotion, pacing, hand-off) is a new field rather than a new architecture.
