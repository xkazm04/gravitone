# Perfect config — Gravitone

- **Repo**: git root `C:/Users/mkdol/dolla/arm/gravitone` (branch `main`); context-map at `C:/Users/mkdol/dolla/arm/context-map.json`. Map paths `gravitone-web/...` = `gravitone/web/...` on disk.
- **Gates**:
  - Service: `python -m compileall -q service` (pocket-tts/torch NOT installed locally — imports/runtime untestable here; builders mock and report unverified parts).
  - Web: `npx tsc --noEmit` in `web/`.
- **Wave size**: 3 concurrent builders; ≤ 3 directions per brief.
- **Cooldown**: 2 rounds per context after a proposal pass.
- **Worktrees**: `git worktree add .worktrees/perfect-<ctx> -b worktree-perfect-<ctx>` from `gravitone/`; junction `web/node_modules` into web-touching worktrees; `.worktrees/` gitignored.
- **Sizing**: one builder session ≈ ≲15 files, no cross-context schema breaks.

## User taste

- **Cost / usage / telemetry surfaces are consistently rejected — four for four.** `per-key-usage-metering` ❌, `one-truth-metrics` ❌, `priority-lanes` ❌ (all round 1), `scan-cost-visible` ❌ (round 6, the ingest `Spend` ledger as UI, even framed as making sovereign's zero-cost privacy claim concrete). Do NOT propose "show the user what it consumed" again without a specific new reason. Making an EXISTING number true is fine and gets accepted (`honest-benchmark-accounting`, `honest-self-reported-numbers`); adding a consumption readout is not.

- Round-2 pattern (playground + studio gates): **correctness, honesty, efficiency, and consolidation directions get accepted; new UX surfaces get rejected** (rejected: streamed playback, follow-along highlight, on-page recorder, clip preflight; accepted: honest status, durable takes, truthful feedback, state machine, efficiency). Exception: the multi-character performance composer (big demo feature) was accepted — flagship demo features can still win.
- Round 1: engine/robustness/compat directions all accepted; billing-flavored (usage metering) and metrics-dashboard-flavored (one-truth-metrics, priority lanes) rejected.
- Weight future slates toward: robustness, honest UX, perf, consolidation refactors that fix real bugs. At most one new-surface feature per slate, and only if it's demo-headline material.

## Skill improvement log

Post-round-11 owner-directed day (2026-08-07) — landing/Signal/pricing arcs, ~35 commits:
- **The prototype loop (variants behind a switcher → owner verdict → one-commit consolidation) is now proven at two scales** (8 spotlight bodies; the pricing band). Its highest-value step is the DIRECTOR-WRITTEN direction definitions: when every builder composes from the same two metaphor specs + a shared vocabulary file + exemplars, parallel builders produce one coherent hand.
- **Codify the winning language IMMEDIATELY (DESIGN.md) and make builders append an application log.** Two restrained-tier builders later cited the doc's own clauses to refuse candidates — the doc started enforcing itself within hours of existing.
- **Owner critiques are doctrine fuel**: "philosophy does not shrink-wrap / scale to the frame" and "paragraphs are useless on landing pages — visualize instead" both became DESIGN.md sections + tests (prose-cap) the same day. A critique that only fixes one surface is wasted.
- **Builders keep falsifying briefs, now in DESIGN territory too**: monthly-vs-cumulative crossover (month 6 ≠ 10), the false "below ~100k" claim, the fake-crossover refusal, the dataviz-validator failure of the ACCENT trio. The reasoning-in-brief rule pays in design work exactly as in engineering.
- **Ops rule learned twice, now written**: never `npm run build` in the main checkout while its dev server runs (.next corruption → blank page); builders build in worktrees, and any main-checkout build ends with .next wipe + dev restart.

Round 11 (2026-08-06/07) — 10/10 shipped same session (propose + build), 10 commits, zero redos; 1961 → 2131 service tests, 1084 → 1385 web tests:
- **A user steer overrides cooldown AND taste rules, but say so in the vault both times.** The owner named two contexts (one on cooldown) and asked for a UX redesign (a lens the taste log says gets rejected). Recording "steer overrides X" at propose time kept the history legible when both slates clean-swept.
- **The best redesigns are promotions.** The playground's "new UX concept" was 60% already in the repo behind a collapsed `<details>` (ScoreEditor/ScriptScore). Scouts should always ask "does the target UX already exist somewhere unmounted/demoted?" before the Director drafts a greenfield direction.
- **Constraint-first briefs keep beating mechanism-first briefs.** "No new decoder" survived contact with reality precisely because the scout established ffmpeg was already load-bearing — the constraint reduced to "no second copy", and yt-dlp-without-postprocessors satisfied it. Also: the D3 brief prescribed narrate as the mechanism and was falsified (structural constants, not inference); the direction survived because its VALUE (review-and-adjust suggestions) was stated separately from the mechanism.
- **8 builder falsifications across 4 builders, all correct — the reasoning-in-brief rule is now the skill's highest-leverage line.** New corollary: when a builder returns DECISION NEEDED with a recommendation, answering with reasoning + constraints (not a verdict alone) produced a better D3 than either original option.
- **Full-suite-per-wave, targeted-per-merge held at 2131 tests** (~4.5 min service, ~3 min web) — same rhythm as round 10, still catching zero late regressions. Keep it.
- Watch item: one unreproduced web flake (suspect ScoreText useLayoutEffect measurement under load). If it reappears: characterise first (frozen-clock/act patterns), never reshape the test blind.

Round 7 (2026-07-28) — 10/10 shipped, 12 commits; 469 → 540 service tests, 139 → 191 web tests:
- **Put the REASONING in the brief, not just the acceptance criteria — builders falsified it four times and were right every time.** L2: "there is NO wall-clock saving on a direct clone" (my speed claim was padding; the load-back verification was always the real value). P2: the stale rail-refs bug is not reachable — it reverted, got 0 failures, kept the change as *hardening* and said so instead of claiming a fix. P1: mp3 takes cannot be shared because `takes.py` rejects non-RIFF, so it disabled share with a stated reason. W2 (round 6, same pattern): the ingest 429 never sent `Retry-After`. A builder cannot correct a claim it was never told.
- **Run the teeth check on your OWN fixes too.** I reshaped a flaky test around `max_concurrent`, reasoning that concurrency was the timing-independent property — and the teeth check caught that it was vacuous, because `max_concurrent` counts what the FAKE executes (bounded by its own worker pool), not what was admitted. I nearly shipped a test that passed with the bug restored. The rule now applies to Director commits, not only builder ones.
- **A flake fix that treats the symptom will come back.** Round 6's fix for this same test added one spare slot; that covers ONE lagging permit release, not a whole wave's, and it still failed ~1 in 12. A later builder hit it and reported it. Characterise the mechanism, then size the fix to it.
- **Both gate suites, every merge.** A cross-builder break landed where all 191 web tests passed and `tsc` failed — a mocked fixture is type-checked but never executed. Tests-green is not gates-green.
- **A builder that stalls with a clean worktree needs no recovery, just a tighter brief.** L3's first attempt died during exploration having written nothing. The relaunch summarised the orientation inline ("reuse these four helpers; read these functions, not the module") and told it to start editing early. It then delivered the round's largest single direction with six anti-vacuous reverts.

Round 6 (2026-07-28) — 9/9 shipped, 12 commits, one gate rejection; 415 → 469 service tests, 90 → 139 web tests:
- **Check WIRING, not presence.** Round 5's review confirmed the cache counters existed; nothing called them, so `/metrics` reported zeros for a whole round and the pool aggregate summed structurally-zero fields. The generalising fix came from a builder, not me: a test that walks `AGG_KEYS` and fails on any field with no production writer. **When a direction says "X becomes visible in Y", the acceptance criterion must be a test that observes X through Y's real path** — not one that asserts the plumbing exists.
- **Ownership splits prevent conflicts and create gaps.** The round-5 split gave the counters to one builder and the call site to another, and neither owned the seam. When two builders' work meets at a call site, name the seam in BOTH briefs and say who closes it.
- **A red gate on a staged change is the moment the rule earns its keep.** The full suite came back red while a verified fix sat staged. Refusing to commit, then characterising the failure (passes alone, passes in the full suite, fails at file scope — one run in eight) turned "probably noise" into a real flake with a real fix and a teeth check. Never commit on top of an unread failure, and never accept "it passed the second time" as characterisation.
- **Builders overturned brief evidence twice more, both correct**: the ingest 429 never sent `Retry-After` (my evidence conflated "the proxy preserves it" with "it exists"), and "fail closed on unknown duration" is right for the backend but wrong verbatim for a browser that merely can't decode `.amr`. Both were flagged rather than silently worked around. Directions should keep stating their reasoning precisely so it can be falsified.
- **Cursor order is a heuristic, not a rule.** Speech Synthesis API outranked Voice Creation Studio 8.5 to 7.5, but the studio held a full round of shipped-and-undelivered value — and the scout found round 5's sovereign work dying at the API boundary, unseen by any user. Ask "where is the value we already paid for but haven't delivered?" before defaulting to the score.

Round 5 (2026-07-28) — 10/10 shipped, 12 commits, zero rejections; 274 → 415 service tests:
- **A re-scout is the highest-value scout there is.** Both round-4 regressions were invisible from inside round 4 and obvious to a scout told to read the new SHAs first. Formalize: when a round modifies a context that is NOT the one being proposed (round 4's Arm work landed in `engine.py`, owned by Concurrency Engine), that context's brief is STALE — re-scout it next round rather than trusting the old one, and hand the scout the intervening commits.
- **Verify the PREMISE, not just the arithmetic.** Round 4's lesson was "re-derive quantitative claims"; I did that and still shipped a regression, because I checked that the unit-count bound was true without asking whether the parallelism it enabled exists in the shipped config. The root cause was a test that configured the fake engine's pool size while leaving `SETTINGS.workers` at 1 — green, and proving nothing about production. **New rule: for any performance claim, name the deployed configuration it holds under, and make the test assert that configuration explicitly.**
- **Builders falsified two premises this round and were right both times** (the doubling-loop argument in round 4; single-pass `loudnorm` is byte-reproducible, disproving the direction's own stated rationale, with sha256 evidence and a measured 1.61× cost for the change I'd implied). Directions should keep stating their rationale, precisely so a builder can test and overturn it — a brief that only lists acceptance criteria gives them nothing to falsify.
- **Never infer commit order from a report's narrative order.** I-A reported direction 1 then 2 but committed 2 then 1; resolving a conflict with the "later" SHA silently reverted an entire direction. Caught only because the commit summary read "491 deletions" for additive work. **Check `git log` on the branch before picking, and diff main against the branch tip after any conflict resolution, BEFORE running gates.**
- **Sequencing same-file builders keeps paying.** Three ingest builders ran in series on one file with zero conflicts, each briefed with the previous one's SHAs to read first. Wave 1's three-way parallel split by file region produced exactly one trivial both-append conflict.

Round 4 (2026-07-28) — 10/10 shipped, 12 commits, zero rejections at the gate:
- **The Director must TEST the claims in a builder's report, not just read them.** The only defect of the round (a false bound in `_chunk_text`) was invisible in a beautifully-argued docstring and a green 247-test suite; it took 20 lines of python reproducing the function to find that ordinary prose (~180-char sentences) produced 44 units against a 33-slot window. Generalize the round-1 docs-vs-code rule: **when a comment or commit message asserts a QUANTITATIVE property (a bound, a ratio, a complexity), re-derive it before merging.** Both defects this round were of that shape — the other was a README claiming a default that was off.
- **Builders pushed back correctly TWICE and were right both times** (the doubling loop over the Director's derived-budget formula; `useClientReady` over the briefed `useMounted`, which would have broken SSR). Both pushbacks came with a reason, not a preference. Keep briefing directions as OUTCOMES with named risks rather than prescribing implementations — and when a builder refuses a specific instruction with an argument, evaluate the argument rather than defending the brief.
- **Sequencing the two same-file builders paid for itself.** W2 found that `takeStore` swallowed every failure, which silently made W1's just-shipped "could not be saved" banners unreachable. Parallel builders on one 857-line file would have merged that hole instead of closing it. Rule: **when two contexts' directions concentrate in ONE file, sequence them and hand the first builder's known follow-ups to the second in its brief** (the 250ms re-render note went from W1's report straight into W2's direction 1, and came back fixed).
- **Pre-authorizing file ownership per builder eliminated conflicts in the service lane.** S1 was told "do not touch engine.py", S2 "do not touch app.py's synthesis routes", and S2 put its new route on the already-mounted keys router rather than editing app.py. Two builders, same package, one trivial both-append conflict all round. Keep doing this explicitly in briefs.
- **Banking the prefetched scout worked again** (round 3's lesson): the playground brief was scouted before its turn and used the same session at zero re-scout cost. It also caught something a shallower pass would not — that the "free playground" copy sits behind an auth gate.
- **What to change next round**: the queue tail is now genuinely thin (≤6.5 outside cooldown), and two of the three top contexts had `engine.py` modified under them this round. Round 5 should re-scout Concurrency Engine against the Arm-tuning changes rather than trusting its round-1 brief. Also consider a standing rule that any direction shipping UNMEASURABLE work (no runtime available) must name the one experiment that would settle it — `arm-inference-pass` and the `max_tokens` finding both did this well and are now actionable one-liners in `Perfect.md`.

Round 1 (2026-07-13):
- **Worktrees don't carry untracked files.** The repo `.env` (sets TTS_API_KEY) exists only in the main checkout, so builder test suites passed in worktrees and failed on main. Fixed by pinning env in tests/__init__.py, but the skill should say: after every merge, re-run the suite ON MAIN before trusting it; consider copying `.env` into worktrees at creation.
- **mklink /J with relative targets resolves against CWD, not the link** — the skill's junction recipe broke on first use; use absolute paths (skill recipe updated mentally; update skill file next revision).
- **Unverifiable-runtime code needs a runtime safety net, not just tests.** export_stems replaced a proven CLI with serializer probing no local test can validate; Director added load-back verification + CLI fallback. Rule of thumb: when a builder swaps a proven external invocation for an in-process reimplementation, require a runtime round-trip check or a fallback to the proven path.
- **What went well**: pipelined waves (review/merge A1 while B1 still building) kept wall-clock tight; ≤3 directions per brief held (no builder deaths in 5 builders); review caught 2 real bugs (test-env dependency, cancel dead-end) and 1 latent integration gap (stream abandonment) that green gates missed.

Round 2 (2026-07-13):
- **Verify scout "unused/orphan" claims with a repo-wide grep before they enter acceptance criteria** — the /api/tts deletion instruction was wrong; the builder's own grep saved it (DECISION NEEDED worked as designed).
- **Efficiency directions can create staleness regressions** — "fetch once" broke the extend dropdown; when a slate includes cache/fetch-reduction work, review must trace every consumer of the now-stale data.
- **Cross-context coordination fixes are Director work** — two rounds in a row a builder correctly flagged an out-of-scope integration gap (ingest lock bypass; wave-1 stream abandonment) and the Director shipped the small fix inline. Keep briefs strict-scope + report, it works.
- **Banking a scout when the pool fills** (Character-Mgmt) avoids a wasted re-scout next round — do this deliberately: always let a prefetched scout finish and bank its brief.

Round 3 (2026-07-13):
- **Pipelined per-context waves beat synchronized waves** — merging each wave-1 builder and immediately launching its wave-2 successor (A1→A2, C1→C2, B1→B2) kept three lanes moving with zero idle; formalize this as the default (drop the "wave barrier" framing).
- **Builders now handle soft decisions well in-report** (C1's additive endpoint, B1's reuse-port recommendation) — the strict-scope + DECISION-NEEDED protocol has matured; keep pre-authorizing narrow, read-only backend additions in web briefs.
- **The banked-scout flow worked**: CVM went scout→slate with zero re-scout cost a round later. Also worked: truth drift runs both directions — scouts comparing copy/docs against shipped code found the README claiming a shipped feature didn't exist.
- **Queue tail is thin**: remaining non-cooldown contexts score ≤5. Next session should rescore round-1 contexts (3 rounds of changes have shifted their headroom) before walking the tail.

Round 8 (2026-07-29):
- **A whole test file failing is a PARSE signal until proven otherwise.** My
  hand-union of two builders' `CharacterTable.test.tsx` left it unparseable;
  vitest reported esbuild's transform error as *two failing tests*, wearing the
  names it could see. I chased a component interaction for an hour that never
  existed. New rule: when N tests in ONE file fail and none elsewhere, run the
  transform/parse check FIRST — before isolation runs, before instrumentation.
  Corollary: `tsc --noEmit` going clean does NOT prove the file parses under
  the test transform; they are different claims and I conflated them.
- **Stop hand-splicing merged files.** The round-4/5 "read every seam" rule is
  not enough for a whole-file union. Take each side's regions **verbatim from
  their own commits** (`git show <sha>:<path>`), assemble, then verify the
  result parses before running or trusting any gate.
- **Handing a builder my own suspected error, explicitly, is cheap and works.**
  V2 found the fault in one pass after I wrote "my merge may itself be the
  fault and I would rather know". It also refused to weaken the assertions, as
  briefed. Make that sentence standard in any redo brief where the Director
  touched the builder's files.
- **First-tests-for-a-surface directions punch above their weight.** The keys
  surface's first tests found a falsy-default bug affecting SEVEN unrelated
  surfaces that every existing test missed — including the hook's own test,
  which asserted `not.toBeNull()` against a `""` that satisfies it. Keep
  proposing "this surface has no tests" as a robustness lens; and treat
  *implementation-pinning assertions* as a review smell in their own right.
- **Sequencing the last builder after the others merged cost nothing and saved
  a merge.** V3 forked from a main already carrying the other four. Prefer this
  over a fourth concurrent lane when a context's directions touch shared files.
- **What to change next round**: both round-8 contexts are on cooldown, so
  round 9 gets a genuinely fresh cursor. Carry K2's follow-up (an
  unauthenticated probe route so the keys page can say "open" instead of
  "can't tell") in as a pre-banked candidate — it is the one place the studio
  still cannot answer a question the operator actually has.
- **The junction step needs to be a checked command, not habit.** I created a
  builder worktree's `web/node_modules` junction with a RELATIVE `mklink /J`
  target — which resolves against CWD, the exact gotcha recorded since round 1
  — so it pointed at a non-existent path and nothing could run until the
  builder repaired it. Use an absolute target AND verify the link resolves
  (`ls <worktree>/web/node_modules/.bin` or equivalent) before briefing.

Round 9 (2026-08-04) — 10/10 shipped in ONE session (propose + build), 10 commits, zero redos; 1605 → 1893 service tests, 832 → 995 web tests:
- **The environment note in this file was stale for a full campaign.** "compileall only, no runtime" was false — Python 3.14 runs the whole service suite locally. Verify the gate assumptions EVERY round-start (one 10-second pytest probe) instead of trusting config.md; a stale gate note under-verifies every merge.
- **Worktrees moved OUTSIDE the repo** (C:/Users/mkdol/dolla/wt/) after the root restructure — a worktree inside the parent tree floods git status. Junction recipe (PowerShell New-Item -ItemType Junction, absolute target, Test-Path .bin/tsc) worked first time in all 3 web worktrees.
- **Named seams beat file locks again, at scale**: two pairs of builders shared takes.py and app.py concurrently; every cherry-pick auto-merged clean because each brief named what the OTHER builder owned. This is now the default for any same-file concurrency.
- **Briefs that state reasoning keep getting corrected — 5 falsifications this round, all correct** (promise double-count, XFF spoof hole, stats GIL nuance, audio-src viability, metatag grammar gap). The rule compounds: briefs must carry the argument, not just the criteria.
- **Propose-and-build in one session works** when scouts are strong and the user clean-sweeps the gate; the pipelined review (merge E1 while P1 still building; fork E3/P2 from post-merge main) kept zero idle time. Sequenced forks again produced zero conflicts.

Round 10 (2026-08-04, same day as round 9) — 10/10 shipped, 11 commits; 1893 → 1961 service tests, 995 → 1084 web tests:
- **The "value paid for, never delivered" heuristic found its biggest prize yet**: an ENTIRE moonshot (voice-corpus) shipped server-complete and web-absent — dead code for a month. Scouts must always diff service routes against web proxies against UI calls; that three-way diff is where whole features hide.
- **Sequenced waves are now the proven default for same-file work**: I-A→I-B and S-A→S-B each forked from post-merge main; zero conflicts across 4 builders and 10 direction commits, second round running.
- **Briefs that prescribe a mechanism get corrected; briefs that state the constraint get satisfied.** S-B overturned the prescribed POLLING_PHASES fix for two reasons the Director missed and shipped a better shape (watch mode). Write the constraint ("expiry must be detected without wiping edits"), not the patch.
- **Two rounds in one day is sustainable when gates are fast to read**: full service suite ~4-9 min, full web ~3 min. The wrap-gate rhythm (targeted per merge, full per wave) caught zero regressions late — evidence the per-merge targeted gates are selecting well.
- Round-11 watch item: the reperform flake fix (348f800) should hold — if any timing flake appears in ratelimit-adjacent suites, characterise before touching (the frozen-clock pattern generalises).
