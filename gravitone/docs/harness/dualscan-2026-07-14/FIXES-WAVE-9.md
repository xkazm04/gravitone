# Dual-scan Fix Wave 9 — Dead code & duplication

> 5 commits, 11 findings closed (9 medium, 2 low) + 1 partial.
> Gates: web `tsc` 0 / `next build` PASS; service suite **163 → 164, all green**.
> **12 files deleted, −188 lines** of dead code; four duplicated mechanics consolidated.
>
> Every "dead" claim was re-verified with a repo-wide importer/caller grep before deleting — the scan's word was never taken as sufficient. That caught two places where following the finding's own fix sketch would have broken something.

## Commits

| # | Commit | Findings | File(s) |
|---|---|---|---|
| 1 | `5a8f3d4` | dead traced-glyph subsystem (+2 moot), PrototypeTabs, dead re-export, unused import, dead `pick_speaker` | 12 deleted, 4 edited |
| 2 | `cb49194` | find-character-by-id ×8 | `voices.py`, `packs.py` |
| 3 | `53861a9` | speak/performance clone; ingest preview clone; take-loading ×3 | `lib/backend.ts`, new `lib/takes.ts`, 6 routes/pages |
| 4 | `—` | *(folded into 3)* | |
| 5 | `f0a2e9c` | AGG_KEYS duplication — **kept deliberately**, drift now caught by a test | `replicas.py`, `test_replicas.py` |

## Two catches where the finding's fix sketch was wrong

**1. Deleting the glyph barrel would have broken the live art path.** The finding said the traced-glyph subsystem (10 files) was dead — true for the *renderer and data*. But `lib/glyphs/index.ts` also defines the `Glyph`/`GlyphPath` types, and the **live** `generate.ts` (procedural sigils for custom emotions, reached via `EmotionArt`) imports them from there. Deleting the barrel wholesale, as implied, breaks the surviving path. Kept `index.ts` reduced to the shared types; deleted the 8 baked data files + `EmotionGlyph.tsx`. Verified first that all 8 PNGs exist in `public/emotions/` and that `EmotionArt` renders PNG-or-sigil and never touches `GLYPHS`.

**2. `replicas.AGG_KEYS` must stay hand-copied.** The finding proposed exporting the counter tuple from `engine.Metrics` and importing it. **Rejected:** `replicas.py` is the supervisor — stdlib-only imports, spawns the replica processes, serves the aggregated `/metrics`. `engine.py` imports torch at module scope, so that import would drag torch + scipy into the launcher process (heavy; fatal where the parent can't import them). The duplication is load-bearing. Instead: documented *why*, and moved the drift risk into `test_replicas.AggKeysContractTests`, which can import both sides — it fails if engine emits an int field `AGG_KEYS` neither sums nor classifies as a gauge, or if `AGG_KEYS` sums a key engine no longer emits. Mutation-verified both directions.

Writing that test immediately caught a wrong assumption of mine: `window_size` is an int in the snapshot but a **gauge**, not an additive counter — now explicitly classified rather than summed.

## What was removed / consolidated

**Dead code (all grep-verified):**
- **Traced-glyph subsystem** — `EmotionGlyph.tsx` had no importers; the 8 `*_GLYPH` data files fed only its `GLYPHS` map. The live path is baked PNGs + procedural sigil; the traced SVG variant was never mounted. Per this repo's own prototype convention ("when a winner is chosen, delete the losing variant"), it's gone. This **moots two sibling findings** — the `confused` glyph's unstripped background rect and the reveal renderer duplicated across the two glyph components — both lived only in the deleted code.
- **`PrototypeTabs.tsx`** — the A/B harness, no importers (only a prose mention in a comment; the SKILL.md reference the finding cited doesn't exist).
- **`shared.tsx`** re-exported `emotionMeta` that nobody imported from it; **`CharacterTable`** imported `Button` but renders native buttons; **`ingest.pick_speaker`** had zero callers.

**Consolidations:**
- **`find_character` / `get_character_or_404`** replace 8 hand-rolled roster scans whose not-found handling had already drifted (some 404, one `{}`, one 500).
- **`proxyWavPost`** — `/api/performance` was a byte-for-byte clone of `/api/speak`. This is the security-sensitive path: Wave 1's body cap had to be written twice. Hardening now lands once.
- **`streamIngestAsset`** — the two ingest preview routes differed only in a path segment; the helper also adds the read timeout they were missing.
- **`lib/takes.ts`** — take-loading was triplicated (share page, embed page, metadata proxy); the share and embed pages could drift on how a missing take is treated. Now one timeout-bounded loader owning the `SharedTake` shape.

## Deferred — the duplication tail (~11 + 7 test-file findings)

Consciously **not** swept. Duplication is the highest-regression category in this codebase, and these are cosmetic-to-moderate with no correctness impact — they deserve dedicated sessions with focused review, not a tail-end rush:

| Finding | What |
|---|---|
| web-character-api #5 | 12 near-identical proxy handlers across 8 files (the largest; needs a considered helper shape) |
| web-design-system #3, #4 | motion tokens re-derived in StudioDark; two equalizer-bar implementations |
| web-auth-profile #4 | avatar + plan-badge markup duplicated (profile vs UserMenu) |
| web-playground #4 | browser-fallback literal + near-duplicate `generate*` control flow |
| web-lib-utils #2 | vault stores a divergent consent statement (not the canonical `CONSENT_STATEMENT`) — **consent wording, worth doing deliberately** |
| svc-takes-certify #5 | duplicated bounded-store eviction (takes vs reviews) |
| svc-synthesis-api #5 | `/v1/performance` re-implements X-Ignored-Settings ordering |
| svc-ingest-pipeline #5 | speaker-stats/preview block duplicated across the two analyze paths (the `pick_speaker` half is done) |
| web-api-keys #5 | `MintedKey` duplicates `ApiKeyWithSecret` (low) |
| svc-tests a#4/a#5, b#3/b#4, c#3/c#4/c#5 | test-fixture duplication + brittle source-text assertions |

## New follow-up found while here (not a scan finding)

**`audio_seconds_total` is absent from `AGG_KEYS`.** It's a float, and additive (a cumulative total), but the pool aggregator only sums `AGG_KEYS` — so on a **multi-replica** deploy the aggregated `/metrics` omits it entirely, and the SavingsTicker (which reads it via `/api/health`) would under-report or show nothing. Not touched here: it's a behavior change, not dedup, and needs a check of which endpoint the health proxy actually hits in a pool deploy. Worth a look.

## Patterns established (catalogue items 34–36)

34. **Verify "dead" with a grep before deleting — and check what the dead code *exports*, not just who calls it.** A module can be 90% dead while a live consumer depends on one type in it. (glyph barrel)
35. **A duplication finding can be wrong: some copies are load-bearing.** Before consolidating, check the import boundary the copy protects (here: a stdlib-only supervisor that must not pull in torch). When the copy must stay, document *why* and convert the drift risk into a test. (AGG_KEYS)
36. **Deleting dead code can close its sibling findings for free.** Two bugs in the traced glyphs evaporated with the subsystem — fix the container, not the contents, when the container is unused.
