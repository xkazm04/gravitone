# REPORT — F-LOOP (Fidelity Loop), batch 1

Source proposal: `cloning-ingest.md` M1, steps 1-3. Design contract: `DESIGN-BATCH-1.md` §5 F-LOOP,
contracts C3 (voiceprint) and C1 (the fidelity object / identity seam).

## Files created / modified

| File | What |
|---|---|
| `service/voiceprint.py` | **NEW** - contract C3: `available()`, `unavailable_reason()`, `embed()`, `similarity()`, `centroid()`, `read_samples()`, `info()`, `Unavailable`, `python -m service.voiceprint a.wav b.wav`. |
| `service/ingest.py` | Fidelity measurement in `label_and_stem` (segment judgement + per-stem scores + payloads), close-the-loop in `commit` (calibration synthesis -> identity -> registry row), new `synthesize=` seam. |
| `service/tests/test_voiceprint.py` | **NEW** - 31 tests (sherpa stubbed; degrade path, maths, audio-in, judgement, pipeline payload, commit loop). |
| `service/tests/test_ingest_pipeline.py` | 1 assertion made partial-order-independent (2 lines). |
| `service/tests/test_ingest_external.py` | 1 assertion made partial-order-independent (2 lines). |

Nothing else touched. `service/voices.py`, `service/ingest_api.py`, `service/export_stems.py` and
all of `web/` untouched. No git commands were run.

## Contracts implemented

**C3 - `service/voiceprint.py`.** Mirrors `diarize.py` deliberately: lazy `sherpa_onnx` import, lazy
model load behind `_LOAD_LOCK` keyed on (model path, thread budget), one embedding at a time under
`_RUN_LOCK`, `Unavailable` messages authored for an operator ("pip install sherpa-onnx" /
"`python -m service.diarize --download`"). The model is `diarize.embedding_path()` - one 29 MB
download serves both modules. Two additions beyond the literal contract, both load-bearing:

* `unavailable_reason() -> str | None` - the *reporting* twin of raising. The pipeline has to publish
  "identity was not measured, and here is why" without a try/except around every payload it builds.
* `read_samples()` - 8/16/32-bit and multichannel wav -> float32 mono at 16 kHz. Resampling is linear
  and the docstring says so: this audio is never listened to, only embedded, and both sides of every
  comparison take the identical path. `engine.resample_pcm16` stays the polyphase one for audible audio.

`similarity()` clamps to [-1, 1] and **raises on a zero vector** rather than scoring 0.0 (which would
read as a measured dissimilarity). `centroid()` unit-normalises before averaging so a loud clip cannot
pull the centre by magnitude, and raises when vectors have no common direction. `info()["measures"]`
carries the identity-not-quality caveat, per §2.

**C1 - identity onto the registry row.** `commit` stamps `entry["fidelity"]` through
`voices.measure_fidelity(wav, identity=...)`, reached via `sys.modules["service.voices"]` with a
`TypeError` fallback (call again without the keyword, merge identity ourselves) and a final fallback
that writes the identity half alone in the C1 shape. Verified live against F-LEDGER's landed
`measure_fidelity` - `test_voiceprint.CommitLoopTests` asserts the number arrives on the row.
**A row of Nones is never written**: with no identity, `fidelity` is absent, so `fidelity: null` keeps
meaning "not measured" and the UI renders nothing (§2 absent = invisible).

On `create_voice(fidelity_identity=...)`: that seam is the **direct-upload** door's.
`ingest.commit` does not (and cannot) call `create_voice` - it registers rows itself via `mutate_meta` -
so the identity is merged through `measure_fidelity` instead. The guarded-kwarg pattern the brief asked
for is applied there. No hook needed; nothing in `voices.py` has to change.

## What the pipeline now measures

**Steps 1+2 - the inputs (`label_and_stem`).** Every usable segment is embedded, the speaker's own
centroid is the reference, and each segment is scored against it. Result/partial payloads grow
`fidelity: {version, available, reason, reference_similarity, cohesion_mad, segments_measured,
segments_failed[], per_segment_outliers[], dropped, flagged, stems{}, measures}`. Each stem dict gains
`identity` (only when scored); each segment gains `outlier: "dropped"|"flagged"|null`. Both reach the
client with **no `ingest_api` change** - `_PUBLIC_KEYS` passes `partial`/`result` wholesale and job
partials merge rather than replace.

Judgement rules, and why they are shaped this way (the thresholds are **not** calibrated - that is
proposal step 5, out of batch 1):

* `OUTLIER_MAD_K = 3.0` - flag at 3 median-absolute-deviations below the median similarity.
  Self-calibrating per recording: there is no fixed "good" similarity to be wrong about.
* `FOREIGN_SIMILARITY = 0.25` - the **only** thing that removes audio, and the only absolute constant.
* `MAX_DROP_FRACTION = 0.34` - a recording of one person is never mostly somebody else; if the rule
  says it is, the rule is wrong, so the surplus is flagged as "the measurement is not trusted".
* The last remaining audio for an emotion is always **kept** (flagged), and a drop set that would strip
  everything is abandoned wholesale. Every one of those outcomes carries a named `why` sentence.

**Step 3 - the clone (`commit`).** After a stem exports (the file is already at its final path, and
`engine._Worker._voice_state` resolves voices by path rather than by registry row), one **fixed**
calibration line (`CALIBRATION_TEXT`) is synthesized through the new embedding and scored against the
stem it was cloned from - the first time this pipeline has ever heard its own output. `commit` gained
`synthesize: (voice_id, text) -> wav bytes`; left None it looks for an already-loaded engine in
`sys.modules["service.app"].ENGINE` (a lookup, never an import - ingest is imported *by* the app, so
importing back is a cycle, and a CLI run has no engine at all). Availability is asked **once** before
the model loads, so an un-equipped box spends zero CPU on a line it could not score. The per-voice dict
gained `identity` or `identity_reason`; `ingest_api` publishes it through `job["committed"]` unchanged.

Nothing here can fail a clone or a scan: both call sites are wrapped whole, and the number is presented
as advisory (see `voiceprint.py` on why synthetic speech is weaker evidence - inherited, measured, from
`diarize.py`). **No `fidelity_floor` refusal** - explicitly out of batch 1.

## Hooks required from others

1. **AUDITION (`ingest_api.py`) - optional, one argument.** To pass the synthesizer explicitly in
   `_do_commit` rather than relying on the module lookup:

   ```python
   created = ingest.commit(
       Path(job["work_dir"]), character, emotions, character_id,
       consent=statement, clip_sha256=job.get("clip_sha256"),
       progress=lambda done, cur: _commit_progress(job, done, total, cur),
       should_cancel=cancelled, on_voice=registered.append,
       synthesize=lambda voice_id, text: appmod.ENGINE.submit(voice_id, text)
                     .future.result(timeout=ingest.CALIBRATION_TIMEOUT_S).wav_bytes)
   ```

   Belt-and-braces, not a blocker: the default lookup already finds `service.app.ENGINE` when the
   service is running.
2. **F-LEDGER / web** - the review payload now carries `result.fidelity`, `stems[].identity` and
   `segments[].outlier`; all optional, all absent on old jobs. Render nothing when absent (§2).
3. **None from `voices.py`** - `measure_fidelity(wav, identity=...)` is exactly the seam needed and it
   already exists in the tree.

## Deliberately NOT done

* `SOVEREIGN_LIMITS` still says "anyone else audible in the recording is cloned into the same voice".
  Foreign-segment dropping softens that, but the sentence is duplicated in `web/`, asserted in
  `test_ingest_truth`, and stays TRUE on any box without the embedding model (i.e. this one). It should
  be revised together with the web copy - orchestrator's call, not a silent edit.
* Proposal steps 4-6 (beam-search stem selection, calibrated `fidelity_floor` refusals,
  `GET /v1/voices/{id}/fidelity`) - out of batch-1 scope per the design doc.

## Test evidence

| Module | Result |
|---|---|
| `service.tests.test_voiceprint` | **31 tests OK** (new) |
| `test_ingest_audio` / `_cancel` / `_external` / `_lifecycle` / `_pipeline` / `_sovereign` / `_truth` | 17 / 10 / 24 / 38 / 6 / 26 / 5 - all OK |
| `test_registry_invariants`, `test_private_surface` | 31, 21 - OK |
| `test_fidelity` (F-LEDGER), `test_prosody` (E-SPACE), `test_audition` (AUDITION) | 36, 37, 31 - OK with these changes in the tree |
| **Full loop, all 53 service test modules** | **OK** - 0 failures, 0 errors (5 skips, all pre-existing) |

`python -m py_compile` clean on every touched file.

What the tests prove, in the order that matters: (1) the **degrade path** - sherpa-onnx is genuinely
absent here, so the no-model behaviour is the default case: a named reason, no dropped audio, no
numbers, `identity` absent rather than zero, and a clone that ships anyway; (2) the plumbing under a
stubbed sherpa - extractor built from `diarize.embedding_path()` with the configured thread budget,
audio handed over at 16 kHz float32, `input_finished()` called, load cached across calls, NaN vectors
refused, too-short clips named; (3) the judgement with synthetic embeddings - bystander dropped,
unusual-but-same-speaker only flagged, last audio for an emotion protected, drop budget capped,
unembeddable segments listed not hidden; (4) the loop at commit - identity on the row and on the
caller's dict, exactly one fixed calibration line, no synthesis paid for when it could not be scored,
and a measurement that explodes leaves the clone intact.

## UX decisions (per §2)

* Everything is a **named fact**: `identity 0.96`, `dropped`, `flagged`, plus a `why` sentence per
  outlier. `reference_similarity` is documented for what it is - the median agreement of a recording
  with itself about who is speaking - not dressed up as a quality score.
* **"Identity", never "quality"** - verbatim in `voiceprint.info()["measures"]`, on every payload
  (including the ones that measured nothing), and in the module docstring's stated risk.
* **Absent = invisible**: unscored stems carry no `identity` key, unmeasured segments carry
  `outlier: null`, unmeasured voices carry no `fidelity` object at all.
* **Advisory, never blocking**: no refusal path exists anywhere in this work; every failed measurement
  is a logged, named skip that travels back to the caller.
