# Moonshot scan — Sharing, Packs & Distribution (2026-07-30)

Context read: `service/takes.py`, `service/packs.py`, `service/demand.py`,
`web/lib/takes.ts`, `web/app/t/[id]/{page,embed/page,TakeCard}.tsx`,
`web/app/r/[id]/{page,ReviewPicker}.tsx`, plus `service/voices.py` /
`service/emotions.py` surface used by packs and the `web/app/api/*` proxy set.

Both proposals build ON the shipped surface (takes, review links, .gravichar,
embed, demand loop) and deliberately avoid the deferred followups in
`followups-2026-07-10.md` (pack gallery/marketplace with hosting+payments+
moderation, Ed25519 creator keys as a standalone feature, oEmbed, web
component, dynamic OG/MP4) and the rejected clusters (billing/metering,
capacity tiers, pricing, cast cloning, white-label).

---

## M1. Characters as content-addressed URIs — a registry-less voice federation

- **Tier**: 1 (10x category-defining)
- **Category**: platform
- **Impact**: `.gravichar` stops being a file a human downloads and re-uploads
  and becomes an *addressable dependency*: any Gravitone node can synthesize
  with `character: "https://studio.example.com/voices/narrator.gravichar"` (or
  its `sha256` digest), fetching, verifying and caching the pack on first use.
  Voices then propagate across instances the way container images do — with no
  central registry, no hosting bill, and no moderation surface to own.
- **Feasibility**: medium
- **Time-horizon**: months
- **Why it's a moonshot**: it converts a single-instance asset format into a
  distribution *protocol*. Every static web host on earth becomes a voice
  registry; a customer's own S3 bucket, GitHub release or CDN path is the
  publishing endpoint, so Gravitone gets marketplace-scale reach without
  building (or policing) a marketplace. Content addressing also makes renders
  reproducible — a script pinned to a digest sounds identical on a laptop, an
  Arm edge box and CI, which is the property studios and CI pipelines cannot
  get from any hosted TTS vendor.
- **Path to implementation**:
  1. In `service/packs.py`, factor the body of `import_pack` into
     `_ingest_pack(blob: bytes, rename: str) -> Character` (all existing
     manifest/format/HMAC/zip-bomb/sha256/emotion validation unchanged), then
     add `POST /v1/characters/import/url {url}` that fetches bytes with a size
     + timeout cap and calls it. Same file, no new subsystem — the security
     posture is inherited wholesale.
  2. Add content addressing: compute `digest = sha256(pack bytes)` and store
     resolved packs under `<data>/packs/<digest>/` with a `resolved.json`
     (source URL, digest, first-seen, character id). Import becomes idempotent
     — a second resolve of the same digest is a cache hit, not a 409.
  3. Teach voice resolution to accept a *ref*: in `service/voices.py`
     `find_character`/`get_character_or_404`, when the id looks like a URL or
     `sha256:<hex>`, lazily resolve through step 2 before failing. Every
     existing caller (`/v1/audio/speech`, `/v1/performance`, review takes)
     inherits remote characters with no signature change.
  4. Trust policy, not a trust authority: `TTS_PACK_SOURCES` host allowlist
     (empty = resolution disabled, fail closed), trust-on-first-use digest
     pinning per source URL, and a loud 409 when a URL's digest changes under
     a pin. This is where the deferred Ed25519 work plugs in later as an
     *optional* stronger link — the protocol works without it.
  5. Publish side: `GET /v1/characters/{id}/pack` already emits the artifact —
     add `GET /v1/characters/{id}/pack.json` (digest, size, emotion slots,
     custom slots, license/creator fields) as the discovery document, and emit
     a `<link rel="gravitone-pack" href=…>` tag plus a `gravi.lock`-style
     pinned manifest export from the studio, so a page or a repo *advertises*
     the voices it performs with.
  6. Close the loop with sharing: stamp every published take's metadata with
     the resolved `pack_digest`, so `/t/[id]` can render "performed with
     narrator@a91f… — resolve this voice" and a visitor's own instance can
     one-command reproduce the exact render.
- **Dependencies**: outbound HTTP allowed on the service (currently the
  service is inbound-only — needs a deliberate egress decision and SSRF
  guards: no private/link-local targets, no redirects to them); existing
  `mutate_meta` registry lock; disk budget for the pack cache with the same
  bounded-store discipline `takes.py` uses.
- **Risks**: SSRF and pack-bomb abuse on the fetch path (mitigated by
  allowlist-default-off, size/time caps, and reusing the existing declared-size
  zip-bomb rejection); voice-likeness laundering — a URL makes non-consensual
  clones trivially shareable, so the consent/vault provenance must ride in the
  manifest and be surfaced at resolve time, not bolted on; digest pinning
  friction if creators re-export packs casually.
- **What changes if we ship it**: Gravitone becomes the *substrate* other
  people distribute voices on rather than an app that owns them — reach and
  network effects without hosting, payments or moderation liability.

---

## M2. Re-performable takes — every share is a fork point, and every edit is data

- **Tier**: 2 (3-5x)
- **Category**: functionality
- **Impact**: a shared take stops being a frozen wav. Because
  `takes.py` already persists the exact metatagged `text` plus the per-segment
  emotion report, `/t/[id]` and `/r/[id]` can offer "re-perform this" — change
  one `[emotion]` tag, swap the character, re-render, and mint a *child* take
  with lineage. Sharing becomes reproductive (each share can spawn shares) and
  client review gains the revision round it currently lacks.
- **Feasibility**: high
- **Time-horizon**: weeks
- **Why it's a moonshot**: it flips distribution from broadcast to remix — the
  only real viral mechanic available to an audio tool, and one no hosted TTS
  vendor can copy cheaply because each fork costs GPU money for them and ~CPU
  seconds for us. The second-order prize is bigger than the loop: the diff
  between a parent take and its child is a *human direction decision*
  ("line 3: baseline → angry", "swapped character"), and `demand.py` today only
  records unmet-fallback demand. A corpus of applied direction deltas — and,
  via review picks, which delta *won* — is a proprietary dataset for
  auto-direction that grows with usage and cannot be scraped.
- **Path to implementation**:
  1. In `service/takes.py`, accept and persist an optional
     `parent_id` + `derived_from` block on `create_take` (validated the same
     way as `character_id`), and expose `GET /v1/takes/{id}/lineage`
     (parent chain + children, bounded depth). Pure additive metadata, no
     client change required.
  2. Add `service/direction.py` (sibling of `demand.py`, same
     lock + `atomic_write_text` discipline): `record_delta(parent, child)`
     derives per-segment emotion changes and character swaps and counts them
     by `(character_id, from_emotion → to_emotion)`. Fed by step 1 on every
     derived take; never raises.
  3. Studio side: "open this take in the rack" — the share/embed card links
     into the playground pre-loaded with the take's metatagged text and
     character, so editing is the existing rack flow, not new UI. First-class
     re-render for the *owner* only at this stage (no public compute).
  4. Public re-perform on `/t/[id]`: one edit, one render, hard per-IP rate
     limit and a queue cap (this is the same abuse surface the deferred hero-
     demo hardening flags — build the limiter once, share it with the demo
     path). Children are marked `derived` and excluded from the eviction
     pressure that would otherwise orphan a lineage mid-chain.
  5. Review revisions: on `/r/[id]`, a reviewer's note plus a requested
     direction change becomes a "revise" action that creates a *new* review
     round seeded from the picked take — preserving the shipped "first pick is
     final, a new round is a new link" invariant while removing the email
     round trip.
  6. Feed it back: extend `GET /v1/reviews/preferred` (and the studio's
     coverage surfaces) with direction stats — "clients moved line-level
     emotion to `angry` 41× on this character; 78% of picks were the edited
     child" — turning the corpus into an in-product default recommendation.
- **Dependencies**: bounded take store must gain lineage-aware eviction (today
  `_evict_oldest` would silently break a chain, and `get_review` already
  tolerates evicted members); rate limiter shared with the hero demo; the
  existing emotion-tag grammar and `/v1/performance` render path.
- **Risks**: public compute abuse (each fork is ~real CPU seconds — limiter is
  load-bearing, not polish); lineage plus eviction is the subtle correctness
  trap; unmoderated public forks let anyone put new words in a shared voice, so
  forking must be opt-in per take at publish time and the child must display
  its provenance; the direction corpus is only valuable if a meaningful
  fraction of forks are real edits rather than curiosity clicks.
- **What changes if we ship it**: shares compound instead of decaying, review
  becomes a conversation rather than a verdict, and every user interaction
  quietly builds a direction dataset that makes the product better at the one
  thing it is differentiated on.
