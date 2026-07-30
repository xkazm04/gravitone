# Moonshots — Voice Creation Studio (web)

Context: `web/app/voices/new/` (page.tsx, `_state/machine.ts`, `_state/useIngestJob.ts`,
`_state/uploadLimits.ts`, `_loaders/shared.tsx`) + `web/app/api/ingest/**`, backed by
`service/ingest_api.py` and `service/ingest.py`.

What the flow is today: one recording → one scan job → pick a speaker → a **read-only
ledger** of proposed stems (emotion, seconds, segments, `eligible`, one cue) where the
only verb is keep/descope → commit clones every kept stem on the CPU engine. Two
structural facts drive both moonshots below:

1. **The user never hears the clone before paying for it.** `/preview/{emotion}` serves the
   spliced *source* stem — the speaker's own audio. The question the whole product exists
   to answer ("does this sound like me?") is only answerable *after* an irreversible,
   ~20s-per-emotion commit that writes real Voices into the roster.
2. **The stem is an opaque aggregate.** `label_and_stem` already writes per-segment wavs
   (`seg_%03d.wav`) with emotion, confidence, cue, text, duration and `ok` — then
   `concat_wavs` collapses them into one number on screen. A mislabelled segment, a cough,
   or a stem 0.4s under `MIN_STEM_SECONDS` (4.0s) is currently unfixable except by finding
   a different recording.

Neither is on the rejected list, and both are distinct from deferred item *"stem top-up +
re-export"* (which is about appending audio to an **already-committed** voice) and from the
shipped guided emotion recorder (which records **fresh** takes).

---

## M1. The Audition Room — hear the clone, side by side, before it exists

- **Tier**: 1 (10x category-defining)
- **Category**: functionality
- **Impact**: Turns voice cloning from a blind one-shot purchase into an audition: the
  studio synthesizes candidate clones of a sentence the user chooses, they pick the winner
  by ear (blind, with an objective similarity number), and only the winner is committed.
- **Feasibility**: medium
- **Time-horizon**: months
- **Why it's a moonshot**: Every cloning product on the market — ElevenLabs included — makes
  you commit first and judge afterwards, because their clone is a paid remote operation.
  Gravitone's clone is *local CPU*, which means candidate generation is nearly free and can
  be done many times over. That inverts the whole interaction: instead of "we produced 8
  voices, hope they're good", the studio produces *options* and the user's ear is the
  selector. It also converts a subjective vibe into a measurable score, which is the seed
  of a quality loop the product has nowhere else.
- **Path to implementation**:
  1. **Scratch synthesis of one stem.** Add `POST /v1/ingest/{job}/audition` (emotion +
     sentence) that clones `stem_{emo}.wav` into a **throwaway** voice id (reuse the
     `export_stems` child path with `allow_short=True`, never touching `_load_meta()`'s
     roster), synthesizes the sentence, returns wav bytes, and deletes the scratch voice.
     Proxy it as `web/app/api/ingest/[job]/audition/route.ts`. In the review table, add a
     second play control beside the existing ▶ ("hear the stem" vs "hear it **as a
     voice**"). This alone is shippable in the current scaffold and is the single highest-
     value change on this screen.
  2. **Recipes, not one stem.** Parameterise the splice: `concat_wavs` already caps at 30s
     and level-matches, so 2–3 recipes per emotion fall out cheaply — *longest*,
     *highest-confidence-only* (`confidence` is already on every label), *tightest*
     (drop the noisiest spans using the `Levels` measurements the sovereign path computes).
     Job result grows `stems[].recipes[]`; `Result`/`Stem` in `machine.ts` grow with it.
  3. **Blind A/B in the review phase.** New sub-view: two unlabelled players, X/Y, a
     "sounds more like the speaker" vote, best-of-N ladder per emotion, reducer state
     `auditions: Map<emotion, recipeId>`. Keep the ledger table as the overview; the
     audition is a drill-down, so the fast path stays one click.
  4. **An objective second opinion.** Hold back ~15% of the target speaker's segments at
     scan time, then score each candidate with the speaker-embedding cosine the cloning
     path already computes. Display it *after* the user's vote so it informs but never
     overrides the ear.
  5. **Commit the winner.** `CommitReq` gains `recipes: {emotion: recipe_id}`; commit
     re-splices to the chosen recipe before export. Auditioned+rejected recipes are
     discarded with the workdir.
  6. **Close the loop.** Persist (recipe kind → won/lost) counts per job. After a few
     hundred auditions the default recipe is chosen by evidence, and the review ledger can
     pre-mark the recipe most likely to win.
- **Dependencies**: `service/export_stems.py` needs a scratch/ephemeral export mode that
  bypasses roster registration and `slot_holder` collision checks; ingest admission gate
  (`_admit`) must treat auditions as cheap so they don't consume a job slot; the studio's
  429 backpressure path already handles refusals if it does.
- **Risks**: CPU cost — each audition is a real model load unless the child process is kept
  warm (mitigate: one child per job, auditions streamed into it, same pattern commit
  already uses). Scratch voices leaking into `meta.json` on a crash (mitigate: prefix + GC
  in `_gc_once`). Decision fatigue if A/B is on the critical path (mitigate: opt-in
  drill-down, defaults still commit in one click). Users concluding the model is weak from a
  bad recipe rather than a bad model.
- **What changes if we ship it**: The studio stops shipping voices and starts shipping
  *choices* — and "I heard it and picked it" is a fundamentally different trust posture
  than "it cloned and I hope it's good".

---

## M2. Segment Casting Board — a curated voice corpus instead of one lucky recording

- **Tier**: 2 (3-5x)
- **Category**: user_benefit
- **Impact**: Makes the atom of voice creation the **segment**, pooled across every
  recording a character has ever been given, so the user assembles each emotion stem from
  their best available audio instead of accepting whatever one file happened to contain.
- **Feasibility**: medium
- **Time-horizon**: months
- **Why it's a moonshot**: Clone quality is almost entirely a function of stem content, and
  right now the user has zero authority over it — a single mislabelled laugh can poison the
  baseline, and "detected, too short" is a dead end shown as a grey badge. Exposing the
  segment layer that `label_and_stem` already produces converts the studio from a black box
  into an instrument, and pooling across jobs breaks the hard ceiling that no single upload
  can cover eight emotions.
- **Path to implementation**:
  1. **Make the segments visible.** Serve the existing per-segment labels on the job result
     (emotion, seconds, `text`/cue, `confidence`, `failure`, `ok`) and add
     `GET /v1/ingest/{job}/segment/{i}` (a sibling of `speaker-preview`, identical shape).
     Expand each ledger row into its segments with a play button — read-only, no new state
     machine, doable now and immediately useful: this is also the honest explanation for
     the "mixed" note `plan_baseline` emits.
  2. **Make them editable.** `POST /v1/ingest/{job}/stems` takes `{emotion: [segment
     indices]}`, re-runs `concat_wavs`, returns the new per-stem seconds/eligibility. UI:
     exclude a segment, or move it to another emotion. Reducer gains
     `assignments`/`dirty`; the "descope" button becomes one operation among several.
  3. **Re-splice live.** Debounced re-splice on edit, with the seconds bar and the
     `eligible` badge updating against `min_stem` — the user can *watch* a short stem cross
     the 4s line. Pairs directly with M1: re-splice then audition.
  4. **Pool across recordings.** Promote segments out of the ephemeral workdir into a
     per-character segment store (durable dir + index), keyed by character, written at scan
     time. A new scan on an existing character contributes to the pool rather than starting
     from zero, and a stem may draw from several recordings. The upload phase gains a
     "contribute to <character>'s pool" mode alongside the existing new/extend choice.
  5. **Coverage becomes a plan.** The Coverage Coach on the complete screen already knows
     which emotions are missing; with a pool it can say *what audio would fix it* ("3.1s of
     angry pooled — 0.9s short; one guided read closes it") instead of only linking to a
     fresh recording.
- **Dependencies**: durable segment storage with real retention/consent semantics (today
  everything dies with the job workdir, and the Voice Vault records ownership only at
  commit); a pool-scoped consent/attestation model — audio outliving a session is a
  privacy commitment, and sovereign mode must keep the pool local; `Result`/`Stem` type
  growth in `machine.ts` plus reducer actions for assignment.
- **Risks**: Scope — this is the flow's biggest surface change and can easily become an
  audio editor nobody asked for (mitigate: ship step 1 alone and measure whether anyone
  expands a row before building step 2). Storage growth and a new deletion obligation.
  Users hand-curating themselves into *worse* stems than the automatic plan (mitigate: keep
  "reset to proposed", and let the M1 similarity score referee).
- **What changes if we ship it**: A character's voice stops being the artefact of one lucky
  upload and becomes an asset that improves every time the user feeds it more audio.
