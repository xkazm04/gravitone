# Moonshots — Speech Synthesis API (2026-07-30)

Context scanned: `service/app.py` (TTS + /stream + /speak + /performance + /health + /metrics),
`service/auth.py`, `service/keys.py`, `service/config.py`, plus the shapes of
`service/cache.py`, `service/engine.py`, `service/stt.py`, `service/convai.py`, `service/voices.py`.

Grounding facts the proposals build on (already in the scaffold):
- `_cache_key(voice_id, text, overrides, frames_after_eos)` + `_voice_fingerprint(voice_id)` already
  compute a complete, stable request identity; `SYNTH_CACHE.get_or_synthesize` already collapses
  duplicate in-flight renders and reports `X-Cache: hit|miss|bypass`.
- Responses already carry a real measurement channel: `X-Audio-Seconds`, `X-Synth-Seconds`,
  `X-Queue-Seconds`, `X-Realtime-Factor`, `X-Synth-Segments`.
- Synthesis is CPU-local and unmetered, so *spending inference to check inference* is free here and
  structurally impossible for a per-character cloud vendor.
- A local ASR with **word-level timestamps** now exists in-process (`service/stt.py` `Word`,
  `Transcript`, `transcribe_pcm`) because the new conversational layer needed ears.
  Nothing on the synthesis side consumes it yet — that is the biggest unexploited asset in this context.

---

## M1. Speech as a build artifact — content-addressed synthesis + incremental `POST /v1/build`

- **Tier**: 1 (10x category-defining)
- **Category**: platform
- **Impact**: Turns TTS from a stream of one-off billable calls into an *incremental build system*: a
  project's 5,000 lines get a lockfile of content digests, and a revision that changes 2% of the script
  re-synthesizes 2% of the audio, deterministically, on any machine.
- **Feasibility**: high
- **Time-horizon**: months
- **Why it's a moonshot**: Every cloud TTS API is stateless-per-call because per-call is how it bills;
  nobody can offer "your audio is a reproducible artifact addressed by its inputs" when re-serving costs
  them money. Gravitone's economics invert that, and the identity function (`_cache_key` +
  `_voice_fingerprint`) is *already written* — it is currently a private in-process cache key that could
  instead be the public name of a piece of audio. Making the digest a first-class, sharable address
  creates the first speech pipeline that behaves like `make`, with CI diffs, lockfiles in git, and a
  team-shared object store.
- **Path to implementation**:
  1. Promote the existing cache identity to a public address: emit `X-Speech-Digest: sha256:…`
     (over voice fingerprint + normalized text + overrides + `frames_after_eos` + model/engine version +
     output format) on `POST /v1/text-to-speech/{voice_id}`, and honour `If-None-Match` → `304` when the
     digest matches. Pure additive header work inside the existing handler; no new storage.
  2. Add a durable content-addressed store beside the in-process `SYNTH_CACHE` (`GET /v1/audio/{digest}`
     read, `HEAD` for existence) so a digest is retrievable across restarts and replicas — same
     `atomicio` atomic-write + file-lock discipline `keys.py`/`voices.py` already use.
  3. `POST /v1/build`: accept a manifest (`[{id, voice, text, emotion?, settings?, format?}]`),
     return per-line digests + `state: fresh|rendered` without a byte of audio; a companion
     `GET /v1/build/{build_id}.zip` (or per-line digest fetch) delivers the artifacts. Reuses
     `_submit_batch` / `_gather_results` and the existing admission + backpressure semantics.
  4. Emit a `gravitone.lock` document (line id → digest → engine/voice version) and a
     `POST /v1/build/plan` dry-run that answers "what would change?" — the CI primitive.
  5. Ship a tiny `gravitone build` client (script + GitHub Action) that reads a repo's script files,
     calls `/v1/build/plan`, fails a PR when audio drifts unexpectedly, and commits the lockfile.
  6. Make the digest store poolable: allow a shared filesystem/S3-shaped backend so a team (or a
     multi-replica fleet) hits one warm object store — the network effect: the more of a team that
     builds, the less anyone synthesizes.
- **Dependencies**: stable engine/model version string exposed for the digest (engine.py); durable store
  path + retention policy; format-aware digests (`_parse_format`) so `mp3_*` and `wav_*` don't collide;
  no billing/entitlement work whatsoever (explicitly out of scope).
- **Risks**: digest instability — any silent change to normalization, resampling, or model weights must
  bump the version component or the lockfile lies (mitigate with a digest-stability test that pins a
  golden manifest); unbounded disk growth without retention; `_chunk_text` segmentation must be part of
  identity or concat seams make "same digest, different bytes" possible; `/v1/build` must not let one
  manifest starve the pool (cap manifest size, reuse admission).
- **What changes if we ship it**: Audio stops being a delivery and becomes a checked-in artifact —
  studios, e-learning teams and audiobook shops can put voice in CI, and the incremental economics make
  re-recording a script a routine edit instead of a budget decision.

---

## M2. Verified speech — the first TTS API that listens to its own output

- **Tier**: 1 (10x category-defining)
- **Category**: functionality
- **Impact**: Every synthesis can be re-transcribed by the in-process ASR and returned with a
  word-level timeline plus a fidelity verdict, so the API stops promising "audio was produced" and starts
  guaranteeing "the audio says exactly this, and here is where each word lands."
- **Feasibility**: medium
- **Time-horizon**: months
- **Why it's a moonshot**: No hosted TTS will burn a second inference pass to grade its own first one —
  it doubles their cost per call. Here the second pass is free CPU, and the ears already exist in the
  repo for the conversational layer. That single asymmetry lets the API expose something categorically
  new: a *measured* correctness contract (dropped words, mangled numerals/acronyms, mispronunciations
  caught and retried before the client ever hears them) and a word/phoneme timeline that unlocks
  captions, lip-sync visemes, karaoke UIs and duration-locked dubbing — capabilities customers currently
  buy from three separate vendors.
- **Path to implementation**:
  1. Add `POST /v1/text-to-speech/{voice_id}/with-timestamps` (the ElevenLabs-compatible shape: JSON with
     base64 audio + character/word alignment) implemented by feeding the finished WAV through
     `stt.transcribe_pcm` and mapping its `Word` spans onto the request text. Fits the existing handler:
     synthesis path unchanged, alignment is a post-step, and `SYNTH_CACHE` caches the alignment with the
     audio.
  2. Add a fidelity verdict on the normal route: `X-Fidelity-Score` + `X-Fidelity-Deltas` (normalized
     word-error against the input text) behind an opt-in `verify=true` query so the default hot path stays
     untouched and the benchmark harness is unaffected.
  3. Auto-repair loop: on `verify=strict`, a failed check re-renders the offending *segment* only
     (segmentation already exists via `_chunk_text`/`_submit_batch`) with a nudge — a pronunciation hint or
     re-chunk — and returns `X-Fidelity-Retries`. Bounded by the existing admission + deadline machinery.
  4. `fit_duration_ms` synthesis mode: iterate rate/segment pacing until measured `X-Audio-Seconds`
     lands inside tolerance, reporting the achieved delta — duration-locked dubbing without a video vendor.
  5. Expose a per-voice pronunciation lexicon fed by the verifier's own failures (the words this voice
     reliably mangles), so the same correction is applied automatically on later requests — the system gets
     more accurate the more it is used.
  6. Publish alignment as a viseme/caption track (`format=vtt|json|visemes`) so avatar and video clients
     consume it directly, and surface aggregate fidelity in `/metrics` as a quality SLO.
- **Dependencies**: `service/stt.py` model availability (`stt.available()` — must degrade cleanly to
  today's behaviour when absent, exactly as convai's `VoiceUnavailable` path does); a text normalizer
  shared by input and transcript comparison; a new grantable scope or reuse of `tts` for the verified
  routes; CPU headroom accounting (verification roughly doubles work — must be opt-in and admission-aware).
- **Risks**: ASR error mistaken for TTS error (false rejections on proper nouns — needs a confidence floor
  and a "verified only against high-confidence words" rule); latency doubling if verification ever becomes
  default; retry loops interacting badly with the queue cap under load; alignment mapping is genuinely
  fiddly for numerals/abbreviations where spoken and written forms diverge; streaming route can't carry a
  post-hoc verdict in headers (verification belongs to the non-stream and build paths).
- **What changes if we ship it**: The product's claim moves from "cheap local speech" to "speech you can
  *prove*" — an auditable correctness and timing contract that makes Gravitone viable for regulated
  narration, dubbing and animation pipelines where a silently dropped word is a recall, not a blemish.
