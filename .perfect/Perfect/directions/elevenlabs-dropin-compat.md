---
slug: elevenlabs-dropin-compat
type: perfect/direction
context: "[[Speech Synthesis API]]"
lens: ux
status: shipped
size: M
proposed: 2026-07-13  accepted: 2026-07-13  shipped: 2026-07-13  commit: ffced19
---
## What & why
Real ElevenLabs SDKs break on us: /v1/voices returns a bare list instead of {"voices":[...]}; no /v1/models or /v1/voices/{id}; mp3_24000_192-style formats ignore bitrate (hardcoded 128k) and sample rate; PCM content-type is wrong (audio/basic); similarity_boost/style accepted then silently dropped. Demo moment: point the official EL SDK at Gravitone and it just works.
## Evidence
voices.py:271-273; engine.py:76; app.py:157-164; app.py:163; app.py:70-87.
## Acceptance criteria
- EL response shapes for /v1/voices, /v1/voices/{id}, /v1/models
- bitrate + sample-rate suffixes honored (resample via scipy)
- correct content-types per format
- unsupported settings documented as explicit no-ops
## Risks / non-goals
No pronunciation dictionaries, /v1/user, or websockets.
## Build record
Wave 3, 2026-07-13. Opus builder; Director-reviewed (verified the no-web-changes claim independently: all /api/voices frontend uses are POST/DELETE). similarity_boost/style kept inert with X-Ignored-Settings header (no honest model knob). Gates green: compileall + 89 unittests + tsc. Commit ffced19.
