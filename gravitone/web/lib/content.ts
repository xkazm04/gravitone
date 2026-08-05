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
  { value: "27", label: "built-in voices" },
];

export const FEATURES = [
  {
    key: "characters",
    title: "Emotion-addressable Characters",
    body: "One speaker, many moods. Address a Character by emotion — sarah:excited — and missing emotions fall back to the nearest on a fixed chain, reported in the response headers.",
  },
  {
    key: "performance",
    title: "Multi-character performances",
    body: "POST /v1/performance renders a whole script — many Characters, inline [emotion] metatags — in one call. Compose it in the playground.",
  },
  {
    key: "stream",
    title: "Streaming first-audio",
    body: "The streaming endpoint returns audio sentence by sentence — the first line plays while the rest still renders. pcm and wav stream; mp3 uses the standard route.",
  },
  {
    key: "consent",
    title: "Consent receipts on every clone",
    body: "Every cloned voice stores the exact ownership attestation the speaker agreed to — ingest, direct upload, or studio. The receipt travels with the voice.",
  },
  {
    key: "api",
    title: "ElevenLabs drop-in",
    body: "Same paths, same xi-api-key, same output_format grammar — swap a base URL and existing client code works. A parameter we accept but do not act on is named in a response header, never silently dropped.",
  },
  {
    key: "scale",
    title: "Arm-native replica scaling",
    body: "Run N single-worker replicas with one command — python -m service.replicas — using every Arm core you pay for. No GPU. No per-character bill.",
  },
  {
    key: "audition",
    title: "The audition matrix",
    body: "One click renders every emotion a Character has on the same neutral line, so range and consistency are something you hear, not something we claim. Takes are cached; a busy engine counts down its own retry in the open.",
  },
  {
    key: "ops",
    title: "Ops in the open",
    body: "The Ops page renders the engine's own live counters: in-flight, queue depth, latency percentiles, real-time factor. A number that has not been measured yet shows as a dash, never as a zero.",
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
  sub: "The API is ElevenLabs-compatible, so migrating is a base-URL change. Slide to your monthly volume and see what stays in your pocket when the same requests hit your own CPU.",
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
