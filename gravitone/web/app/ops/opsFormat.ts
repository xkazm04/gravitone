// Number → string, with absence preserved: every formatter returns null for a
// value the engine has not measured, so the tile can draw an em dash instead of
// a zero.

export function fmtSeconds(v: number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`;
}

export function fmtCount(v: number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return v.toLocaleString("en-US");
}
