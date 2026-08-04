// The corpus contract's pure half.
//
// What matters here is that the four retention outcomes stay four DIFFERENT
// things on screen: kept, already-kept, not-asked-for, and asked-for-and-failed.
// Collapsing any pair is the bug this surface exists to prevent — a silent
// absence reads identically to a capture that failed, and a capture that failed
// dressed as "nothing was kept" is a lie about someone's voice.
import { afterEach, describe, expect, it, vi } from "vitest";

import { corpusNotice, deleteCorpusClip, formatBytes, loadCorpus, startRederive } from "./corpus";
import type { CorpusOutcome } from "./machine";

const outcome = (over: Partial<CorpusOutcome>): CorpusOutcome =>
  ({ requested: false, captured: false, ...over });

afterEach(() => { vi.unstubAllGlobals(); });

describe("corpusNotice", () => {
  it("says nothing at all when the service said nothing", () => {
    // An older backend omits the key. Absence is not a claim in either
    // direction, so the screen must not make one.
    expect(corpusNotice(undefined)).toBeNull();
    expect(corpusNotice(null)).toBeNull();
    expect(corpusNotice({} as CorpusOutcome)).toBeNull();
  });

  it("itemizes a capture that happened", () => {
    const n = corpusNotice(outcome({
      requested: true, captured: true, segments: 12, stems: 3, bytes: 2_097_152,
    }));
    expect(n?.tone).toBe("kept");
    expect(n?.text).toMatch(/12 segments/);
    expect(n?.text).toMatch(/3 stems/);
    expect(n?.text).toMatch(/2\.0 MB/);
  });

  it("treats 'already in the corpus' as kept, not as a failure", () => {
    // Content-addressed storage finding the same recording already there is the
    // system working; amber would read as something having gone wrong.
    const n = corpusNotice(outcome({
      requested: true, captured: false, already: true,
      reason: "this recording is already in the corpus (content-addressed by clip hash)",
    }));
    expect(n?.tone).toBe("kept");
    expect(n?.text).toMatch(/already in the corpus/);
  });

  it("states 'nothing was kept' quietly when nothing was asked for", () => {
    const n = corpusNotice(outcome({
      requested: false, captured: false,
      reason: "corpus capture was not requested",
    }));
    expect(n?.tone).toBe("quiet");
    expect(n?.text).toMatch(/Nothing of this recording was kept/i);
  });

  it("warns — with the service's own reason — when the ask was not honoured", () => {
    const n = corpusNotice(outcome({
      requested: true, captured: false,
      reason: "corpus capture needs the ownership attestation this clone was made under",
    }));
    expect(n?.tone).toBe("warning");
    expect(n?.text).toMatch(/needs the ownership attestation/);
    // And it must not leave the user thinking the clone failed too.
    expect(n?.text).toMatch(/voices themselves were created/i);
  });

  it("never invents a reason it was not given", () => {
    const n = corpusNotice(outcome({ requested: true, captured: false }));
    expect(n?.text).toMatch(/the backend did not say why/);
  });
});

describe("formatBytes", () => {
  it("reads a size the way a person does", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(200 * 1024 * 1024)).toBe("200 MB");
  });

  it("renders an unmeasured size as absent, never as zero", () => {
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
  });
});

describe("the client calls", () => {
  it("reads the corpus for a character, url-encoded and uncached", async () => {
    const f = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) =>
      new Response(JSON.stringify({ clips: [], totals: { clips: 0 } })));
    vi.stubGlobal("fetch", f);
    await loadCorpus("a b");
    expect(String(f.mock.calls[0][0])).toBe("/api/characters/a%20b/corpus");
    expect((f.mock.calls[0][1] as RequestInit).cache).toBe("no-store");
  });

  it("throws the backend's own detail when a deletion is refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ detail: "no recording with that clip hash is in this character's corpus" }),
      { status: 404 })));
    await expect(deleteCorpusClip("sarah", "abc"))
      .rejects.toThrow(/no recording with that clip hash/);
  });

  it("reads 'Gravitone backend unreachable' out of a 503, per the repo contract", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    await expect(startRederive("sarah")).rejects.toThrow("Gravitone backend unreachable");
  });

  it("omits an empty emotion list rather than asking for nothing", async () => {
    const f = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) =>
      new Response(JSON.stringify({ job_id: "j1", mode: "rederive" })));
    vi.stubGlobal("fetch", f);
    await startRederive("sarah", []);
    expect(JSON.parse(String((f.mock.calls[0][1] as RequestInit).body)))
      .toEqual({ character_id: "sarah" });
    await startRederive("sarah", ["angry"]);
    expect(JSON.parse(String((f.mock.calls[1][1] as RequestInit).body)))
      .toEqual({ character_id: "sarah", emotions: ["angry"] });
  });
});
