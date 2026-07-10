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
    key: "clone",
    title: "Zero-shot voice cloning",
    body: "Upload 15–30 seconds of clean speech and get a reusable voice in seconds. Own your library.",
  },
  {
    key: "api",
    title: "ElevenLabs-compatible API",
    body: "POST /v1/text-to-speech/{voice}. Point existing client code at your own endpoint — swap a base URL.",
  },
  {
    key: "cpu",
    title: "Runs on Arm silicon",
    body: "oneDNN + Arm Compute Library on Graviton / Axion / Ampere. Streaming, ~200 ms first chunk, no GPU.",
  },
  {
    key: "queue",
    title: "Built-in queue & scaling",
    body: "Bounded worker pool with 429 backpressure, and process-level scaling that uses every core you pay for.",
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

export const NAV = [
  { label: "Playground", href: "#playground" },
  { label: "Voices", href: "#voices" },
  { label: "API", href: "#api" },
  { label: "Pricing", href: "#pricing" },
];

export const SAMPLE_TEXT =
  "Hi — this is my cloned voice, generated locally on an Arm CPU. If this sounds like me, the studio works.";
