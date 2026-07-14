# Dual-lens scan — svc-ingest-pipeline
> Files: 3 | Findings: 5 (crit 0 / high 3 / med 2 / low 0)
> Lenses: bug-hunter + code-refactor

## 1. Commit can deadlock on a full child stderr pipe
- **Severity**: high
- **Lens**: bug-hunter
- **Category**: deadlock / pipe-buffer
- **File**: `service/ingest.py:538`
- **Scenario**: `commit()` spawns `export_stems` with `stdout=PIPE, stderr=PIPE` (line 524) and drains only stdout in `for line in proc.stdout:`. The child imports torch + pocket_tts and loads the model; if those emit more than the OS pipe buffer (~64 KB) to **stderr** before finishing all stdout status lines, the child blocks writing stderr while the parent blocks reading stdout — neither side advances.
- **Root cause**: stderr is never drained during the streaming loop; it is read only once at line 578, *after* the loop has already exited. Two full pipes with no concurrent reader = classic subprocess deadlock.
- **Impact**: A commit hangs forever. The daemon worker thread never returns, the job is stuck in `committing` (GC removes its workdir at 30 min but the hung thread + Popen persist), and no voices are reported.
- **Fix sketch**: Merge streams with `stderr=subprocess.STDOUT` (and skip non-JSON lines, which the loop already does), or drain stderr on a separate reader thread / use `select`. Do not leave stderr=PIPE undrained across a long-lived child.

## 2. Mid-batch stem failure or cancel orphans already-cloned, consent-stamped voices
- **Severity**: high
- **Lens**: bug-hunter
- **Category**: partial-commit / data-consent integrity
- **File**: `service/ingest.py:550`
- **Scenario**: With 3 accepted stems, stem #1 exports fine — its voice is persisted via `mutate_meta(_add)` (line 565) into the shared `voices/` + `_meta.json` store, stamped with the consent receipt. Then stem #2 emits `ok:false`; the parent `_terminate()`s and `raise`s (lines 550-552). `_do_commit` catches it and sets `status="error"` (ingest_api.py:269-271), discarding the `created` list. The same happens on user cancel (line 570-573): earlier voices are already committed but the job returns without recording them.
- **Root cause**: Cloning is persisted incrementally per emotion, but the caller and UI treat commit as atomic. There is no rollback of already-written voices and no surfacing of the partial `created` set on the failure/cancel path.
- **Impact**: Real, consent-bearing voices exist in the production voices store that the user was told errored/cancelled — invisible orphans that pollute the character's Voice list and carry a consent receipt for a clone the user believes never happened.
- **Fix sketch**: On the failure/cancel path, either roll back the voices already added this commit (delete their `.safetensors` + `mutate_meta` removal) or report the partial `created` set to the job (e.g. `status="partial"` with the committed voices) instead of dropping it.

## 3. GC expires jobs purely by creation age, deleting stems mid-review / mid-flight
- **Severity**: high
- **Lens**: bug-hunter
- **Category**: state-teardown race / data loss
- **File**: `service/ingest_api.py:186`
- **Scenario**: `_gc_once` removes any job where `now - created > _TTL` (30 min) with **no status check**, `shutil.rmtree`-ing its workdir and popping it. `created` is stamped once at scan start (line 308). A user who spends >30 min listening to speaker/stem previews before committing, or a slow cloud scan (40 segments × up to two 120 s Gemini calls / 4 workers can approach the TTL), has the workdir — containing every `stem_*.wav` — deleted out from under an active worker or a not-yet-committed review.
- **Root cause**: TTL is measured from creation and applied regardless of `status`; long human review or long-running work is indistinguishable from an abandoned job. rmtree also races the worker's unguarded ffmpeg/`concat_wavs` writes (same hazard as `cancel_job` at line 425).
- **Impact**: `POST /commit` returns 404 "job not found or expired", or an in-progress scan/commit fails with a confusing FileNotFound as its files vanish. All analysis work + built stems are lost with no way to resume.
- **Fix sketch**: Skip GC for jobs in active states (`running`/`committing`/`awaiting_speaker`), and/or refresh a `last_touched` timestamp on each poll/preview so the TTL measures idleness, not total age.

## 4. Empty-plan commit reports success while cloning nothing
- **Severity**: medium
- **Lens**: bug-hunter
- **Category**: silent-failure / success-theater
- **File**: `service/ingest.py:509`
- **Scenario**: A direct API caller (or the UI passing an emotion whose stem fell below `MIN_STEM_SECONDS`) posts `emotions[]` where every stem is ineligible or missing on disk. The loop skips them all, `plan` is empty, `commit()` returns `[]` at line 509-512. `_do_commit` then sets `status="committed"` with `committed=[]` and 100% progress (ingest_api.py:272-278) — no error raised.
- **Root cause**: "no eligible stems" is treated as a benign success rather than a caller error; the skip reasons are logged locally but never surfaced to the job/HTTP response.
- **Impact**: The user attests ownership, clicks commit, sees a success state, and gets zero voices with no explanation — indistinguishable from a real clone. The documented HTTP contract silently no-ops.
- **Fix sketch**: When `plan` is empty (all skipped/absent), fail the commit (e.g. HTTP 422 / `status="error"`) with the skipped-emotion reasons, or return the `skipped[]` list in the job so the UI can explain why nothing was cloned.

## 5. Duplicated per-speaker stats + preview-clip block across the two analyze paths
- **Severity**: medium
- **Lens**: code-refactor
- **Category**: duplication
- **File**: `service/ingest.py:337`
- **Scenario**: The "write segments.json → compute seconds → pick longest utterance → `to_wav` a capped preview → append a speaker record" block in `analyze` (lines 337-348) is a near-verbatim copy of the single-speaker version in `sovereign_analyze` (lines 264-273): same `secs`/`longest`/`to_wav(clean, pv, start, min(end, start+6))`/append shape. (Separately, `pick_speaker` at line 297 is dead — defined but called nowhere in the repo, and it re-implements the speaker-selection that `scan`/`analyze` do inline.)
- **Root cause**: Two ingest modes grew the same speaker-preview logic independently instead of sharing a helper; the divergence risks the preview clip length/naming drifting between modes.
- **Impact**: Any change to preview length, naming (`speaker_{sid}.wav`), or the speaker-record schema must be made in two places; already a latent inconsistency source.
- **Fix sketch**: Extract `_speaker_record(clean, segs_for_speaker, sid, sample_text) -> dict` (writes the preview, returns the record) and call it from both `analyze` and `sovereign_analyze`; delete the dead `pick_speaker`.
