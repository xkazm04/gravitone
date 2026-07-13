// ElevenLabs switch kit — single source for the pricing comparison and the
// one-line migration snippets used on the landing page, the keys page and
// the profile "your key" panel.
//
// ElevenLabs numbers are public list prices (credits ≈ characters, and
// ~1,000 characters ≈ 1 minute of audio on multilingual v2). Gravitone
// numbers come from the measured benchmark study in gravitone/README.md:
// a burstable 2-vCPU Graviton t4g.small sustains ~1.33× realtime.

export const CHARS_PER_AUDIO_MINUTE = 1000;

export type ElTier = { name: string; usdPerMonth: number; charsPerMonth: number };

export const ELEVENLABS_TIERS: ElTier[] = [
  { name: "Free", usdPerMonth: 0, charsPerMonth: 10_000 },
  { name: "Starter", usdPerMonth: 5, charsPerMonth: 30_000 },
  { name: "Creator", usdPerMonth: 22, charsPerMonth: 100_000 },
  { name: "Pro", usdPerMonth: 99, charsPerMonth: 500_000 },
  { name: "Scale", usdPerMonth: 330, charsPerMonth: 2_000_000 },
  { name: "Business", usdPerMonth: 1_320, charsPerMonth: 11_000_000 },
];

export type ArmBox = {
  name: string;
  usdPerHour: number; // on-demand list price
  aggregateRtf: number; // measured audio-seconds generated per wall-second
};

// Presets from the benchmark table (README "Measured performance").
export const ARM_BOXES: ArmBox[] = [
  { name: "Graviton t4g.small (2 vCPU)", usdPerHour: 0.0168, aggregateRtf: 1.33 },
  { name: "Graviton c7g.xlarge (4 vCPU)", usdPerHour: 0.145, aggregateRtf: 4.0 },
];

const HOURS_PER_MONTH = 730;

export type Estimate = {
  chars: number;
  audioMinutes: number;
  elTier: ElTier; // cheapest tier that covers the volume
  elUsd: number;
  box: ArmBox;
  boxUsd: number; // box running 24/7 — the worst case for us
  boxCapacityMinutes: number;
  overCapacity: boolean; // volume exceeds one box; suggest the bigger preset
  savingsUsd: number;
  savingsYearUsd: number;
};

export function estimateMonthly(chars: number, box: ArmBox = ARM_BOXES[0]): Estimate {
  const audioMinutes = chars / CHARS_PER_AUDIO_MINUTE;
  const elTier =
    ELEVENLABS_TIERS.find((t) => t.charsPerMonth >= chars) ??
    ELEVENLABS_TIERS[ELEVENLABS_TIERS.length - 1];
  // Past the largest tier, extrapolate at the Business $/char rate.
  const elUsd =
    chars <= elTier.charsPerMonth
      ? elTier.usdPerMonth
      : (chars / elTier.charsPerMonth) * elTier.usdPerMonth;
  const boxUsd = box.usdPerHour * HOURS_PER_MONTH;
  const boxCapacityMinutes = box.aggregateRtf * 60 * HOURS_PER_MONTH;
  const savingsUsd = Math.max(0, elUsd - boxUsd);
  return {
    chars,
    audioMinutes,
    elTier,
    elUsd,
    box,
    boxUsd,
    boxCapacityMinutes,
    overCapacity: audioMinutes > boxCapacityMinutes,
    savingsUsd,
    savingsYearUsd: savingsUsd * 12,
  };
}

export function fmtUsd(n: number): string {
  return n >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`;
}

// "You'd have paid $X at ElevenLabs" for a served amount of audio, priced at
// the cheapest tier that covers it (fair: what the same volume costs there).
export function elCostForAudioMinutes(minutes: number): number {
  return estimateMonthly(minutes * CHARS_PER_AUDIO_MINUTE).elUsd;
}

// --- One-line migration snippets -------------------------------------------

export const KEY_PLACEHOLDER = "YOUR_GRAVITONE_KEY";
export const DEFAULT_BASE_URL = "https://your-arm-box.example.com";

export type SnippetLang = "curl" | "python" | "javascript";
export const SNIPPET_LANGS: SnippetLang[] = ["curl", "python", "javascript"];

export function migrationSnippet(
  lang: SnippetLang,
  opts: { baseUrl?: string; apiKey?: string } = {},
): string {
  const base = opts.baseUrl ?? DEFAULT_BASE_URL;
  const key = opts.apiKey ?? KEY_PLACEHOLDER;
  switch (lang) {
    case "curl":
      return [
        `# was: https://api.elevenlabs.io — only the host changes`,
        `curl -X POST "${base}/v1/text-to-speech/alba?output_format=mp3_24000_128" \\`,
        `  -H "xi-api-key: ${key}" -H "Content-Type: application/json" \\`,
        `  -d '{"text": "Same request, no per-character bill."}' \\`,
        `  --output speech.mp3`,
      ].join("\n");
    case "python":
      return [
        `from elevenlabs.client import ElevenLabs`,
        ``,
        `client = ElevenLabs(`,
        `    api_key="${key}",`,
        `    base_url="${base}",  # ← the one-line migration`,
        `)`,
        `audio = client.text_to_speech.convert(voice_id="alba",`,
        `    text="Same request, no per-character bill.")`,
      ].join("\n");
    case "javascript":
      return [
        `const res = await fetch(`,
        `  "${base}/v1/text-to-speech/alba", // ← was api.elevenlabs.io`,
        `  {`,
        `    method: "POST",`,
        `    headers: { "xi-api-key": "${key}", "Content-Type": "application/json" },`,
        `    body: JSON.stringify({ text: "Same request, no per-character bill." }),`,
        `  },`,
        `);`,
        `const audio = await res.arrayBuffer();`,
      ].join("\n");
  }
}
