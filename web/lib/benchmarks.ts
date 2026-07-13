// Benchmark-proof dataset + sizing math for the public /benchmarks page.
//
// Every entry is a MEASURED run of the reproducible harness
// (gravitone/benchmark_arm.sh → service/loadtest.py), transcribed from the
// "Measured performance" table in gravitone/README.md. Anyone with an AWS
// account can regenerate a row — that reproducibility is the point.
//
// Key fact the math leans on (README "Two findings that generalise"):
// throughput scales by PROCESS/REPLICA, not in-process workers — the model is
// GIL-bound. So a box's capacity is its multi-process aud/s, and the
// recommended config is N single-worker processes with vCPU/N torch threads.

import { ELEVENLABS_TIERS, CHARS_PER_AUDIO_MINUTE } from "./switchkit";

export type BenchmarkEntry = {
  id: string;
  platform: string; // human name for the leaderboard row
  cpu: string;
  instance: string | null; // null = not a purchasable cloud box (reference row)
  vcpu: number;
  usdPerHour: number | null; // on-demand list price; null for reference rows
  singleStreamRtf: number; // audio-seconds per compute-second, one stream
  multiProcessAudPerS: number | null; // measured process-scaled throughput
  processes: number | null; // process count used for the scaled figure
  cpuAtCeilingPct: number | null;
  notes: string;
};

export const HARNESS = {
  method: "bash benchmark_arm.sh → python -m service.loadtest (ramp to the degradation knee)",
  torch: "bf16, CPU-index ARM torch (oneDNN + Arm Compute Library)",
  measured: "2026-07 (gravitone/README.md, 'Measured performance')",
  reproduce: "git clone the repo on any Arm64 box and run: bash benchmark_arm.sh",
};

export const BENCHMARKS: BenchmarkEntry[] = [
  {
    id: "c8g-2xlarge",
    platform: "AWS Graviton4",
    cpu: "Neoverse V2",
    instance: "c8g.2xlarge",
    vcpu: 8,
    usdPerHour: 0.2903,
    singleStreamRtf: 4.26,
    multiProcessAudPerS: 10.9,
    processes: 4,
    cpuAtCeilingPct: 46,
    notes: "production pick — a 3s sentence renders in ~0.7s",
  },
  {
    id: "t4g-small",
    platform: "AWS Graviton2",
    cpu: "Neoverse N1",
    instance: "t4g.small",
    vcpu: 2,
    usdPerHour: 0.0168,
    singleStreamRtf: 1.33,
    multiProcessAudPerS: null, // only single-stream measured; assume ~1 stream
    processes: null,
    cpuAtCeilingPct: null,
    notes: "free-tier eligible, burstable — the demo-site default",
  },
  {
    id: "dev-arm64",
    platform: "Windows-ARM64 dev box",
    cpu: "Snapdragon-class",
    instance: null,
    vcpu: 12,
    usdPerHour: null,
    singleStreamRtf: 1.9,
    multiProcessAudPerS: 4.14,
    processes: 4,
    cpuAtCeilingPct: null,
    notes: "unoptimized reference — proves it is not cloud magic",
  },
];

/** aud/s a box can sustain (multi-process figure, single-stream fallback). */
export function boxCapacityAudPerS(b: BenchmarkEntry): number {
  return b.multiProcessAudPerS ?? b.singleStreamRtf;
}

/** $ per audio-hour on a box running flat out. */
export function costPerAudioHour(b: BenchmarkEntry): number | null {
  if (b.usdPerHour == null) return null;
  return b.usdPerHour / boxCapacityAudPerS(b);
}

/** ElevenLabs $ per audio-hour by tier (chars ≈ credits, 1k chars ≈ 1 min). */
export function elCostPerAudioHour(tierName: string): number | null {
  const t = ELEVENLABS_TIERS.find((x) => x.name === tierName);
  if (!t || t.usdPerMonth === 0) return null;
  const audioHours = t.charsPerMonth / CHARS_PER_AUDIO_MINUTE / 60;
  return t.usdPerMonth / audioHours;
}

// --- Capacity planner --------------------------------------------------------

export type Plan = {
  need: { audPerS: number; concurrentStreams: number; dailyAudioMinutes: number };
  box: BenchmarkEntry;
  replicas: number; // single-worker processes across the fleet
  instances: number; // boxes to rent
  perProcess: { workers: number; torchThreads: number; queueMax: number };
  monthlyUsd: number;
  headroomPct: number; // capacity above the requirement
  elMonthlyUsd: number | null; // same volume at the cheapest covering EL tier
};

const HOURS_PER_MONTH = 730;
// Traffic is bursty: provision for 4× the day's average arrival rate.
const PEAK_FACTOR = 4;

export function planCapacity(concurrentStreams: number, dailyAudioMinutes: number): Plan {
  const avgAudPerS = (dailyAudioMinutes * 60) / 86_400;
  // Each live stream consumes 1 audio-second per second to stay realtime.
  const need = Math.max(concurrentStreams, avgAudPerS * PEAK_FACTOR, 0.1);

  // Smallest purchasable box that covers the need in one instance wins;
  // otherwise scale the production box horizontally.
  const buyable = BENCHMARKS.filter((b) => b.instance && b.usdPerHour != null);
  const single = buyable
    .filter((b) => boxCapacityAudPerS(b) >= need)
    .sort((a, b) => (a.usdPerHour! - b.usdPerHour!))[0];
  const box = single ?? buyable.sort((a, b) => boxCapacityAudPerS(b) - boxCapacityAudPerS(a))[0];

  const instances = Math.max(1, Math.ceil(need / boxCapacityAudPerS(box)));
  const processesPerBox = box.processes ?? 1;
  const torchThreads = Math.max(1, Math.floor(box.vcpu / processesPerBox));

  const capacity = instances * boxCapacityAudPerS(box);
  const monthlyUsd = instances * box.usdPerHour! * HOURS_PER_MONTH;

  const monthlyChars = dailyAudioMinutes * 30 * CHARS_PER_AUDIO_MINUTE;
  const elTier = ELEVENLABS_TIERS.find((t) => t.charsPerMonth >= monthlyChars);
  const last = ELEVENLABS_TIERS[ELEVENLABS_TIERS.length - 1];
  const elMonthlyUsd = monthlyChars <= 0
    ? null
    : elTier
      ? elTier.usdPerMonth
      : (monthlyChars / last.charsPerMonth) * last.usdPerMonth;

  return {
    need: { audPerS: need, concurrentStreams, dailyAudioMinutes },
    box,
    replicas: instances * processesPerBox,
    instances,
    perProcess: { workers: 1, torchThreads, queueMax: 32 },
    monthlyUsd,
    headroomPct: Math.round((capacity / need - 1) * 100),
    elMonthlyUsd,
  };
}

/** The exact env vars the plan translates to — copyable, CLI-parity output. */
export function planEnvBlock(p: Plan): string {
  const procs = p.box.processes ?? 1;
  return [
    `# ${p.instances}× ${p.box.instance} (${p.box.platform}, ${p.box.vcpu} vCPU) — ${p.replicas} single-worker processes`,
    `TTS_WORKERS=${p.perProcess.workers}`,
    `TTS_TORCH_THREADS=${p.perProcess.torchThreads}`,
    `TTS_QUEUE_MAX=${p.perProcess.queueMax}`,
    `# run ${procs} processes per box (ports 8080-${8079 + procs}) behind a load balancer;`,
    `# scale by process/replica, not in-process workers — the model is GIL-bound.`,
  ].join("\n");
}
