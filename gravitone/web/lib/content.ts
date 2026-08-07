// Shared mock content so all three design variants render the REAL product
// story, not lorem ipsum. Swap copy here and every variant updates.

export const BRAND = "Gravitone";

export const HERO = {
  eyebrow: "CPU-native voice AI",
  headlinePlain: "Clone any voice.",
  headlineAccent: "Own the studio.",
  sub: "Generate lifelike speech and clone voices from a short sample — through an ElevenLabs-compatible API that runs on ordinary Arm CPUs. No GPU. No per-character bill. Self-hostable.",
  primaryCta: "Open the playground",
  secondaryCta: "Read the API",
};

export const STATS = [
  { value: "1.9×", label: "faster than real-time on Arm" },
  { value: "16s", label: "audio to clone a voice" },
  { value: "$0", label: "GPU cost — runs on CPU" },
  // 26 = len(BUILTIN) in service/voices.py. Keep the two in step.
  { value: "26", label: "built-in voices" },
];

// ── the eight cards ───────────────────────────────────────────────────────────
//
// Same claims contract as PILLARS below: every line names a surface that EXISTS,
// and the header/route/figure it quotes is the real one, so a visitor can check
// us with curl. The card opens an animated diagram of the same mechanism
// (components/variants/features/previews/) — a diagram that shows something the
// product does not do is the loudest possible version of this lie, so the
// receipts live here, next to the copy, rather than in the drawing.
//
//   compat      — service/app.py: /v1/text-to-speech/{voice_id}, xi-api-key,
//                 output_format; inert params named on X-Ignored-Settings
//                 (app.py::_ignored_headers).
//   cast        — service/ingest.py: one scan's analysis casts N speakers as
//                 Characters (ingest.py:1737); every clone stores the ownership
//                 attestation (voices.py:1232-1246 — cloning REFUSES without it).
//   sovereign   — service/ingest.py "sovereign mode" (no cloud keys → auto-
//                 selected); the optional offline diarizer is
//                 `python -m service.diarize --download`, ~34 MB, sherpa-onnx,
//                 no account (README "Sovereign mode"). What the mode cannot do
//                 is stated by sovereign_limits(), not buried.
//   score       — the playground's score editor: regions over the text with
//                 visible spans; an emotion a Character lacks falls back and
//                 says so per segment (X-Segments / the emotion fallback chain).
//   stream      — POST /v1/text-to-speech/{voice_id}/stream, sentence-chunked.
//                 pcm_*/wav_* stream; mp3_* returns one body and names why on
//                 X-Stream-Fallback (app.py:1974) — the honest non-stream.
//   performance — POST /v1/performance: one call, a voice per line, inline
//                 [emotion] metatags, and what it actually did returned on
//                 X-Performance-Report (app.py:2965).
//   agents      — service/convai.py: the ElevenLabs Agents WebSocket served
//                 locally (GET /v1/convai/conversation/get-signed-url + duplex
//                 socket); service/vad.py finds turn boundaries; barge-in
//                 included. $0.00/min because it is your box.
//   arm         — lib/benchmarks.ts, transcribed from the measured table:
//                 c8g.2xlarge 4.26× single-stream, 10.9 aud/s across 4
//                 processes. Reproduce: `bash benchmark_arm.sh`.
//
// Still no competitor characterisation here. "Drop-in" is a fact about OUR API
// surface. The one sanctioned numeric exception remains the pricing citation —
// see the note above PILLARS.
export const FEATURES = [
  {
    key: "compat",
    title: "Drop-in ElevenLabs API",
    body: "Same paths, same xi-api-key, same output_format grammar — one base-URL swap and the client you already wrote keeps working. A parameter we accept but do not act on comes back named on X-Ignored-Settings, never silently dropped.",
  },
  {
    key: "cast",
    title: "One video → a whole cast",
    body: "Paste a link and one paid analysis is enough: every speaker it separates can be cast as its own Character, not one blended voice. Each clone stores the ownership attestation its speaker agreed to — cloning refuses without one.",
  },
  {
    key: "sovereign",
    title: "Sovereign mode",
    body: "No cloud keys, nothing leaving the machine. An optional ~34 MB offline diarizer still tells the speakers apart, at $0.00 and with no account to open — and the mode says out loud what it cannot do rather than degrading quietly.",
  },
  {
    key: "score",
    title: "Direct emotions like a score",
    body: "Mark regions over the text and hear them: visible spans, a suggested direction for the line, one embedding per emotion. An emotion a Character lacks falls back to its baseline and is reported on that segment, not swapped behind your back.",
  },
  {
    key: "stream",
    title: "Streaming first-audio",
    body: "The streaming endpoint returns audio sentence by sentence, so the first line is playing while the rest still renders. pcm and wav stream; mp3 cannot be transcoded incrementally, and says so on X-Stream-Fallback instead of pretending.",
  },
  {
    key: "performance",
    title: "Multi-character performances",
    body: "POST /v1/performance renders a whole script in one call — a voice per line, inline [emotion] metatags, no orchestration on your side. What it actually did comes back line by line on X-Performance-Report.",
  },
  {
    key: "agents",
    title: "Conversational agents, locally",
    body: "The ElevenLabs Agents WebSocket, served from your own box: an app already written against it repoints by changing one base URL. Turn boundaries come from local VAD, barge-in works, and the per-minute bill is $0.00.",
  },
  {
    key: "arm",
    title: "Runs on Arm, and measured",
    body: "4.26× realtime on a single c8g stream; 10.9 audio-seconds every second across four replicas on the same box. Every row is reproducible — clone the repo on your own Arm box and run bash benchmark_arm.sh.",
  },
];

// ── the three positions ───────────────────────────────────────────────────────
//
// Why someone picks this studio over a hosted voice library. EVERY line below
// has to be true of the product as it ships today — these are the claims a
// visitor will hold us to, so each one names a surface that exists:
//
//   audition   — the ingest review ledger's "as a voice" button synthesizes each
//                proposed emotion BEFORE commit (app/voices/new/page.tsx
//                ::hearAsVoice), and the Audition Room compares alternative
//                splices of the same emotion. After commit, the audition matrix
//                (app/voices/[characterId]/_variants/audition.ts) renders every
//                emotion on one identical line, and the playground's compare
//                mode (playground/_variants/EmotionAB.tsx) A/Bs any two.
//   own it     — MIT (LICENSE), self-hosted, CPU-only; the compat surface is
//                real (service/app.py: /v1/text-to-speech/{voice_id},
//                xi-api-key, output_format; inert params are named on
//                X-Ignored-Settings — app.py::_ignored_headers). Live engine
//                counters render at /ops (lib/useMetricsPoll.ts).
//   characters — Characters group Voices by emotion with tags and a rack; a
//                request for a missing emotion falls back to baseline and says
//                so in the response headers; guided capture is a ~30s read per
//                emotion (lib/emotionScripts.ts); the cast exports as JSON
//                (app/voices/_data/cast.ts).
//
// NO comparison numbers, no benchmark claims, and no characterisation of anyone
// else's product live here. "Works with your existing ElevenLabs client" is a
// fact about our API surface; anything about their pricing or quality is not
// ours to state on this page. Measured performance has its own page
// (/benchmarks) where the method is shown.
//
// The ONE sanctioned exception is the bill calculator's price table
// (lib/switchkit.ts::ELEVENLABS_TIERS) — a savings estimate cannot exist
// without the other bill. It is allowed because it is a CITATION, not a
// characterisation: it carries an as-published date and a source URL
// (ELEVENLABS_PRICING) which every surface rendering it must display. Nothing
// here on this page inherits that licence.
export const PILLARS = [
  {
    key: "audition",
    eyebrow: "hear it before you own it",
    title: "Audition the clone, not a promise.",
    body:
      "A scan proposes one Voice per emotion it found — and every one of them can be "
      + "heard as a cloned voice before a single embedding is written. Keep what sounds "
      + "right, descope what doesn't.",
    points: [
      "Play the source stem or the clone of it, side by side, at review time.",
      "Compare alternative takes of the same emotion and pick with your ear.",
      "After commit, line up the whole scale: the audition matrix speaks every emotion on one identical line.",
      "Each emotion is its own embedding — the same voice, consistently, on every call.",
    ],
  },
  {
    key: "own",
    eyebrow: "no credit meter",
    title: "Your box, your voices, your bill.",
    body:
      "Gravitone is MIT-licensed and self-hosted. It runs on ordinary Arm CPUs, so the "
      + "cost of a line of speech is the cost of the machine you already pay for — there "
      + "is no per-character meter to watch.",
    points: [
      "Works with your existing ElevenLabs client: swap the base URL, keep xi-api-key.",
      "Same request shape, wav / mp3 / pcm — and a parameter we don't act on is named in a response header, never silently dropped.",
      "Nothing leaves the box in sovereign mode — the recording is processed locally.",
      "The engine's live queue, latencies and real-time factor are on your own Ops page — the numbers the scheduler reads.",
    ],
  },
  {
    key: "characters",
    eyebrow: "built for characters",
    title: "A cast, not a flat voice list.",
    body:
      "Writers and game teams think in characters, so that is the unit here: one "
      + "Character owns a rack of emotion Voices, carries its own tags, and is addressed "
      + "by name and mood — sarah:excited.",
    points: [
      "Clone a Character from one short recording, then extend it from its own page.",
      "Fill any missing emotion with a guided 30-second read — the script is written for you.",
      "Export the cast as JSON — ids, addresses and emotion vocabulary, shaped for the API call.",
      "An emotion a Character lacks falls back to its baseline, reported in the response headers.",
    ],
  },
];

export const VOICES = [
  { name: "Alba", tag: "warm · en", hue: 190 },
  { name: "Marius", tag: "narration · en", hue: 265 },
  { name: "Estelle", tag: "bright · fr", hue: 150 },
  { name: "Giovanni", tag: "rich · it", hue: 32 },
  { name: "Your voice", tag: "cloned · 16s", hue: 340 },
];

// ElevenLabs switch-kit section (landing). Pricing math lives in
// lib/switchkit.ts — this is copy only.
export const SWITCH = {
  eyebrow: "switch kit",
  headline: "Your ElevenLabs bill, next to one Arm box.",
  // No slider any more: the section plots both bills across the whole volume
  // range, crossover included. The copy says what the picture shows — including
  // the half where we lose, which is the point of showing it at all.
  sub: "The API is ElevenLabs-compatible, so migrating is a base-URL change. One bill climbs with every character; the other is a machine that costs the same asleep or busy. Here is where they cross.",
  note: "Same request shape · xi-api-key · wav/mp3/pcm",
};

// Where "Read the API" points: the public README's ElevenLabs compat matrix —
// the real, always-reachable API reference (the studio's own API panels are
// behind auth).
export const API_DOCS_URL =
  "https://github.com/xkazm04/gravitone#elevenlabs-compatibility-matrix-drop-in-switch-kit";

export const SAMPLE_TEXT =
  "Hi — this is my cloned voice, generated locally on an Arm CPU. If this sounds like me, the studio works.";

// Hero mic demo: what the visitor READS (16-20s, phonetically varied,
// conversational) vs what their clone then SAYS (SAMPLE_TEXT — deliberately
// different words, so the playback proves synthesis, not parroting).
export const HERO_DEMO = {
  cta: "hear YOUR voice",
  readScript:
    "Here's a quick test of my own voice. I'm reading a few easy lines — " +
    "nothing fancy, just the way I actually talk. Some days start slow, with " +
    "coffee and a bit of quiet; others jump straight into the deep end. " +
    "Either way, this should be enough for the machine to catch how I sound.",
  note: "~16 seconds · cloned on the CPU · demo voice is deleted right after playback",
  keepCta: "Sign in to clone voices you keep",
};
