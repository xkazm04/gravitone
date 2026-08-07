// The gym's data contracts — typed from what service/gym.py and
// service/convai.py actually emit (RUN_SCHEMA / COMPARE_SCHEMA artifacts,
// recording.listing rows, _describe_agent). Nothing here is invented: a field
// the backend reports as null stays nullable, because "absent is absent — a
// turn with no answer_s is not a zero" is the artifact's own rule.

/** A distribution as gym.dist() reports one. Absent measurements are null. */
export type Dist = {
  n: number;
  mean: number | null;
  p50: number | null;
  max: number | null;
};

export type GymTurn = {
  i: number;
  role: "candidate" | "agent" | string;
  text: string;
  /** Only the recorder knows these; a wire-timed run carries nulls. */
  audio_s: number | null;
  transcribe_s: number | null;
  answer_s: number | null;
  interrupted: boolean;
};

export type GymRun = {
  schema: string;
  run_id: string;
  agent_id: string;
  source_recording: string;
  source_name: string;
  conversation_id: string | null;
  /** Which brain answered — scripted and model-driven sound identical. */
  brain: { backend?: string; [k: string]: unknown };
  wire: {
    rate: number;
    frame_ms: number;
    pace: number;
    realtime: boolean;
    polite: boolean;
    audio_s: number;
    frames: number;
    trailing_silence_ms: number;
  };
  /** "recorder" (server-side costs) or "wire" (client-observed only). */
  timings_source: string;
  turns: GymTurn[];
  totals: {
    turns: number;
    candidate_turns: number;
    agent_turns: number;
    interruptions: number;
    answer_s: Dist;
    transcribe_s: Dist;
    audio_s_total: number;
    wall_s: number;
    audio_events: number;
  };
  /** WER vs the source transcript — DRIFT, never accuracy; the note says so. */
  drift_vs_source: {
    available: boolean;
    wer?: number;
    errors?: number;
    reference_words?: number;
    turns?: number;
    why?: string;
    note?: string;
  };
  events: Record<string, number>;
};

export type GymCheck = {
  check: string;
  want: string;
  got: unknown;
  pass: boolean;
};

export type GymComparison = {
  schema: string;
  runs: { a: Record<string, unknown>; b: Record<string, unknown> };
  wer_drift: { wer: number; errors: number; reference_words: number; note: string };
  latency: Record<
    string,
    { a: Dist; b: Dist; delta_mean_s: number | null; delta_pct: number | null; why?: string }
  >;
  interruptions: { a: number; b: number; delta: number };
  agent_text: { changed: { i: number; a: string | null; b: string | null }[]; unchanged: number };
  turn_count: { a: number; b: number; delta: number };
  thresholds: Record<string, number>;
  checks: GymCheck[];
  verdict: "pass" | "fail";
};

/** One row of GET /v1/convai/conversations. */
export type RecordingSummary = {
  conversation_id: string;
  recorded_at: number;
  audio: string[];
  status: "complete" | "in_progress";
  agent_id?: string;
  duration_s?: number;
  turns?: number;
  ended?: string;
  brain?: { backend?: string };
};

export type RecordingsAnswer = {
  /** false when CONVAI_RECORD is off — an empty list then has a WHY. */
  recording: boolean;
  directory: string;
  conversations: RecordingSummary[];
};

/** One agent of GET /v1/convai/agents. */
export type AgentSummary = {
  agent_id: string;
  name: string;
  language: string;
  first_message: string;
  scripted_turns: number;
  keywords: string[];
  allow_overrides: boolean;
  voice_id: string | null;
  tts: string | null;
  speakable: boolean;
  problem?: string;
};

export type AgentsAnswer = {
  agents: AgentSummary[];
  brain: { backend?: string; [k: string]: unknown };
  enabled: boolean;
};

export type ReplayOptions = {
  /** 0 = as fast as the loop can push; 1 = real time (what a latency claim needs). */
  pace: number;
  /** Pause the feed while the agent has the floor (off = test barge-in on purpose). */
  polite: boolean;
  agent_id?: string;
};
