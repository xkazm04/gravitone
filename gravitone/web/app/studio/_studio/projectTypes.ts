// The project lifecycle's nouns — scenes walked through phases. Data lives
// in scenes.ts (story) and score.ts (music + the cut's timeline).

export interface Beat {
  act: 1 | 2 | 3;
  title: string;
  summary: string;
}

export interface SceneLine {
  speaker: string;
  kind: "vo" | "dialogue";
  text: string;
}

export interface FrameCandidate {
  id: string;
  prompt: string;
  model: string;
  tone: string; // mock gradient stops
  note?: string; // why picked / why not
}

export type ClipStatus = "rendered" | "rendering" | "failed" | "not-started";

export interface Clip {
  id: string;
  status: ClipStatus;
  durS?: number;
  model: string;
  motionPrompt: string;
  /** One honest sentence — especially when status is failed/not-started. */
  note: string;
}

export interface Scene {
  id: string;
  index: number; // 1-based, narrative order
  slug: string;
  synopsis: string;
  mood: string;
  targetS: number;
  lines: SceneLine[];
  frames: FrameCandidate[];
  pickedFrameId: string | null;
  clip: Clip | null;
  vfx: string[];
}

export type CueStatus = "rendered" | "failed" | "draft";

export interface Cue {
  id: string;
  title: string;
  mood: string;
  bpm: number;
  startS: number;
  durS: number;
  status: CueStatus;
  model: string;
  note: string;
  sceneSpan: [number, number]; // scene indices covered
}

export type TrackId = "video" | "vo" | "music";

export interface TimelineClip {
  id: string;
  track: TrackId;
  label: string;
  startS: number;
  durS: number;
  status: "ok" | "drift" | "missing";
  offsetMs?: number; // present when status === "drift"
}
