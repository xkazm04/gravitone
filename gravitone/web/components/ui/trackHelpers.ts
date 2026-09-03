// Pure arithmetic and formatting for the rail. Nothing here touches the DOM or
// React — it is the part of <Track> that can be reasoned about on paper.

/** How far one arrow press moves the playhead (fraction of the whole rail). */
export const STEP = 0.02;
/** …and one Page press. */
export const PAGE = 0.1;

export const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** m:ss for a duration in seconds. */
export function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const s = Math.floor(seconds % 60);
  return `${Math.floor(seconds / 60)}:${s < 10 ? "0" : ""}${s}`;
}
