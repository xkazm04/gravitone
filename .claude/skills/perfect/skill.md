---
name: perfect
description: Session-after-session product perfection loop for Gravitone. The strongest available model (Fable) directs — it walks context-map.json context-by-context, proposes 5 challenged, high-value directions per context (features, design elevations, significant optimizations), gates them with the user until 10 are accepted, then orchestrates one Opus builder subagent per context in isolated worktrees while making every review/merge decision itself. All state lives in a vault folder so any future session resumes the loop exactly where the last one stopped. Invoke with `/perfect [init|propose|build|status|reflect] [context-name]`.
---

# Perfect — the direction-and-delivery loop

> One model is best at *judgment* — seeing what would make a product excellent, challenging its own ideas, reviewing diffs ruthlessly. Cheaper strong models are great at *execution* inside a well-scoped brief. `/perfect` wires the two together in a permanent loop: **Fable directs, Opus builds, the vault remembers.** Each session moves the product measurably closer to the best UX, architecture, and feature quality it can have; no session ever starts from zero.

## The product

Gravitone — an Arm-native, CPU-only expressive TTS platform:
- **Service** (`gravitone/service/*`, Python 3 + FastAPI + pocket-tts): ElevenLabs-compatible synthesis API, voice cloning/ingest pipeline, emotion engine, bounded concurrency pool with metrics, API-key auth.
- **Web Studio** (`gravitone/web/*`, Next.js 15 + React 19 + TS + Tailwind 4): playground, voice creation lab, character/voice management, key management, Firebase auth. NOTE: context-map paths written as `gravitone-web/...` map to `gravitone/web/...` on disk.
- **Git root is `gravitone/`** (branch `main`), not the `arm/` folder above it. All git commands run from `gravitone/`.

## Roles — Director and Builders

- **Director (the main session — Fable, or the strongest model available).** Owns everything that is judgment: opportunity-scoring contexts, drafting directions, adversarially challenging them before the user ever sees them, running the acceptance gate, writing builder briefs, answering builders' product questions mid-flight, reviewing every diff, deciding merge/redo/drop, running the repo gates, committing, and writing the vault. The Director **never delegates a decision** to a builder and never rubber-stamps a builder's diff.
- **Builders (Opus subagents, `model: "opus"`, one per context).** Each receives a tight brief (direction specs + acceptance criteria + the context's `filePaths` scope + repo-convention digest) and implements in its **own worktree**. Builders return a structured report; when they hit a genuine product ambiguity they **return the question instead of guessing** — the Director answers via `SendMessage` and the builder continues.
- **Scouts (Explore subagents, cheap).** Produce the per-context current-state brief the Director synthesizes directions from. Never used for judgment.

## The vault — durable loop state

Resolve the vault root (first hit wins), then use `$VAULT/Perfect/`:

```bash
for v in "C:/Users/mkdol/Documents/Obsidian/gravitone" "C:/Users/mkdol/dolla/arm/.perfect"; do
  [ -d "$v" ] && VAULT="$v" && break
done
# Default: <arm root>/.perfect/ — an Obsidian-openable folder; create it on init if neither exists.
```

```
Perfect/
  Perfect.md               # HOME / Map-of-Content — always reflects current truth:
                           #   mission, the scored context QUEUE with the CURSOR,
                           #   the ACCEPTED POOL (n/10), shipped ledger headline, link to last session
  config.md                # per-repo overlay: gates to run, worktree recipe, wave size,
                           #   direction sizing rules, cooldown, ## User taste, + ## Skill improvement log
  contexts/<name>.md       # one per context-map context (long-lived, updated in place)
  directions/<slug>.md     # one per direction (long-lived; the atom of the whole loop)
  sessions/<YYYY-MM-DD[-n]>.md  # immutable run records, each ends with a `next:` pointer
```

**Context note** (`contexts/<name>.md`):
```markdown
---
name: <context-map name>        type: perfect/context
group: <group>                  category: ui|api|lib|data|config|test
opportunity: <0-10>             # value reach × headroom × strategic fit (Director's judgment)
last_proposed: <YYYY-MM-DD|never>   cooldown_until: <date|—>
directions: ["[[<slug>]]", …]
---
## Current state   (scout brief digest + file:line evidence — refreshed each proposal pass)
## Direction history   (proposed / accepted / REJECTED-and-why — rejections are memory too)
## Shipped   (direction → commit SHA → observed effect)
```

**Direction note** (`directions/<slug>.md`):
```markdown
---
slug: <kebab, stable>           type: perfect/direction
context: "[[<context-name>]]"   lens: feature|ux|optimization|robustness|wildcard
status: proposed | accepted | building | shipped | failed | dropped | rejected
size: S|M|L                     # must fit ONE builder session (≲15 files, no cross-context schema break)
proposed: <date>  accepted: <date|—>  shipped: <date|—>  commit: <sha|—>
---
## What & why   (the user value, one paragraph, no fluff)
## Evidence   (file:line of the gap/opportunity in today's code)
## Acceptance criteria   (3-6 checkable bullets — the builder's contract AND the review checklist)
## Risks / non-goals
## Build record   (builder report digest, review verdict, gate results — filled during build)
```

**Session note**: phases run, contexts covered, accept/reject tallies, build outcomes with SHAs, deltas, and **`next: <the exact resumption instruction for the following session>`**.

Vault hygiene: slugs are stable; **update notes, never duplicate**. Subagents may fail to write files in some harnesses — after any parallel phase the Director MUST `ls` the target dir and **backfill missing notes from the agents' returned content** before trusting "written".

## The loop — a vault-driven state machine

Every invocation starts the same way; the vault decides which phase runs.

### Phase 0 — Recall & register
1. Read `Perfect.md` (+ last session's `next:` pointer). If missing → run **init** (below).
2. Read `context-map.json` (at `arm/` root); diff against `contexts/*` — new contexts get notes + a queue slot, removed ones get archived (`status: retired` in frontmatter).
3. Scan session memory (MEMORY.md) for signals that veto directions (removed features, "don't re-suggest" notes).
4. Announce the resumption point in one sentence, then go where the state machine points: pool < 10 → **Propose**; pool ≥ 10 (or user said `build`) → **Build**.

### Init (first run only)
1. Scaffold the vault tree + `config.md`. Record the repo gates:
   - **Service (Python)**: `python -m compileall -q gravitone/service` (syntax gate — pocket-tts/torch are not installed on this dev box, so imports and runtime tests can't run locally; builders must say what they COULD NOT verify). If a `tests/` dir with pytest exists by then, run it.
   - **Web (TS)**: `npx tsc --noEmit` from `gravitone/web/`, and `npm run lint` when it's configured.
   - Wave size = 3; cooldown = 2 rounds; ≤ 3 directions per builder brief.
2. Score every context 0-10 for **opportunity** = user-facing reach × headroom (distance from "perfect", judged from context-map metadata, `gravitone/docs/*`, README, and memory) × strategic fit (this is a hackathon-facing Arm TTS product — demo impact and API polish score high). Write the ranked **queue** into `Perfect.md` with the cursor at the top. Don't deep-read code yet — scoring is refined per-context at proposal time.
3. Write session note; proceed straight into Propose.

### Phase P — Propose (context by context, until the pool holds 10)
Loop while `pool < 10` and the user hasn't said stop:

1. **Cursor** = highest-opportunity context not on cooldown. **Prefetch**: before presenting context *k*, launch the scout for context *k+1* in the background.
2. **Scout** (Explore, "very thorough", read-only): given the context's `filePaths` (translate `gravitone-web/` → `gravitone/web/`) and `apiRoutes` → return a current-state brief: what exists, what's rough, dead ends, UX seams, perf smells, with `file:line` evidence.
3. **Draft 5 directions** — one per lens by default: **feature** (new user value), **ux** (design/flow elevation), **optimization** (perf/cost/significant simplification), **robustness** (failure modes, observability, architecture), **wildcard** (the non-obvious idea a great PM would pitch). Each sized to ONE builder session; a bigger vision ships as its phase-1 slice.
   **Weight the slate by `config.md → ## User taste`** — the lens spread is a starting point, not a quota. Default depth is the *engine*, not the chrome: for any context with backend/algorithmic substance (synthesis pipeline, ingest, concurrency engine), most directions should be architecture-level (data model, algorithms, latency/quality trade-offs, streaming, cost structure); UI surfacing appears at most once-twice unless the user steers otherwise. Scout prompts must match this depth (trace the full pipeline, not just the components).
4. **Challenge before presenting** (the Director argues against itself; a direction that fails any check is replaced, not presented):
   - Does it already exist in code? (scout evidence, not assumption)
   - Was it already proposed/rejected/shipped? (check `contexts/<name>.md` history + memory)
   - Does it conflict with a "removed, don't re-suggest" memory?
   - Is the value claim concrete — can I name the user moment it improves?
   - Can one Opus session genuinely ship it behind the acceptance criteria? (Mind the local constraint: no pocket-tts runtime on this box — directions requiring live synthesis verification need a mocked or deferred verification plan.)
5. **Present** the 5 in chat — numbered, each: title · lens · size · one-paragraph why · evidence · acceptance criteria. Then gate with **AskUserQuestion (multiSelect)** — the tool caps options at 4 per question, so use TWO questions in one call: Q1 = directions 1–3, Q2 = directions 4–5 (labels = `N · short title`, description = one-line value claim + size). The user can annotate via "Other" (e.g. `edit 2: …`, `stop`); selecting nothing in both = none accepted.
6. Record outcomes in the vault (rejected ones too, with the user's implied reason — rejections steer future proposals). Accepted → `directions/<slug>.md` with `status: accepted`, pool counter++, context gets `cooldown_until`. Update `Perfect.md` after every context, not at session end — a killed session must lose nothing.
7. **A `none` gate that carries a steer** (the user says what they wanted instead) is a re-scout order, not a rejection of the context: promote the steer to `config.md → ## User taste` if it generalizes, re-scout at the steered depth/angle, and re-propose the SAME context once before advancing the cursor. Never re-present any rejected direction.

### Phase B — Build (one Opus builder per context, Fable decides everything)
1. **Wave plan**: group the pool's accepted directions by context → one builder per context, ≤ `config.wave_size` (default 3) concurrent, and **≤ 3 directions per builder brief** (a 4-direction brief exceeds one agent-session budget — split a bigger context into two sequential builders). Present the wave plan in one screen; on user go (or when invoked as `/perfect build`), execute.
2. **Worktree per builder** — prepared by the Director, NOT via Agent-tool isolation (those worktrees lack `node_modules`). Run from `gravitone/`:
   ```bash
   git -C gravitone worktree add .worktrees/perfect-<ctx> -b worktree-perfect-<ctx>
   # Web builders need node_modules — junction, NOT copy (from arm root):
   cmd //c mklink //J "gravitone\\.worktrees\\perfect-<ctx>\\web\\node_modules" "..\\..\\..\\web\\node_modules"
   ```
   (`.worktrees/` must be in `.gitignore` — add it on first build if missing.)
3. **Brief** each builder (see template below); launch with `model: "opus"`, `subagent_type: "general-purpose"`, all briefs in one message so they run concurrently.
4. **Mid-flight decisions**: a builder returning `DECISION NEEDED: …` gets an answer from the Director via `SendMessage` — product calls, trade-offs, and scope cuts are Fable's alone. A builder that stops without its final report gets one `SendMessage` nudge.
   **Builder-death recovery (session limits WILL kill builders):** the instant a builder dies, `git add -A && git commit --no-verify` a `wip(…)` snapshot **inside its worktree** (isolated tree — add-all is safe there; never-lose-work beats commit hygiene). Then the Director either finishes the work inline (review the WIP diff, complete gaps, split into per-direction commits along file boundaries — same-file hunks may share a commit if the message says so) or re-briefs a fresh builder after the limit resets with "continue from the WIP commit".
5. **Review — the Director earns its title here.** Per builder branch: `git diff main...worktree-perfect-<ctx>` and review against each direction's acceptance criteria, repo conventions (shared UI primitives in `web/components/ui/`, design tokens in `tokens.ts`, service patterns in `engine.py`/`app.py`), and taste. Verdict per direction: **merge** / **redo with notes** (SendMessage, builder fixes in place) / **drop** (`status: failed`, reason recorded). Never merge on "gates pass" alone — read the diff.
   **Docs-vs-code check:** when a diff documents a behavior (API contract text, formula, doc comment), grep for the code that implements it before merging — a contract describing behavior the code doesn't have is worse than nothing.
6. **Merge serially**: per direction, `git merge --squash` (or cherry-pick) → ONE atomic commit on `main`, message `feat(<context>): <direction title>` + `Co-Authored-By` footer. Stage per-file, verify `git diff --cached --stat` matches intent (foreign pre-staged files → `git restore --staged` them). Run the config gates on `main` after each merge; a red gate is fixed inline before the next merge.
7. **Doc-sync in the same turn**: user-visible changes update `gravitone/README.md` / `gravitone/docs/*` where mapped.
8. **Cleanup**: per worktree — `cmd //c rmdir` the node_modules **junction FIRST** (if created), then `git worktree remove`, then delete the branch once its commits are on `main`.

### Phase W — Wrap (every session, even interrupted ones)
1. Update every touched vault note; write the session note with the **`next:` pointer** (e.g. `next: propose — cursor at tts-playground, pool 7/10` or `next: build wave 2 — voice-creation-studio remains`).
2. `Perfect.md` headline refreshed: pool count, queue cursor, shipped-total, last-session link.
3. Update `context-map.json` if any context's file ownership changed.
4. **Reflect on the skill itself**: 2-4 bullets in `config.md → ## Skill improvement log` — what dragged, what the user overrode, what the next round should change. This log is the input for the between-rounds skill revision.

## Direction quality bar (what earns a slot in the 5)

- **Value-first**: names the user moment it improves; "nice refactor" is not a direction unless it unlocks something.
- **Evidence-backed**: cites today's code (`file:line`), not vibes.
- **One-session-shippable**: ≲15 files, no cross-context schema breaks; else slice it.
- **Novel to the vault**: not shipped, not pending, not previously rejected (unless the world changed — say so).
- **Lens-diverse**: default one per lens; substituting a second entry in one lens requires the Director to say why.

## Builder brief template

```
You are an Opus builder for the `<context>` context of Gravitone — an Arm-native,
CPU-only expressive TTS platform (Python 3 + FastAPI service in service/;
Next.js 15 + React 19 + TS + Tailwind 4 studio in web/).
Work ONLY in this worktree: <abs path>. Git root is the worktree root; branch
worktree-perfect-<ctx>. Your scope is this context's files:
<filePaths from context-map.json, translated to on-disk paths>.
Touching other contexts requires DECISION NEEDED.

Implement these accepted directions, one atomic commit each, message `feat(<context>): <title>`:
<per direction: What & why · Acceptance criteria · Evidence file:line · Risks/non-goals>

COMMIT EACH DIRECTION THE MOMENT IT IS DONE AND VERIFIED — never batch commits
for the end of the session. An interrupted session must lose at most the
direction in progress, not everything.

Repo law (non-negotiable):
- Web UI: reuse components/ui/ primitives (Primitives.tsx, AppFrame.tsx, EmotionGlyph)
  and design tokens (components/ui/tokens.ts) — never hand-roll buttons/modals/spinners
  or invent new color values; match the existing studio aesthetic.
- Web API routes proxy the Python service — keep the backend URL server-side, never
  expose it or API keys to the client.
- Service code: follow existing patterns — FastAPI routers, config via config.py,
  metrics via engine.py counters; no new heavyweight dependencies without DECISION NEEDED.
- The pocket-tts runtime is NOT installed on this box: verify service changes with
  `python -m compileall -q service` and targeted logic tests that mock the model;
  verify web changes with `npx tsc --noEmit` (run in web/) and by driving the flow
  when a dev server is available. Report what you COULD NOT verify honestly.

If a product decision is ambiguous, STOP that direction and return `DECISION NEEDED: <question>`
with your recommendation — never guess. Final report format:
per direction → status (done|blocked|decision-needed), commits, files, verification evidence, open risks.
```

## Modes

- **`/perfect`** — resume the loop wherever the vault says it stopped (the default; covers init on first run).
- **`/perfect propose [context]`** — force a proposal pass (optionally jump the cursor to a named context).
- **`/perfect build`** — build now with the current pool even if < 10.
- **`/perfect status`** — read-only: queue, cursor, pool, in-flight builds, shipped ledger, last session. No agents.
- **`/perfect reflect`** — read `config.md → Skill improvement log` + last sessions and propose concrete edits to THIS skill file.

## Guardrails

- **Never stash, never `git add -A` on main** — per-file staging, staged-count check before every commit; other sessions' work is sacred. (Inside an isolated builder worktree, WIP add-all snapshots are the one exception.)
- **Cost discipline**: scouts are Explore-tier; Opus is spent only on accepted work; the Director never re-runs a scout whose brief is < 1 round old (it's in the context note).
- **Honest ledger**: a direction only reaches `shipped` with gates green AND the Director having read the diff; anything else is `failed` with a reason. No silent drops — every accepted direction's fate is recorded.
- **Interruptibility is a feature**: write the vault incrementally (after every context in P, after every merge in B) so a killed session resumes losslessly.
- **The user is the product owner**: the gate is theirs; the Director challenges but never overrides a rejection, and repeated rejections of a lens/context recalibrate the queue scores.
