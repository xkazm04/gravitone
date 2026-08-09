import type { EditRegion, Segment } from "./shared";

/** What a committed lane hands back to the console, which owns take ids, the
 *  take log and persistence. */
export type CommitPayload = {
  blob: Blob;
  seconds: number;
  peaks: number[];
  segments: Segment[];
  /** D5 provenance for this patch. */
  region: EditRegion;
  /** Where the patched region sits in the new master, so the console can play
   *  the edit rather than the whole take. */
  start: number;
  /** What the patch render itself cost (the only honest timing a splice has). */
  synthSeconds: number;
  queueSeconds: number;
};
