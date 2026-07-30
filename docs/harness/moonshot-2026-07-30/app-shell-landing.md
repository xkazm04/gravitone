# Moonshot scan — App Shell & Landing (web)

Context: `web/app/page.tsx` → `components/variants/StudioDark.tsx`, `app/layout.tsx`,
`app/globals.css`, `lib/content.ts`, `app/benchmarks/` (+ `BenchmarksView`, `lib/benchmarks.ts`),
`components/ui/AppFrame.tsx`, `lib/backend.ts`, `next.config.mjs`, `package.json`.
Scanned 2026-07-30 as MOONSHOT ARCHITECT. Read-only.

Current shell in one line: a single dark "Obsidian" landing (hero mic demo, switch kit,
features from `content.ts`, playground teaser, footer link to `/benchmarks`), a gated
`AppFrame` for studio routes, and a public `/benchmarks` proof page — with **every**
audible byte produced by a server round-trip through `lib/backend.ts` and the shell
itself having no audio surface of its own.

---

## M1. The In-Browser Engine — the landing page synthesizes with no server at all

- **Tier**: 1 (10x category-defining)
- **Category**: platform
- **Impact**: The 100M-parameter CPU-only model is small enough to run *in the visitor's
  tab* (WASM/SIMD + onnxruntime-web). The landing hero, the playground, and any embedded
  demo then cost zero backend compute, scale to unlimited concurrent visitors, and keep
  audio and voice samples on-device — turning "CPU-native" from a claim into something
  the page literally performs while offline.
- **Feasibility**: medium
- **Time-horizon**: quarters
- **Why it's a moonshot**: Nobody ships a real TTS + voice-clone demo that never touches a
  server; the whole category is GPU-behind-an-API. Gravitone's differentiator (a tiny
  CPU-bound model) is exactly the property that makes browser inference possible, so this
  is the one competitor-proof move available — an ElevenLabs-shaped company physically
  cannot follow. It also collapses three known problems at once: the deferred hero-demo
  abuse/rate-limit risk (`followups-2026-07-10.md`, wave 7) disappears because there is no
  shared resource to abuse; marketing traffic stops competing with paying synth slots; and
  "sovereign / never leaves the device" becomes true in the browser too, not just on a
  local box.
- **Path to implementation**:
  1. **In the current scaffold**: introduce a client-side runtime seam —
     `lib/engine.ts` exporting `synthesize()` / `clone()` that today only forwards to the
     existing `/api/speak` + clone relays, plus `lib/engineCapability.ts` probing
     `WebAssembly.validate` + SIMD + `crossOriginIsolated` + device memory. Route
     `HeroMicDemo` and the playground through the seam (no behaviour change), and surface
     the probe result as a shell-level badge ("engine: server" / "engine: this device").
  2. Export the Kyutai Pocket TTS graph to ONNX offline (a `service/` script, run once,
     artifact published as a versioned static asset) and stand up a
     `web/public/engine/<version>/` manifest + a Web Worker wrapper that streams PCM
     chunks out to the existing audio player — text-to-speech only, built-in voices only.
  3. Flip the hero demo to `engine: this device` when the probe passes, with the server
     path as automatic fallback; add COOP/COEP headers in `next.config.mjs` for threaded
     WASM and a lazy, cached, progress-reported weight download (visitors who never click
     download nothing).
  4. Port the voice-embedding step (the 16s clone) into the worker so the hero demo's
     recorded audio never leaves the tab; keep server clone for voices the user *keeps*.
  5. Extract the worker + manifest into a publishable `@gravitone/engine-web` package with
     a documented 5-line embed — the local engine becomes the distribution vehicle, not
     just a landing trick.
  6. Add a shell parity check (same text, same voice, server vs local → RTF + a spectral
     distance assertion) to the vitest suite so drift between the two engines is caught.
- **Dependencies**: ONNX/WASM exportability of the model graph (the real unknown — needs a
  spike before step 2 is committed); cross-origin isolation headers (interacts with any
  third-party iframe/embed on the page); CDN/static hosting for ~100-300MB of weights;
  `lib/audioFormats.ts` for playback reuse.
- **Risks**: export may hit unsupported ops and force a partial rewrite of the inference
  path; weight download size is a hostile first-visit cost on mobile (mitigate: probe gates
  mobile out, server path stays default); two engines = two quality/latency profiles to
  keep honest, which is why step 6 is not optional; COOP/COEP can break existing embeds.
- **What changes if we ship it**: Gravitone stops being an API you call and becomes a
  runtime that ships anywhere a browser runs — with a landing page whose demo cannot be
  rate-limited, cannot be too expensive, and works on a plane.

---

## M2. Audible Docs — the shell narrates itself, and that narrator becomes a product

- **Tier**: 2 (3-5x)
- **Category**: platform
- **Impact**: Every page in the shell (landing, `/benchmarks`, methodology, README-grade
  docs) gains a persistent "listen" dock that reads the page aloud in a chosen Character
  with emotion-addressed section transitions — and the extraction+narration primitive
  behind it ships as `POST /v1/narrate {url}` plus a one-line embed so any customer site
  can do the same to *its* pages.
- **Feasibility**: high
- **Time-horizon**: weeks → months
- **Why it's a moonshot**: The strongest possible proof for a voice company is a site you
  can consume with your eyes closed, and today Gravitone's own marketing is silent unless
  you press a demo button. Making the shell audible converts the entire content surface
  into continuous product demonstration, and because the narration engine is
  URL-in/audio-out it is simultaneously a new top-of-funnel product category (audible
  documentation for every dev-tools company) rather than a marketing gimmick. Deliberately
  distinct from the deferred `<gravitone-player>` take embed: that plays *one stored take*;
  this generates narration for *arbitrary page content* on demand.
- **Path to implementation**:
  1. **In the current scaffold**: add `lib/narratable.ts` — a small registry mapping each
     shell route to its narratable blocks (landing sections already exist as structured
     data in `lib/content.ts`; `/benchmarks` copy + `HARNESS` in `lib/benchmarks.ts` are
     equally structured), then a `NarrationDock` in `components/ui/` mounted from
     `layout.tsx` that reads the registry for the current route and plays sequential
     sentences through the existing `/api/speak` relay. Landing + benchmarks only, no new
     backend.
  2. Make it feel authored, not robotic: pick a Character per section role (hero = warm,
     benchmarks = measured), map section kind → `[emotion]` metatag using the existing
     emotion addressing, sync a scroll-follow highlight to the playing sentence, and
     persist the listener's chosen narrator in the dock.
  3. Cache aggressively: content-hash each narratable block, store rendered audio as a
     static artifact at build time (`scripts/bake-narration.ts`), so repeat visitors and
     crawlers get CDN files and synth is only used for cache misses — the page stays fast
     and cheap under real traffic.
  4. Generalise to arbitrary content: `POST /v1/narrate` taking a URL or a markdown/HTML
     body → readability extraction → segmented, emotion-tagged narration job, returning a
     stable narration id; the shell dock becomes its first consumer.
  5. Ship the embed: `<script src=".../narrate.js" data-voice="…">` that injects the same
     dock into any customer page and points at the customer's own Gravitone deployment —
     self-hosters get audible docs for their own product, which puts a Gravitone-powered
     player on other people's sites.
  6. Close the loop for accessibility credibility: keyboard controls, `prefers-reduced-motion`
     respect (globals.css already has the media query), and a `?narrate=1` deep link so a
     shared URL starts speaking.
- **Dependencies**: existing `/api/speak` + Character/emotion addressing (both shipped);
  a readability extractor for step 4; static hosting for baked audio; `lib/audioFormats.ts`.
- **Risks**: narration of long pages is expensive if uncached — step 3 must land before any
  public traffic; auto-playing audio is user-hostile unless strictly opt-in with obvious
  stop; extraction quality on third-party pages is the classic long tail (ship with a
  "paste the text instead" fallback); scope creep toward a full podcast tool — keep it
  page-scoped.
- **What changes if we ship it**: The product's own website becomes its best sample reel,
  and Gravitone acquires a second, viral distribution surface — an audible-docs player
  running on other companies' sites.
