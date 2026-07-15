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
    body: "Same paths, same xi-api-key, same output_format grammar. Point existing client code at your own endpoint — swap a base URL.",
  },
  {
    key: "scale",
    title: "Arm-native replica scaling",
    body: "Run N single-worker replicas with one command — python -m service.replicas — using every Arm core you pay for. No GPU. No per-character bill.",
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
