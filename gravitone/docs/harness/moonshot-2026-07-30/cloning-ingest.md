# Moonshots — Voice Cloning & Ingest Pipeline (2026-07-30)

Context files read: `service/ingest.py`, `service/ingest_api.py`, `service/diarize.py`,
`service/export_stems.py`, plus the parts of `service/config.py`, `service/stt.py`,
`service/app.py` they touch. Baseline noted: the pipeline is *honest* (every degenerate
outcome named, spend ledgered, cancellation everywhere) but it is **blind and
disposable** — it never hears the voice it produced, and it deletes everything it
learned 30 minutes later.

---

## M1. The Fidelity Loop — the pipeline hears its own clone, and optimizes for measured identity

- **Tier**: 1 (10x category-defining)
- **Category**: functionality
- **Impact**: Every clone ships with a *measured* similarity-to-reference score instead of a hope, and stem selection becomes an optimization against that score rather than the current hand-tuned heuristics (`MIN_STEM_SECONDS = 4.0`, `BASELINE_BORROW_ORDER`, `plan_baseline`'s "just clear the bar"). Cloning quality stops being luck-of-the-recording and becomes a number the product can improve, guarantee, and refuse to ship below.
- **Feasibility**: high
- **Time-horizon**: weeks
- **Why it's a moonshot**: Today the *only* verification in the whole clone path is `_export_one`'s load-back — proof the file parses, not that it sounds like the person. Nobody, including us, can answer "is this clone good?" without listening. Closing that loop turns a one-shot funnel into a search: the same 40 labelled segments can be selected, ordered and level-matched dozens of ways, and the pipeline can pick the combination whose *synthesized* output lands closest to the reference speaker. That is a quality axis no ElevenLabs-compatible competitor exposes at all, and on a CPU-only Arm box we already own both halves — a speaker embedder (WeSpeaker CAM++, vendored for `diarize.py`, no account, ONNX, ~29 MB) and a local synthesizer.
- **Path to implementation**:
  1. Add `service/voiceprint.py`: wrap `sherpa_onnx.SpeakerEmbeddingExtractor` at `diarize.embedding_path()` into `embed(wav) -> np.ndarray` + `similarity(a, b) -> float`, with the same lazy-load/lock/`Unavailable` discipline `diarize.py` already models. Then, purely as *measurement*, embed each `stem_*.wav` in `label_and_stem` and publish `fidelity: {reference_similarity, per_segment_outliers}` in the existing `partial`/`result` payloads. No behaviour changes; the studio just starts showing a number.
  2. Use the same primitive to clean the *inputs*: a segment whose embedding sits far from the target speaker's centroid is a diarization error or a bystander voice. Drop it from stems (reported, in the pipeline's existing "name the outcome" style). This alone fixes sovereign mode's stated single-speaker blind spot without a diarizer.
  3. Close the loop at commit: after `export_stems` writes a `.safetensors`, synthesize one fixed calibration line through it and score the output against the reference stem. Persist the score on the Voice's `_meta.json` entry beside `sample_seconds`. Emit a `fidelity_floor` refusal (the same "skipped and reported" treatment too-short stems get) when a clone lands below a measured threshold.
  4. Turn scoring into selection: replace `plan_baseline`'s fixed borrow order with a greedy/beam search over labelled segments that maximizes measured fidelity per second of stem, capped at a small number of export+score rounds (each is one warm model load, seconds on Arm). Keep the current plan as round zero so it can never do worse.
  5. Calibrate the thresholds against a fixture set (real recordings + this service's own voices — `diarize.py` already documents that synthetic speech behaves differently, so the two need separate floors) and pin them in `Settings` with the measurement written down, exactly as `DIARIZE_THRESHOLD = 0.6` is.
  6. Expose it: `GET /v1/voices/{id}/fidelity` and a per-take fidelity badge; the same primitive answers "is this upload the same person as an existing voice?" — dedupe and an impersonation guard for free.
- **Dependencies**: `sherpa-onnx` + the CAM++ model (already a requirement and a one-command download); a warm synthesis path callable from the commit phase; fixture recordings for calibration. No new vendor, no key, no torch.
- **Risks**: Speaker-embedding similarity is a proxy, not perceptual quality — a high score with bad prosody is possible, so the number must be presented as *identity match*, never as "quality", or it becomes a lie in the product's voice. Extra export+score rounds cost CPU on the heaviest phase (bound them, and make round count a setting). Calibration on synthetic speech is genuinely unreliable (measured, in `diarize.py`) — separate floors or none.
- **What changes if we ship it**: Gravitone becomes the only self-hostable TTS platform that certifies how well each voice matches its owner, and clone quality becomes an engineering metric we can push instead of an anecdote.

---

## M2. The Voice Corpus — ingest stops being disposable and starts compounding

- **Tier**: 1 (10x category-defining)
- **Category**: platform
- **Impact**: Everything ingest learns about a person — segments, emotion labels, confidences, cues, measured levels, voiceprints, consent receipts — survives the job instead of being `rmtree`'d by GC after 30 minutes. Voices become *re-derivable artifacts of a growing corpus* rather than one-shot outputs, so every later improvement (a better splice DSP, a new Pocket TTS release, M1's fidelity search, one more recording) retroactively improves voices that already exist.
- **Feasibility**: medium
- **Time-horizon**: months
- **Why it's a moonshot**: The whole intelligence of this pipeline is thrown away by design — `_gc_once` deletes the workdir, and the only survivor is an opaque `.safetensors` nobody can regenerate or explain. That makes every quality gain a *future-only* gain and makes every new recording start from zero: a user who records again gets a second unrelated clone attempt, not a better voice. A durable per-character corpus inverts the economics of the product — the more a user uses it, the better their existing voices get, without them doing anything. It is also the seam that makes several previously-blocked things trivial rather than bespoke (stem top-up, coverage fill, model-upgrade re-export, corpus-in-a-pack portability), and it is a moat: the corpus lives on the user's own box, so switching away costs them their accumulated voice history.
- **Path to implementation**:
  1. On a successful `commit`, *copy* (never move) the job's durable facts into `SETTINGS.corpus_dir / <character_id>/`: the segment wavs actually used, `segments.json` with labels/confidences/cues/failures, the built stems, measured `Levels`, `clip_sha256`, and the consent receipt already stamped on each Voice. Append-only, content-addressed by clip hash so re-ingesting the same recording is a no-op. Nothing else changes — GC still reaps workdirs, the corpus is purely additive and inspectable.
  2. Give the corpus a schema and an index (`corpus.json` per character: segment id → emotion, seconds, fidelity, source clip, consent ref) plus a read API — `GET /v1/characters/{id}/corpus` — so the studio can show a person what audio of theirs the box holds. This is also the deletion surface: `DELETE` by clip hash removes every derived segment, which is what makes retention defensible.
  3. Re-derivation as a first-class job mode: `POST /v1/ingest/rederive {character_id, emotions?}` rebuilds stems from the corpus (best-of selection, no upload, no cloud call, no new consent) and re-exports the Voices in one `export_stems` child. Sovereign by construction — nothing leaves the machine.
  4. Make new recordings *append* rather than replace: an ingest job that names an existing character adds its segments to the corpus, and the commit step chooses between "new slot" and "improve existing slot" by measured fidelity (M1). A too-short emotion that could never clear `MIN_STEM_SECONDS` alone now clears it across takes.
  5. Stamp a `derived_from` provenance record on every Voice (corpus revision + splice DSP version + model version), and trigger a "your voices can be improved" signal when any of those move — the re-derive job is the one click that resolves it.
  6. Corpus portability: let `.gravichar` optionally carry the corpus (opt-in, consent-gated, size-capped) so a character can be re-derived on another machine, not merely replayed.
- **Dependencies**: a `corpus_dir` setting + retention policy; the existing consent receipt and `clip_sha256` (both already captured); `export_stems`' one-load exporter (already the right shape for batch re-export); M1's fidelity score to make "best-of" mean something (M2 works without it using duration/confidence, just less well).
- **Risks**: **Retention is the real risk** — this deliberately keeps human voice audio on disk, and the product's trust story is sovereignty. It must be opt-in per character, visible, itemized, and deletable, with a hard cap and a default TTL; consent must cover retention explicitly, not just cloning. Disk growth on small Arm boxes (cap + prune oldest-lowest-fidelity segments). Corpus schema drift across versions (version the index, never break re-derive). Cloud-mode labels are provider-derived, so a corpus can encode a provider's mistakes permanently — keep labels editable.
- **What changes if we ship it**: A Gravitone box gets *better at your voice over time*, and every future engine improvement ships as an upgrade to voices you already made — the flywheel a one-shot cloning product structurally cannot have.
