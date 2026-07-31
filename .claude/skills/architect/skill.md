# Architect (Gravitone)

Heavy-hitter codebase scan for **structural patterns** — both weak ones to upgrade and strong ones to codify. Designed for rare, deliberate, high-effort sessions where the payoff is a class of bugs eliminated, a tech swap landed, or a convention promoted from "tribal knowledge" to enforced rule.

Adapted for the Gravitone repo (`arm/`) from the personas `/architect` skill. It complements `/perfect` — perfect ships per-context product improvements; architect hunts cross-cutting structural patterns.

## Repo facts (constants)

- **Repo layout**: workspace root `C:/Users/mkdol/dolla/arm`; git root is `arm/gravitone` (branch `main`). The `arm/` root itself is NOT a git repo.
- **Context map**: `arm/context-map.json` (Vibeman). Map paths starting `gravitone-web/...` = `gravitone/web/...` on disk.
- **Background docs**: `.claude/CLAUDE.md` (project rules), `.perfect/Perfect/config.md` (gates, worktree recipes, user taste — read it; taste transfers directly to triage calibration), `.perfect/Perfect/contexts/*.md` (per-context notes from perfect rounds).
- **Validation gates** (this machine cannot run the TTS runtime — pocket-tts/torch not installed):
  - Service: `python -m compileall -q service` **and `python -m unittest discover -s service/tests -t .`** (both from `gravitone/`; the suite uses unittest, not pytest, and `tests/fake_engine.py` shims torch/pocket-tts so it runs without the runtime).
  - Web: `npx tsc --noEmit` **and `npm test`** (vitest; both from `gravitone/web/`).
  - After the service suite, check `git status` — a test that writes the repo's real `voices/_meta.json` has slipped through twice.
  - There is no ESLint custom-rule setup and no cargo. Do not invent gates.
- **Vault root**: `C:/Users/mkdol/dolla/arm/.architect/` (plain folder, mirrors the `.perfect/` pattern; not inside the git repo).
  - `Architect/scans/` — one note per scan run (synthesis output)
  - `Architect/decisions/` — one ADR per accepted decision
  - `Architect/backlog.md` — durable queue of accepted decisions with status
  - `Architect/strong-patterns.md` — load-bearing patterns, kept for codification
  - `Architect/weak-patterns.md` — anti-patterns with reach data
  - `Architect/coverage.md` — themes/areas scanned, staleness
  - `Lessons/{date}-architect.md` — append-only self-reflection
- **Categories of finding** — `weak-pattern | strong-pattern | tech-swap | structural-bug-class | convention-gap`
- **Risk** 1–5 · **Effort** s/m/l/xl · **Payoff** 1–5 · **Reach** — always a concrete count ("{N} files / {M} call sites"), never vague.

## Interaction conventions

Every user prompt is a numbered menu (use AskUserQuestion where available); numeric input picks, Enter/default advances. Multi-finding triage uses `<id>=<verdict>` syntax; `all=<n>` accepted. Free text always accepted. When run non-interactively ("adopt and run"), take every default without asking, but Phase 6 triage ALWAYS goes to the user — never self-triage.

## Input

### Q1 — Mode
```
1. scan   — pick a theme, parallel-agent sweep   ← default
2. area   — bound the sweep to one area
3. resume — drain the backlog (skip scanning)
```
`resume` → jump to Phase 9.

### Q2a — Theme (scan mode)
Options: `error-handling`, `state-management`, `async-patterns`, `type-safety`, `data-modeling` (registry/JSON files/schemas), `api-contract` (service HTTP surface + web proxy routes), `testing-strategy`, `build-deploy`, free-form, or **pick for me** (default — use `Architect/coverage.md` staleness; on a cold vault, pick the theme with the biggest cross-cutting surface).

### Q2b — Area (area mode)
Areas map to the 4 groups in `context-map.json`:
```
1. tts-service-core        (gravitone/service — engine, voices, ingest, API)
2. performance-deployment  (Dockerfile, benchmarks, loadtest)
3. web-studio              (gravitone/web/app — auth, keys, voices, playground)
4. design-system-brand     (gravitone/web components/ui, glyphs, landing)
```
Resolve an area's file list from the group's contexts' `filePaths`.

---

## Phase 0: Vault bootstrap

If `arm/.architect/` or any file above is missing, create it. Seed files:

- `backlog.md`: `# Architect Backlog` with `## Pending` / `## Shipped` / `## Abandoned / Blocked` sections (status values: `proposed | approved | in-progress | shipped | abandoned | blocked`).
- `strong-patterns.md`, `weak-patterns.md`: title + empty `## Patterns` section.
- `coverage.md`: `## Themes` / `## Areas`, empty.
- `Lessons/` directory.

## Phase 1: Load context & memory

1. Read `arm/context-map.json` in full — this is the area taxonomy AND the file inventory.
2. Read `.perfect/Perfect/config.md` — gates, user taste (weight triage predictions by it), skill-improvement log.
3. Read `.claude/CLAUDE.md`.
4. Read vault: `strong-patterns.md`, `weak-patterns.md`, `backlog.md`, `coverage.md`, 3 most recent `Lessons/*-architect.md`. (Cold vault → all empty, skip.)
5. Freshness: if `context-map.json` `generatedAt` is >30 days old or `git -C gravitone log --oneline` shows heavy churn since, warn that reach counts may drift.
6. **Aging strong-patterns review**: entries with `Codification status: noted`, age >60 days, no `Last reviewed` within 30 days → mark **aging**, surface in Phase 5.

## Phase 2: Mode dispatch

scan → Phase 3 · area → Phase 3 (scope-bounded) · resume → Phase 9.

## Phase 3: Parallel scan

Spawn **3–5 `Explore` sub-agents in parallel**, one per angle. Default angles: usage map, type/contract, failure mode, performance surface, test coverage — pick the 3–5 that fit the theme. Each prompt is self-contained (agents have no context): include the theme, the in-scope file list (from context-map), 1 paragraph of background, and 3 specific questions. Report shape per agent:

```
- Files inspected (top 30 by relevance)
- Observed shapes (patterns, with file:line examples)
- Inconsistencies / Outliers (specific files)
- Smell strength: 1-5
- Cross-references
```

**Gravitone-specific angle notes**: the service is a single-process FastAPI app with an in-memory replica pool — concurrency/lifecycle angles are high-yield; the web app is Next.js 15 App Router with server-side proxy routes — the service↔proxy contract is a natural seam; `.perfect` direction notes often already name suspects (read the relevant `contexts/*.md` before writing prompts).

### Synthesize
Merge reports. Look for **convergence** (multiple angles → same module = high confidence), **conflict** (strength vs weakness = context-dependent, investigate), **surprise** (usually the most valuable finding). Quantify reach for every weakness. If all smell strengths are 1–2, say the area is healthy and offer another theme — never manufacture findings.

Output: 0–8 weak-pattern, 0–4 strong-pattern, 0–2 tech-swap (only when smell ≥4 AND a refactor can't get the payoff), 0–3 structural-bug-class. Cap at 8 total, ranked by `(reach × payoff) / (risk × effort)`.

## Phase 4: Cross-check memory

Dedupe every finding against `strong-patterns.md`, `weak-patterns.md`, `backlog.md`, and `.perfect/Perfect/directions/*` (perfect may already have a direction covering it — link it rather than duplicating; note whether that direction was accepted or rejected, and why per `config.md` taste). If a finding contradicts a recorded strong pattern, flag the conflict explicitly — that's the most interesting finding of the run.

## Phase 5: Present findings

Summary table (`#, type, severity, risk, effort, reach, title`), then per-finding detail:

- weak-pattern / structural-bug-class / tech-swap: reach, risk (+1-line what-could-break), effort (+breakdown), payoff (+what it unlocks), **current shape** (2–3 sentences, file:line examples), **proposed shape** (canonical example or sketch), **migration plan** (3–7 independently-shippable steps), **risks** (with mitigations), already-on-radar link.
- strong-pattern: reach, why it works, codification vehicle, risk-to-losing.

Then the Aging block from Phase 1d, if any.

## Phase 6: Triage (always user-gated)

```
Per finding: 1=execute now · 2=queue ←default · 3=drop · 4=rework
Reply "<finding>=<verdict>" space-separated, "all=<n>", or "ask".
```
- **execute now** → Phase 7. Recommend max one per session; warn if more.
- **queue** → Phase 8 (stub ADR + backlog).
- **drop** → record with reason in scan note + Lessons.
- **rework** → capture the user's reframe, re-present; no clear reframe → queue as `proposed (needs reshape)`.

Strong patterns: `1=codify → Phase 7B · 2=note ←default · 3=drop (do NOT persist)`.
Aging patterns: `1=codify ←default · 2=snooze (Last reviewed = today, +30d) · 3=drop (delete entry)`.

## Phase 7: Execute (one decision)

### 7a. Branch
Default: **commit on current branch** (`main`). Offer `architect/{slug}` branch only when the user wants clean separation; never push toward it. The ADR is the change's identity, not the branch.

### 7b. ADR first
Write `vault/Architect/decisions/{YYYY-MM-DD}-{slug}.md` before any code change: frontmatter (date, slug, status: in-progress, type, reach, risk, effort, payoff, branch, related_scan), then Context / Decision / Consequences (positive, negative, mitigations) / Rollout (numbered atomic commits, each with its validation gate) / Acceptance criteria / Regression checklist.

### 7c. Pre-flight
**Never require a clean tree.** `git -C gravitone status --short`; classify every dirty path: in-flight-by-someone-else (leave strictly alone) / pre-existing-in-touch-zone (surface to user; default = commit on top) / yours. Capture validation baselines (compileall, tsc, pytest if runnable) into the ADR.
**Forbidden always**: `git stash`, `git reset --hard/--merge`, `git restore`, `git checkout --`, `git clean`, `git add -A/./-u`. Stage exact paths only.

### 7d. Atomic commits per rollout step
Apply → run that step's gate → compare to baseline (delta, not absolute) → fix regressions inline (no failing commits, no `--no-verify`, no `--amend`) → `git add <exact paths>` → commit `architect: <step title>` with ADR wikilink in body → record SHA in ADR.

### 7e–7f. Final sweep & status
Re-run all gates fully; walk the regression checklist. **This machine can't run the TTS runtime** — mark runtime-dependent checklist items explicitly `unverified (no local runtime)` and keep the ADR `in-progress: needs verification` rather than claiming shipped; only fully-verified ADRs get `status: shipped` + backlog moved to Shipped. Per the perfect log: when replacing a proven external invocation with an in-process reimplementation, require a runtime round-trip check or a fallback path.

### 7g. Web changes
Follow existing conventions in `components/ui/` (tokens.ts, Primitives.tsx) — no hardcoded style values where a token exists. For UI-affecting changes, `npm run dev` and eyeball if feasible; otherwise state explicitly that visual verification was NOT done.

## Phase 7B: Codify strong patterns

Vehicles (per pattern, ask):
```
1. docs-claude — append a convention section to .claude/CLAUDE.md (loads into every session)
2. test-guard  — pytest test under gravitone/service/tests/ that walks the tree and asserts the pattern (service-side invariants only)
3. context-map — enrich the relevant context's description in context-map.json
4. multiple
```
(No ESLint-custom-rule vehicle in this repo.) Keep docs sections 10–25 lines: name, why it works, canonical file:line example, anti-shape. Commit each vehicle atomically (`architect: codify <pattern> ...`). Update the `strong-patterns.md` entry (`Codification status`, `Codified: {date}`, ADR link) and write a mini-ADR (`{date}-codify-{slug}.md`, status shipped, with rollback note).

Snooze → bump `Last reviewed` / `Snoozed until`. Drop → delete the entry, log one line in Lessons. No tombstones.

## Phase 8: Backlog queued decisions

Stub ADR (`status: proposed`, sketchy rollout OK) → append to `backlog.md` `## Pending` (date, title, type, R/E/P, reach, ADR link, scan link, triage notes), sorted by `(reach × payoff) / (risk × effort)` desc → add/update `weak-patterns.md` entry (first/last seen, reach + trend, backlog link, examples). Strong patterns: write to `strong-patterns.md` only for `note`/`codify` verdicts, never `drop`.

## Phase 9: Resume mode

Print `backlog.md` Pending as a numbered table → user picks one (`open N` to read the ADR first; default = #1). **Refresh the ADR before executing**: re-verify file:line anchors, re-count reach, `git -C gravitone log` on touched files. Material drift → present the delta, ask proceed/reshape/abandon. Then Phase 7c–7f.

## Phase 10: Self-reflection

Ask (batched, skippable) why dropped findings were dropped. Write `vault/Lessons/{date}-architect.md`: run stats, triage outcome, drop reasons, which angles produced signal vs noise, calibration drift, 1 reusable insight. After 3+ repeated drop reasons across runs, propose a rule in a `Patterns/architect-preferences.md` file in the vault. If the run discovered a structural fact future runs need, also append it to the relevant `.perfect/Perfect/contexts/*.md` note or `.claude/CLAUDE.md`. Update `coverage.md` (theme/area, date, scan link, findings/actioned counts, yield density).

## Phase 11: Persist the scan

Write `vault/Architect/scans/{date}-{theme-or-area}.md`: frontmatter (mode, theme/area, agents spawned, finding counts, executed/queued/dropped/reworked ids, ADRs, commits, branch), per-finding verdict summary, strong patterns observed, cross-references.

## Phase 12: Final summary

Print mode, theme, agent count, finding counts, triage outcome (with ADR links, commit SHAs), strong-pattern outcomes, files updated, and a `Next?` menu: `1. /architect resume ({Q} pending) · 2. /architect scan · 3. /perfect · 4. done`.

## Notes on use

- Once a week is plenty; alternate scan (fill queue) and resume (drain it). Backlog ≥20 → next run should be resume.
- Coexist with uncommitted work — inspect, classify, commit only your own exact paths.
- Tech swaps: never propose reach ≥100 files unless smell strength is 5.
- Triage calibration from `/perfect` taste: correctness, honesty, efficiency, consolidation win; new UX surfaces usually lose unless demo-headline material; billing/metrics-dashboard flavored proposals have been rejected.
