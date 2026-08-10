// The studio's nouns, as the scope doc (docs/studio-scope.md) defines them.
// Prototype round: these shapes are the DESIGN of the future /v1/assets and
// agent-run contracts, mocked in mock.ts — nothing here talks to a backend.

export type AssetKind = "image" | "audio" | "video" | "script";

/** A caption is written, on its way, or failed — and a failure says why.
 *  A missing caption rendered as a silent blank is the named anti-shape. */
export type CaptionStatus = "written" | "pending" | "failed";

export interface Provenance {
  source: "upload" | "generated";
  /** The mouth or model that made it: imagen-3, lyria-3, gemini-3.1-flash-tts,
   *  pocket-tts:marla ... absent for uploads. */
  model?: string;
  prompt?: string;
  /** The agent run + step that produced it — the lineage the library renders. */
  runId?: string;
  stepId?: string;
  parentIds: string[];
}

export interface Asset {
  id: string;
  kind: AssetKind;
  title: string;
  mime: string;
  bytes: number;
  createdAt: string; // ISO
  durationS?: number; // audio/video
  dims?: string; // image/video, e.g. "1920×1080"
  caption: string | null;
  captionStatus: CaptionStatus;
  captionError?: string; // authored copy when status === "failed"
  tags: string[];
  collection: string;
  provenance: Provenance;
  /** Mock-only: tailwind gradient stops for the placeholder preview. */
  tone: string;
}

export type StepStatus = "done" | "failed" | "running" | "queued";

export interface RunStep {
  id: string;
  title: string;
  /** The tool the agent called, named like the MCP surface will name it. */
  tool: string;
  model?: string;
  status: StepStatus;
  /** One honest sentence about what happened — including failures. */
  detail: string;
  outputAssetIds: string[];
  durationS?: number;
}

export type RunStatus = "running" | "finished" | "finished-with-failures";

export interface AgentRun {
  id: string;
  brief: string;
  status: RunStatus;
  startedAt: string;
  steps: RunStep[];
}
