# /studio — Agentic Cinema scope

**Goal.** A new `/studio` page that turns Gravitone from "a voice box" into a
content-generation studio: an agent takes a creative brief, fans out into
multimodal generation jobs (speech, narration, dubs, images, music, captions),
and everything lands in a **structured, searchable asset library** with full
provenance. Built for the Agentic Cinema hackathon: Gemini + Google Cloud as
the production engine (replacing the weak Sovereign-mode open models),
**Grafana** as the partner track, ADK agent as the director.

The pitch in one line: *"A self-hosted voice studio that hires a Gemini
director — every asset it produces is captioned, cataloged, and traceable to
the agent decision that made it."*

---

## What we already have (reuse, don't rebuild)

| Hackathon need | Existing mechanism | Change needed |
|---|---|---|
| Production LLM engine (Phase 1) | `service/brain.py` — one seam, `gemini` preset exists | Env flip + Vertex AI auth path; keep `claude-cli` for local dev |
| Video captioning (Phase 2) | `service/vision.py` scene descriptions (Qwen) | Add Gemini multimodal adapter behind same contract |
| Speech generation (Phase 2) | Engine plane (`engines.py`), voiceover/revoice pipelines | Add `gemini-tts` engine adapter (cloud mouth, capability-declared) |
| Job orchestration | `service/jobs.py` JobRegistry (permit/TTL/reaper) | One registry per new generation type |
| Asset provenance | `takes.py` reviews & lineage | Generalize: takes are one asset kind among four |
| Agent tool surface (Phase 4) | Existing **MCP server** | Expose library + generation tools; ADK agent consumes them |
| Pipeline metrics (Phase 3) | `demand.py`, direction telemetry, observability | Prometheus `/metrics` + Grafana API calls in code |
| Honest-failure UI | `apiFetch`, `ErrorBanner`, poller hooks, `_video` parts | Compose, per DESIGN.md restrained tier |

---

## The /studio page (web)

Three panes, one route, Signal design language (functional tier — no
performing illustrations; accents in states and transitions only).

### 1. Library — structured multimodal assets
The centerpiece. A catalog of **assets**: `image | audio | video | script`.

- **Data model** (`service/library.py`, sidecar-JSON per asset like voices/
  takes; `atomicio.file_lock` for meta mutation — the cross-process rule):
  ```
  asset_id, kind, title, mime, bytes, created_at,
  caption          — Gemini-written description (searchable)
  caption_status   — written | pending | failed (a missing caption says why)
  tags[]           — agent- or user-assigned categories
  provenance       — { source: upload|generated, job_id, agent_run_id,
                       model, prompt, parent_asset_ids[] }
  collection       — user-defined shelf (e.g. "Trailer v2")
  ```
- **API**: `POST /v1/assets` (upload → auto-caption job), `GET /v1/assets?kind=&q=&tag=`,
  `GET /v1/assets/{id}/file`, `PATCH` (tags/collection), `DELETE`.
  Search v1 = caption/tag substring; stretch = BigQuery vector search.
- **UI**: filter rail (kind/tag/collection), card grid with kind-appropriate
  preview (waveform, poster frame, thumbnail), detail drawer showing caption,
  provenance chain ("made by *dub job r41* from *scene 3 of reel.mp4*"), and
  lineage links to parent assets. Failed captions render as amber warnings,
  never silent blanks.

### 2. Direct — the agent console
A brief box ("90-second trailer VO for a heist short, two voices, tense
score") → the ADK **Director agent** plans and executes:

- Plan is streamed back as a visible step list (tool calls named, not
  hidden): *analyze script → cast voices → generate narration → generate
  score (Lyria) → generate 3 poster concepts (Imagen) → caption everything
  → file into collection.*
- Each step is a real job (JobRegistry shape) the user can watch/cancel;
  outputs appear in the Library live, tagged with `agent_run_id`.
- Per-step failure is per-step: a Lyria refusal doesn't vaporize the
  narration that already rendered. The run report names what finished,
  what failed, and why (sanitized, request-id discipline).

### 3. Pipeline — Grafana partner surface
- In-app: honest job/queue state (reuse demand telemetry reader).
- Grafana: embedded dashboard (or deep link) showing generation pipeline
  metrics — jobs by kind/model, latency, spend ledger, failure rates.
- **Code-level partner integration** (required "imported and called in
  code"): `service/grafana.py` —
  1. pushes **annotations** via Grafana HTTP API on every agent run
     start/finish/failure (the demo moment: agent acts → dashboard annotates);
  2. provisions the dashboard itself via the Grafana API on startup
     (`scripts/provision_grafana.py`), so a judge's fresh install gets the
     board without clicking.
  Off-until-configured, same posture as observability.py (no DSN, no import).

---

## Backend additions by hackathon phase

### Phase 1 — production LLM engine (Gemini SDK)
- New `service/gcp/` package using `google-genai` SDK (Vertex AI mode):
  `brain` backend `gemini-vertex` (ADC auth, no key-in-URL), plus the
  GenMedia clients below. `brain.py` presets stay; Sovereign path untouched.
- Everything key-gated and probed (`available()`), spend-ledgered like
  vision.py — the house posture for cloud calls.

### Phase 2 — GenMedia jobs (each = one JobRegistry + one MCP tool + one BFF route)
- **Captioning**: `caption.py` — Gemini multimodal over image/audio/video
  assets; runs automatically on upload and on demand. This is what makes
  the Library *structured* rather than a folder.
- **Image / VFX**: `imagine.py` — Imagen 3: mood boards, storyboard panels,
  poster concepts. Batch of N, all N filed with prompt provenance.
- **Music**: `score.py` — Lyria 3 clips (genre/mood/duration). Output is an
  audio asset; revoice/voiceover can later mux it as a bed (stretch: fixes
  the documented "background dropped" v1 limit of revoice).
- **Speech**: `gemini-tts` engine adapter in the engine plane — declared
  capabilities, conformance-suite tested, selectable in /studio next to
  Pocket TTS/Piper. Multi-speaker dialogue = existing dub composer pointed
  at the new mouth.
- Sentiment/read analysis (stretch): Gemini audio-vs-script comparison on a
  take, filed as a review — plugs into the existing reviews system.

### Phase 3 — Grafana (partner track)
As above: `grafana.py` annotations + API-provisioned dashboard, fed by a
Prometheus `/metrics` endpoint exporting job counts, latencies, spend, and
fit-ladder outcomes. Deploy Grafana alongside on Cloud Run or use Grafana
Cloud free tier.

### Phase 4 — ADK Director agent
- `agents/director/` — native ADK (`google-cloud-aiplatform[agent_engines,adk]`).
- Tools = **Gravitone's own MCP server** (the story writes itself: the
  hackathon wants partner/MCP integration, and we already ship an MCP
  server) extended with: `list_assets`, `search_library`, `generate_image`,
  `generate_music`, `synthesize_speech`, `caption_asset`, `file_asset`.
- Forced function calling for the consent/safety gate before any clone
  voice is used — maps to the hackathon's "forced safety checks" item and
  to Gravitone's existing consent posture.
- Runs locally for dev; deployed to **Agent Engine** for submission.
- `/studio` Direct pane talks to it through a thin BFF route that relays
  the run's step events.

### Phase 5 — Google Cloud deployment
- Service container → **Cloud Run** (the deploy compiler already produces
  images; add a `gcloud run deploy` recipe to `deploy/`).
- Assets → **GCS bucket** backend for `library.py` (local-dir default
  remains; storage is a two-implementation seam from day one).
- Keys → **Secret Manager**; agent → Agent Engine; Gemini safety settings
  configured explicitly on every GenMedia call.
- `deploy/gcloud/README.md` with the exact CLI runbook (judges must be able
  to reproduce).

---

## Build order (each slice demoable on its own)

1. **Library core** — `library.py` + assets API + /studio Library pane, upload
   + manual tags. No cloud needed. *(the skeleton)*
2. **Gemini captioning** — auto-caption on upload; search works. *(first
   Google Cloud runtime use)*
3. **Imagen + Lyria + Gemini TTS jobs** — Direct pane in manual mode (run one
   generator at a time). *(GenMedia demo)*
4. **Metrics + Grafana** — /metrics, annotations, provisioned dashboard.
   *(partner requirement satisfied)*
5. **ADK Director** — agent plans and chains steps 2–3 from a brief; run
   report in UI. *(the "agentic" in Agentic Cinema)*
6. **Cloud Run + GCS + Secret Manager** deployment + demo video runbook.

## Risks / open questions
- **Lyria 3 access** may be allowlisted or region-limited on the trial/$100
  credits — verify early; fallback is Gemini TTS-only audio plus existing
  voice pipeline (still a strong Phase 2 story).
- **Agent Engine cost/latency** on credits — dev against local ADK runner,
  deploy once stable.
- **Public repo requirement** — repo must be public with a visible license
  (LICENSE exists; check the About section) and must not leak the private
  vault dirs (`.perfect/`, `.architect/`) — likely split or scrub before
  submission.
- **Quota discipline** — every GenMedia call goes through the Spend ledger
  pattern so the $100 doesn't evaporate in a captioning loop.
