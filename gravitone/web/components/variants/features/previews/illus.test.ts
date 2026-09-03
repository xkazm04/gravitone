import { describe, expect, it } from "vitest";
import { wavePath, type WaveOpts } from "./illus";

/*
 * `wavePath` is the one piece of the illustration vocabulary that is pure
 * geometry, and the one whose failures are silent: a wave that leaves its box
 * paints over the labels around it, and two waves with mismatched command
 * structure simply refuse to morph — with no error, just a line that jumps.
 * Both are asserted here rather than eyeballed.
 */
const commands = (d: string) => d.match(/[A-Z]/g) ?? [];
const points = (d: string) =>
  d
    .split(/(?=[ML])/)
    .map((seg) => seg.trim().slice(1).split(" ").map(Number))
    .map(([x, y]) => ({ x, y }));

describe("wavePath", () => {
  const base: WaveOpts = { w: 200, h: 60, points: 24 };

  it("emits one moveto followed by linetos, one per sample", () => {
    const cmds = commands(wavePath(base));
    expect(cmds).toHaveLength(24);
    expect(cmds[0]).toBe("M");
    expect(new Set(cmds.slice(1))).toEqual(new Set(["L"]));
  });

  it("spans exactly the requested box horizontally", () => {
    const p = points(wavePath({ ...base, x: 12 }));
    expect(p[0].x).toBe(12);
    expect(p[p.length - 1].x).toBe(212);
  });

  it("stays inside the box vertically, at full amplitude", () => {
    for (const { x, y } of points(wavePath({ ...base, amplitude: 1, points: 200 }))) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(60);
    }
  });

  it("pinches to the midline at both ends when damped", () => {
    const p = points(wavePath({ ...base, damp: 1 }));
    expect(p[0].y).toBeCloseTo(30, 5);
    expect(p[p.length - 1].y).toBeCloseTo(30, 5);
  });

  it("keeps deflection at the edges when undamped", () => {
    const p = points(wavePath({ ...base, damp: 0, phase: Math.PI / 2, frequency: 1 }));
    expect(Math.abs(p[0].y - 30)).toBeGreaterThan(5);
  });

  it("is deterministic — the server and the client draw the same wave", () => {
    expect(wavePath(base)).toBe(wavePath(base));
  });

  it("keeps two waves morph-compatible when they share a point count", () => {
    // Framer tweens `d` by interpolating the numbers inside the string; that
    // only works if the two strings have identical command structure.
    const a = wavePath({ ...base, frequency: 2, amplitude: 0.9 });
    const b = wavePath({ ...base, frequency: 7, amplitude: 0.3, phase: 1.2 });
    expect(a).not.toBe(b);
    expect(commands(a)).toEqual(commands(b));
  });

  it("degenerates safely rather than emitting a broken path", () => {
    // points < 2 would divide by zero in the parameter; it is clamped instead.
    expect(commands(wavePath({ ...base, points: 1 }))).toHaveLength(2);
    const flat = points(wavePath({ ...base, amplitude: 0 }));
    expect(flat.every((p) => p.y === 30)).toBe(true);
  });
});
