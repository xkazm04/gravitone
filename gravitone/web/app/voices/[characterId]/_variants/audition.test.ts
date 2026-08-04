// What the emotion audition PROMISES, pinned.
//
// The whole feature is an honesty argument, so the tests are about the ways it
// could quietly stop being honest: dropping a voice under backpressure,
// reporting a queue-full as a broken voice, leaving a tile spinning, comparing
// two takes of different text, or re-rendering audio it already holds.
import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineBusyError } from "@/lib/engineSeam";
import {
  auditionKey, cachedAudition, clearAuditionCache, runAudition, storeAudition,
  type AuditionCell, type AuditionTarget,
} from "./audition";

afterEach(() => clearAuditionCache());

const LINE = "the same line, every time";

function targets(...emotions: string[]): AuditionTarget[] {
  return emotions.map((e) => ({ emotion: e, label: e, voiceId: `v_${e}` }));
}

/** Collect every transition per emotion, so a test can assert what the user
 *  actually saw and not merely where things landed. */
function recorder() {
  const seen: Record<string, AuditionCell[]> = {};
  const set = (emotion: string, cell: AuditionCell) => {
    (seen[emotion] ??= []).push(cell);
  };
  const kinds = (e: string) => (seen[e] ?? []).map((c) => c.kind);
  const last = (e: string) => (seen[e] ?? []).at(-1);
  return { seen, set, kinds, last };
}

const blob = (s = "audio") => new Blob([s], { type: "audio/wav" });

describe("runAudition — the whole scale, one line", () => {
  it("renders every voice on the SAME line and reports each one ready", async () => {
    const lines: string[] = [];
    const r = recorder();
    await runAudition(targets("baseline", "happy", "sad"), LINE,
      new AbortController().signal, r.set, {
        render: async (_v, line) => { lines.push(line); return blob(); },
      });

    expect(lines).toEqual([LINE, LINE, LINE]);
    for (const e of ["baseline", "happy", "sad"]) {
      expect(r.last(e)).toEqual({ kind: "ready", cached: false });
    }
  });

  it("holds concurrency to the bound — the engine 429s past its admission", async () => {
    let live = 0, peak = 0;
    const r = recorder();
    await runAudition(targets("a", "b", "c", "d", "e"), LINE,
      new AbortController().signal, r.set, {
        concurrency: 2,
        render: async () => {
          live++; peak = Math.max(peak, live);
          await new Promise((res) => setTimeout(res, 5));
          live--;
          return blob();
        },
      });
    expect(peak).toBe(2);
  });

  it("waits out backpressure and still renders the voice — never a silent drop", async () => {
    vi.useFakeTimers();
    try {
      const r = recorder();
      let calls = 0;
      const run = runAudition(targets("angry"), LINE,
        new AbortController().signal, r.set, {
          render: async () => {
            calls++;
            if (calls === 1) throw new EngineBusyError(2);
            return blob();
          },
        });
      await vi.advanceTimersByTimeAsync(3000);
      await run;

      // The countdown was VISIBLE, second by second, and named the attempt.
      const waits = (r.seen.angry ?? []).filter((c) => c.kind === "waiting");
      expect(waits.map((c) => (c as { seconds: number }).seconds)).toEqual([2, 1]);
      expect(calls).toBe(2);
      expect(r.last("angry")).toEqual({ kind: "ready", cached: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on endless backpressure by NAMING it, not by blaming the voice", async () => {
    vi.useFakeTimers();
    try {
      const r = recorder();
      const run = runAudition(targets("angry"), LINE,
        new AbortController().signal, r.set, {
          busyRetries: 2,
          render: async () => { throw new EngineBusyError(1); },
        });
      await vi.advanceTimersByTimeAsync(10_000);
      await run;
      const last = r.last("angry");
      expect(last?.kind).toBe("failed");
      expect((last as { reason: string }).reason).toContain("capacity");
    } finally {
      vi.useRealTimers();
    }
  });

  it("puts a failure on the tile that earned it and keeps auditioning the rest", async () => {
    const r = recorder();
    await runAudition(targets("baseline", "sad"), LINE,
      new AbortController().signal, r.set, {
        concurrency: 1,
        render: async (voiceId) => {
          if (voiceId === "v_sad") throw new Error("the voice registry is unreadable");
          return blob();
        },
      });
    expect(r.last("baseline")).toEqual({ kind: "ready", cached: false });
    expect(r.last("sad")).toEqual({
      kind: "failed", reason: "the voice registry is unreadable",
    });
  });

  it("leaves no tile mid-sentence when the run is stopped", async () => {
    const ctrl = new AbortController();
    const r = recorder();
    const run = runAudition(targets("a", "b", "c", "d"), LINE, ctrl.signal, r.set, {
      concurrency: 1,
      render: async () => { ctrl.abort(); return blob(); },
    });
    await run;
    // Nothing is left on "queued" — every cell settled at ready or idle.
    for (const e of ["a", "b", "c", "d"]) {
      expect(["ready", "idle"]).toContain(r.last(e)?.kind);
    }
  });

  it("re-auditioning is free — a held take is replayed, never re-rendered", async () => {
    let calls = 0;
    const render = async () => { calls++; return blob(); };
    const first = recorder();
    await runAudition(targets("happy"), LINE, new AbortController().signal, first.set, { render });
    expect(calls).toBe(1);

    const again = recorder();
    await runAudition(targets("happy"), LINE, new AbortController().signal, again.set, { render });
    expect(calls).toBe(1);
    // And it SAYS it was free, so the "rendered once" claim is visible.
    expect(again.last("happy")).toEqual({ kind: "ready", cached: true });
  });

  it("a different line is a different experiment — the cache never crosses over", async () => {
    let calls = 0;
    const render = async () => { calls++; return blob(); };
    const r = recorder();
    await runAudition(targets("happy"), LINE, new AbortController().signal, r.set, { render });
    await runAudition(targets("happy"), "a different line",
      new AbortController().signal, r.set, { render });
    expect(calls).toBe(2);
  });
});

describe("the take cache", () => {
  it("keys on the voice AND the line", () => {
    expect(auditionKey("v", "a")).not.toBe(auditionKey("v", "b"));
    expect(auditionKey("v1", "a")).not.toBe(auditionKey("v2", "a"));
  });

  it("hands back what it stored, and nothing for what it did not", () => {
    const b = blob("x");
    storeAudition("v_happy", LINE, b);
    expect(cachedAudition("v_happy", LINE)).toBe(b);
    expect(cachedAudition("v_happy", "other line")).toBeNull();
    expect(cachedAudition("v_sad", LINE)).toBeNull();
  });
});
