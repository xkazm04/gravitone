# Moonshots — TTS Playground (web), 2026-07-30

Context: `web/app/playground/` (page.tsx, `_variants/PlaygroundConsole.tsx`,
`EmotionPicker.tsx`, `engine.ts`, `useAudioPlayer.ts`, `shared.ts`, `TakeCode.tsx`),
`web/app/api/speak|performance|tts/route.ts`, `web/lib/backend.ts`,
`web/lib/audioFormats.ts`, `web/lib/playgroundDb.ts` / `takeStore.ts`.
Exploited adjacency: the service's brand-new conversational layer
(`service/convai.py`, `stt.py`, `vad.py`, `dialog.py`, `recording.py`) has **zero**
surface in the web studio today — `grep -rl convai web/` matches only unrelated
copy files.

Both proposals are deliberately outside the rejected clusters (no metering,
tiers, pricing, cast cloning, white-label) and outside `followups-2026-07-10.md`
(no gallery/marketplace, no OG/MP4 card, no web component/oEmbed, no
entitlement gating, no stem top-up).

---

## M1. Table Read — the console becomes a live, interruptible rehearsal room

- **Tier**: 1 (10x category-defining)
- **Category**: platform
- **Impact**: Turns the studio's central page from a batch text→file form into a
  real-time duplex instrument: you *talk* to a Character on your own CPU, it
  answers in its cloned voice, you talk over it and it stops. Every turn lands in
  the existing takes log, so a rehearsal *writes* the script the composer renders.
- **Feasibility**: medium
- **Time-horizon**: months
- **Why it's a moonshot**: The hard half already exists and nobody can see it —
  VAD turn-taking, local Whisper ears, streaming dialog with sentence-level
  synthesis, barge-in cancellation, ticket-authenticated sockets, and aligned
  two-track call recording are all shipped in `service/`. Surfacing it makes
  Gravitone the only voice studio where the same page that authors lines can
  *hold a conversation* with them, at zero per-minute cost, offline. It also
  reframes the product: not "cheap TTS", but a local realtime voice-agent
  workbench whose output is authored assets.
- **Path to implementation**:
  1. Add `web/app/api/convai/signed-url/route.ts` and `web/app/api/convai/agents/route.ts`
     as thin `proxyJson` wrappers over `/v1/convai/conversation/get-signed-url`
     and `/v1/convai/agents` — the server-side key attachment in `lib/backend.ts`
     already does the auth the browser can't. Purely additive; verifiable by
     hitting the routes with the service running.
  2. New client module `_variants/conversation.ts`: mic capture → AudioWorklet
     downsample to 16 kHz PCM16 → base64 `user_audio_chunk` frames; inbound
     `audio` chunks into a jitter-buffered Web Audio playback queue; handle
     `user_transcript`, `agent_response`, `interruption`, `ping`/`pong`. Reuse the
     console's `Bars` for a live input meter.
  3. Add a third composer mode — **Live** — beside Solo/Script in
     `PlaygroundConsole`, driven by the same Character rail (the agent's voice is
     resolved by `convai._resolve_voice`) plus a one-line scene note. Transcript
     renders as a growing turn list using the existing take-card visual language.
  4. Round-trip with the composer: each completed turn becomes a `ScriptLine`
     (character = the speaking Character), so a rehearsal produces a directed
     script; inversely, "rehearse this script" seeds a `ScriptedBackend` agent
     from the existing lines so Live works with **no LLM configured**.
  5. Persist each agent turn as a real `Take` (encode the buffered PCM to WAV,
     `computePeaks` for the ribbon) so barge-in output inherits every shipped
     path unchanged: player, share, review link, per-take code export, mp3.
  6. Stretch: when `CONVAI_RECORD` is on, offer the aligned `user.wav` /
     `agent.wav` pair as a "call master" download — the two-track timeline the
     recorder already guarantees.
- **Dependencies**: browser mic permission + secure context (localhost is fine);
  the WebSocket is opened **directly against the service origin** (the signed URL
  carries a `ws://` base from the request), so the service must be
  browser-reachable and CORS/WS-permissive — or a Next WS relay is needed for
  deployments where only the studio is exposed. A dialog backend for non-scripted
  use (`ClaudeCliBackend` or an OpenAI-compatible endpoint).
- **Risks**: `convai._Sessions` caps concurrent sessions — a busy studio must
  show "line busy" honestly rather than degrade silently; a live session competes
  with the synth pool for the same cores, so Live and Generate should not run
  concurrently (the console already models `busy`/queue depth and can gate it);
  no acoustic echo cancellation means speaker bleed can trigger false barge-in
  (headphones-recommended notice, or push-to-talk fallback); ticket TTL expiry
  mid-reconnect; exposing the service origin to the browser is a deployment
  posture change that must not weaken the local-only claim.
- **What changes if we ship it**: The playground stops being a form and becomes
  the demo that sells the platform — a local voice agent you can interrupt — and
  every conversation silently produces authored, shareable takes.

---

## M2. Punch-in timeline — takes become editable, not disposable

- **Tier**: 1 (10x category-defining)
- **Category**: functionality
- **Impact**: Fixing one word in a 40-line performance costs one segment render
  instead of the whole script — an order-of-magnitude cut in the thing that
  actually hurts on CPU-only hardware (wall-clock iteration), and the first
  editing surface in the product.
- **Feasibility**: high
- **Time-horizon**: weeks
- **Why it's a moonshot**: Every cloud TTS studio treats a render as immutable —
  disagree with a syllable and you pay for the whole thing again. Gravitone
  already carries the exact data an editor needs (`Segment` has `text`,
  `requested`/`used` emotion, `voice_id`, `seconds`, `characterId`, `line`,
  decoded from `X-Segments` / `X-Performance-Report`) **and** owns a local
  word-timestamped ASR (`POST /v1/speech-to-text`). Combining its own ears with
  its own mouth gives word-accurate punch-in that costs nothing per edit — a
  capability the per-character-billed incumbents structurally can't match.
- **Path to implementation**:
  1. Render a **segment timeline** on the take card from data already in state:
     cumulative `segment.seconds` gives each region's offset, and clicking a
     region seeks the `<audio>` element `useAudioPlayer` already drives. Pure UI
     inside `PlaygroundConsole`/a new `TakeTimeline.tsx`, no backend change.
  2. Add a splice kernel to `engine.ts` + a new `lib/wavEncode.ts`: decode the
     take blob and a re-rendered fragment on the shared `AudioContext`, concat
     the `AudioBuffer`s with a short crossfade, encode a WAV master, and emit a
     new `Take` with patched `segments` (mp3 takes are decoded and re-mastered as
     WAV). Use the decoded duration, not the header seconds, as truth.
  3. **Retake this segment**: re-render only the selected region via `/api/speak`
     with its own emotion / `Expression` / Character override, splice, and keep up
     to N variants per region as A/B lanes — audition, pick per region, commit one
     new take.
  4. **Word granularity**: add `web/app/api/stt/route.ts` proxying
     `/v1/speech-to-text` (word timestamps already supported) and run it over a
     take once; word regions inside a segment let a single mispronounced word map
     to the smallest re-renderable text span.
  5. Provenance: extend `Take` with `edits[]` (source take id, region, recipe) so
     `TakeCode.tsx` exports the full reproduction (base `/v1/performance` call +
     the patch calls) and `takeStore` restore keeps the edit history durable.
  6. Stretch: hand a punched take to `service/export_stems.py` so a finished
     timeline exports per-character stems for a DAW.
- **Dependencies**: nothing new server-side for steps 1–3 (`/api/speak` and the
  segment reports exist); step 4 needs the STT proxy route and faster-whisper
  weights present; `TAKE_TIMING_VERSION`-style versioning for the new `edits`
  field so older records restore cleanly.
- **Risks**: prosody discontinuity at splice points — mitigate by snapping
  boundaries to sentence/segment edges (which is exactly where the engine already
  cuts) and always offering a full re-render as the escape hatch; variant lanes
  multiply IndexedDB usage, so cap and prune (`storageErr` already surfaces quota
  failures honestly); a decode failure must degrade like `refinePeaks` does —
  never cost the user their take; word-level edits on very short spans may
  synthesize worse than the surrounding phrase, so prefer widening to the clause.
- **What changes if we ship it**: The playground graduates from "generate and
  hope" to a real editor, and the CPU-only story flips from a limitation into an
  advantage — local, free, unlimited iteration on the sentence you actually got
  wrong.
