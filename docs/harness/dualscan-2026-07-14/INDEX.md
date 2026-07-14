# Dual-lens scan — Gravitone, 2026-07-14

> Bug-hunter + code-refactor combined, ~5 findings per unit.
> 21 parallel subagent runs, batched in waves of 8/8/5. Whole codebase (136 source files) — the Vibeman context map was 43% stale (pre-`web/`-merge paths, missing 7 service modules + 14 test files + ~37 web files), so units were remapped and ad-hoc units added for the uncovered surface.

---

## Totals

| | Critical | High | Medium | Low | **Total** |
|---|---:|---:|---:|---:|---:|
| Across 21 units | 2 | 31 | 63 | 9 | **105** |
| Share | 2% | 30% | 60% | 9% | 100% |

Lens split: **75 bug-hunter / 30 code-refactor.** Verified two ways (21 header sums = 105; 105 `Severity` bullets).

Baseline health: web `tsc --noEmit` = **0 errors**. Python service tests not runnable on this Windows box (torch/pocket-tts are aarch64-Linux wheels) — treated as a scan-only unit.

---

## Per-unit breakdown

(Sorted by criticals desc, then highs desc.)

| # | Unit | Crit | High | Med | Low | Files | Report |
|---|---|---:|---:|---:|---:|---:|---|
| 1 | svc-takes-certify | 1 | 1 | 3 | 0 | 2 | `svc-takes-certify.md` |
| 2 | web-auth-profile | 1 | 3 | 1 | 0 | 5 | `web-auth-profile.md` |
| 3 | svc-ingest-pipeline | 0 | 3 | 2 | 0 | 3 | `svc-ingest-pipeline.md` |
| 4 | svc-synthesis-api | 0 | 3 | 2 | 0 | 5 | `svc-synthesis-api.md` |
| 5 | svc-voice-emotion-lib | 0 | 3 | 2 | 0 | 3 | `svc-voice-emotion-lib.md` |
| 6 | svc-concurrency-replicas | 0 | 2 | 3 | 0 | 3 | `svc-concurrency-replicas.md` |
| 7 | web-api-keys | 0 | 2 | 2 | 1 | 8 | `web-api-keys.md` |
| 8 | web-benchmarks-health | 0 | 2 | 3 | 0 | 5 | `web-benchmarks-health.md` |
| 9 | web-character-api | 0 | 2 | 3 | 0 | 8 | `web-character-api.md` |
| 10 | web-shell-landing | 0 | 2 | 3 | 0 | 6 | `web-shell-landing.md` |
| 11 | web-voice-studio | 0 | 2 | 2 | 1 | 11 | `web-voice-studio.md` |
| 12 | svc-loadtest | 0 | 1 | 3 | 1 | 1 | `svc-loadtest.md` |
| 13 | web-character-mgmt | 0 | 1 | 3 | 1 | 10 | `web-character-mgmt.md` |
| 14 | web-design-system | 0 | 1 | 4 | 0 | 7 | `web-design-system.md` |
| 15 | web-lib-utils | 0 | 1 | 4 | 0 | 6 | `web-lib-utils.md` |
| 16 | web-playground | 0 | 1 | 4 | 0 | 9 | `web-playground.md` |
| 17 | web-takes-reviews-share | 0 | 1 | 4 | 0 | 12 | `web-takes-reviews-share.md` |
| 18 | svc-tests-a | 0 | 0 | 5 | 0 | 7 | `svc-tests-a.md` |
| 19 | svc-tests-b | 0 | 0 | 4 | 1 | 6 | `svc-tests-b.md` |
| 20 | svc-tests-c | 0 | 0 | 3 | 2 | 6 | `svc-tests-c.md` |
| 21 | web-glyph-art | 0 | 0 | 3 | 2 | 14 | `web-glyph-art.md` |

---

## The 2 criticals + 31 highs — one-line triage

### A. Trust boundary / auth (the systemic finding)

The web app's API routes are a **proxy layer that attaches the root backend key server-side but performs no caller auth** — every proxy is effectively an open relay of a privileged key. Plus two service-side auth bypasses.

1. **CRIT — certificate verify fails open** — a forged, *unsigned* cert is accepted even when the verifier holds the secret (sha256 is an unkeyed self-checksum; HMAC only enforced *if* a signature is present), so anyone mints a "certified" verdict and bypasses enterprise-tier gating. `service/certify.py:140`
2. **HIGH — privileged proxy routes have no auth gate** — root backend key attached by `backendFetch`; any LAN/CSRF-reachable client triggers root-privileged deletes/imports/clones. `web/lib/backend.ts:12` (every route)
3. **HIGH — unauthenticated key-attaching TTS proxy** — unbounded body + 180s hold on `/api/performance`. `web/app/api/performance/route.ts:23`
4. **HIGH — unsigned packs bypass authenticity** even when `TTS_PACK_SECRET` is set (signature-stripping). `service/packs.py:138`
5. **HIGH — `import_pack` decompresses each voice before the size check** (zip bomb / DoS). `service/packs.py:161`
6. **HIGH — AppFrame auth gate fails open** when Firebase env is absent (`ready` aliases config-presence, not auth-resolution) → gated studio renders to everyone. `web/components/ui/AppFrame.tsx:29`
7. **HIGH — raw API secret persisted in localStorage** (XSS-exfiltratable, long-lived). `web/lib/mintKey.ts:38`
8. **HIGH — API secret persists in localStorage after sign-out** (shared-machine leak). `web/lib/useAuth.tsx:113`
9. *(med)* `/api/speak` public open relay, unbounded unauth text → 180s hold. `web/app/playground/_variants/PlaygroundConsole.tsx` / speak route
10. *(med)* public write proxies launder the backend key onto unauthenticated callers. `web/app/api/.../route.ts`
11. *(med)* root/managed key comparison is **not constant-time** (timing side-channel). `service/keys.py`

### B. Consent & data-integrity silent failures (product-critical — this is a voice-cloning product)

12. **CRIT — voice revoke marks the vault "revoked" even when the engine delete failed** — the embedding stays synthesizable while the user is told consent was withdrawn. `web/app/profile/MyVoices.tsx:33`
13. **HIGH — consent-provenance write silently lost while the clone succeeds** — voice exists with no consent record, no user signal. `web/lib/voiceVault.ts:74`
14. **HIGH — Voice Vault ownership record dropped when auth resolves after commit** — `recorded.current` latched before the user-ready check consumes the one-shot. `web/app/voices/new/page.tsx:64`
15. **HIGH — demo hero silently plays a premade voice while claiming "your voice, cloned"** — unguarded `voice_id` falls back to stock "alba". `web/components/variants/HeroMicDemo.tsx:67`
16. **HIGH — throwaway demo character deleted by a reconstructed slug, not the returned `character_id`** → wrong-or-no deletion of consent-stamped data. `web/components/variants/HeroMicDemo.tsx:48`
17. **HIGH — optimistic key revoke leaves a live key hidden with no rollback** — user believes a leaked key is dead; it still authenticates. `web/app/keys/_variants/data.ts:74`
18. **HIGH — mid-batch stem failure/cancel orphans already-cloned, consent-stamped voices.** `service/ingest.py:550`
19. **HIGH — streaming synthesis errors swallowed** — no log, no metric, 200 to client. `service/app.py:478`

### C. Races / TOCTOU / double-submission

20. **HIGH — `create_voice` never re-checks the emotion slot under the registry lock** → two concurrent clones race into duplicate/orphaned embeddings (`import_pack` shows the correct pattern). `service/voices.py:552`
21. **HIGH — take approval "first pick wins" is non-atomic** → concurrent picks silently overwrite the recorded approval. `service/takes.py:210`
22. **HIGH — first-sign-in auth callback can mint duplicate keys and overwrite the user doc.** `web/lib/useAuth.tsx:66`
23. **HIGH — dead replica's `SO_REUSEPORT` socket held open in parent during crash-backoff** → kernel black-holes ~1/N of connections for up to 30s. `service/replicas.py:223`
24. **HIGH — `ensureShared` re-uploads a take already publishing** → duplicate public Voice Cards + share-id mismatch. `web/app/playground/_variants/PlaygroundConsole.tsx:248`
25. **HIGH — `commit()` has no in-flight guard** → a double click fires two commits. `web/app/voices/new/page.tsx:111`

### D. Resource leaks / deadlock / event-loop

26. **HIGH — commit can deadlock forever** on a full child stderr pipe (never drained during stdout streaming). `service/ingest.py:538`
27. **HIGH — every managed-key request blocks the asyncio event loop** on a synchronous `api_keys.json` read under a global lock. `service/keys.py:165`

### E. Persistence / state corruption

28. **HIGH — non-atomic key-store write + swallowed JSON error silently destroys all managed keys.** `service/keys.py:71`
29. **HIGH — non-atomic cross-process write to `emotion_demand.json`; `_load` silently resets ALL counts to `{}` on corruption.** `service/demand.py:50`
30. **HIGH — GC expires ingest jobs purely by creation age** → deletes stems mid-review / mid-flight. `service/ingest_api.py:186`
31. **HIGH — successful synth miscounted as an error (latency double-recorded) when a response header fails to parse** → falsely trips level degradation, corrupts the sizing knee. `service/loadtest.py:400`
32. **HIGH — profile `save()` has no error handling** — a failed Firestore write hangs the button forever. `web/app/profile/page.tsx:41`

### F. Money-truth / correctness

33. **HIGH — capacity planner recommends the pricier single box (~$212/mo) over a 4×t4g fleet (~$49/mo)** that also covers the load — directly contradicting the leaderboard on the same page. `web/lib/benchmarks.ts:122`

### G. Web UX contract

34. **HIGH — share-card OG image is a root-relative URL with no `metadataBase`** → every social preview resolves to localhost/broken, defeating the "every share is a landing page" loop. `web/app/t/[id]/page.tsx:31`
35. **HIGH — 5xx error bodies inconsistently plain-text vs JSON**, breaking JSON-parsing clients. `web/app/api/voices/route.ts:9`
36. **HIGH — stale `?record=` deep-link re-fires on every character refresh and hijacks the guided recorder.** `web/app/voices/[characterId]/CharacterVoices.tsx:22`

---

## Triage themes (fix-wave clustering)

| Wave | Theme | Approx findings | Why it's one mental model |
|---|---|---:|---|
| 1 | **Trust boundary & auth** | ~11 | The whole web proxy layer launders the root key with no caller auth; + certify fail-open, unsigned-pack bypass, zip-bomb, non-constant-time compare, localStorage secrets. One security posture. |
| 2 | **Consent & data-integrity silent failures** | ~9 | For a voice-clone product, "told revoked but still synthesizable / cloned with no consent record / demo lies about your voice" is the reputational core. All the same fail-silent-on-write shape. |
| 3 | **Races / TOCTOU / double-submit** | ~8 | Re-check-under-lock, in-flight guards, atomic pick — one concurrency toolkit across service + web. |
| 4 | **Resource leaks / deadlock / event-loop** | ~7 | Pipe drain, off-loop file IO, ffmpeg/HTTP timeouts, object-URL revokes. Liveness under load. |
| 5 | **Persistence / state corruption** | ~6 | Atomic temp-file+replace writes for the JSON stores (keys, demand, takes) + GC-by-status not age. |
| 6 | **Money-truth / correctness** | ~6 | Pricing/units honesty: monthly-vs-lifetime, clamp-to-$0-hides-loss, planner-vs-leaderboard contradiction. |
| 7 | **Web UX contract** | ~13 | OG/metadataBase, JSON error shape, error-swallowing surfaces, file-input reset, escape-cancels-rename, focus trap, audio event ordering. |
| 8 | **Test integrity (success theater)** | ~6 | Tests that pass but assert nothing (debounce defeats the concurrency test; atomic-write crash path never exercised; flaky wall-clock TTFB). Fix before trusting the suite as a merge gate. |
| 9 | **Dead code & duplication** | ~23 | Dead glyph subsystem (10 files) + PrototypeTabs; 12 duplicated proxy handlers, find-character-by-id ×8, triplicated take-loading, duplicated fixtures. Do as dedicated sessions. |

---

## Suggested next-phase split (fix waves)

- **Wave 1 — Auth/trust boundary** (start here). certify fail-open (CRIT) + web proxy auth gate + pack signing + zip-bomb + constant-time compare + localStorage secrets. Needs a product decision on the web→service auth model (per-user key binding vs. session-verifying proxy) — **escalate before building**, since #2/#9/#10 all hinge on it. The self-contained wins (certify HMAC-required, pack signature-required, zip-bomb pre-check, constant-time compare, AppFrame fail-closed) can ship immediately.
- **Wave 2 — Consent & data-integrity silent failures.** Both criticals-adjacent; highest reputational value. Check-the-response-before-claiming-success across revoke/commit/clone paths.
- **Wave 3 — Races / TOCTOU / double-submit.**
- **Wave 4 — Resource leaks / deadlock / event-loop.**
- **Wave 5 — Persistence / atomic writes.**
- **Wave 6 — Money-truth.**
- **Wave 7 — Web UX contract.**
- **Wave 8 — Test integrity** (do before relying on the suite to gate later waves).
- **Wave 9 — Dead code & duplication** (dedicated cleanup sessions).

---

## How this scan was run

- **Scanners:** bug-hunter + code-refactor (Vibeman registry `src/lib/prompts/registry/agents/`), combined dual-lens per unit, reliability-first tiebreak.
- **Date:** 2026-07-14. **Scope:** full monorepo — `service/` (Python FastAPI TTS) + `web/` (Next.js 16 studio), 136 tracked source files.
- **Method:** 21 units (cohesive file groups, complete partition verified: 136/136 covered, 0 gaps, 0 dupes), each a `general-purpose` subagent reading files read-only and writing one report. Target 5 findings/unit.
- **Files read (approx, per replies):** ~230 file-reads across the fleet (several agents read supporting files beyond their unit to verify contracts).
- **Verification:** finding count checked two ways (header sums = bullet count = 105).
- **Context-map note:** the registered map covered only 78/136 files with pre-merge `gravitone-web/` paths. Remap + ad-hoc units applied for this scan; the live map should be refreshed (see Phase B7).
