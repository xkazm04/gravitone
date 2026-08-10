// The transfer block, read off the wire.
//
// `emotion_basis.transfer_payload()` is the ONE client-facing shape for "how
// well does this emotion travel", and it rides inside `derived_from`. What this
// file pins is the boundary discipline: the three named states survive intact,
// and anything else — an older row with no block at all, a future schema, a
// state this UI has no words for, a "measured" verdict with no number under it
// — becomes ABSENT rather than a fourth state invented here.

import { describe, expect, it, vi } from "vitest";

// The data layer's hooks reach Firebase auth on import; the pure readers under
// test do not, but the module still has to load.
vi.mock("@/lib/useAuth", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/lib/voiceVault", () => ({ recordVoiceOwnership: async () => ({ saved: 0, failed: 0 }) }));

import {
  normalizeCharacter, readTransfer, transferChip,
  type Character, type Voice,
} from "./characters";

const WIRE_MEASURED = {
  state: "measured", quality: 0.72, speakers: 3, in_sample: 2,
  min_quality: 0.5, measured: "2026-08-01", version: 1,
};

describe("readTransfer", () => {
  it("keeps a measured payload whole", () => {
    expect(readTransfer(WIRE_MEASURED)).toEqual({
      state: "measured", quality: 0.72, speakers: 3, in_sample: 2,
      min_quality: 0.5, measured: "2026-08-01", version: 1,
    });
  });

  it("keeps below-bar as its own state rather than collapsing it into measured", () => {
    const t = readTransfer({ ...WIRE_MEASURED, state: "below-bar", quality: 0.31 });
    expect(t?.state).toBe("below-bar");
    expect(t?.quality).toBe(0.31);
  });

  it("carries the unmeasured row WITHOUT inventing a number for it", () => {
    const t = readTransfer({
      state: "unmeasured", quality: null, speakers: 0, in_sample: 0,
      min_quality: 0.5, measured: null, version: 1,
    });
    expect(t?.state).toBe("unmeasured");
    expect(t?.quality).toBeNull(); // never 0 — 0 means "measured and lost"
    expect(t?.speakers).toBe(0);
  });

  it("treats an unknown state as absent, not as a fourth state", () => {
    expect(readTransfer({ ...WIRE_MEASURED, state: "provisional" })).toBeUndefined();
    expect(readTransfer({ quality: 0.9 })).toBeUndefined();
    expect(readTransfer(null)).toBeUndefined();
    expect(readTransfer("measured")).toBeUndefined();
  });

  it("refuses a measured verdict with no number under it", () => {
    // The state is only meaningful AS a verdict on that number; believing half
    // of the pair would put a state on screen with nothing behind it.
    expect(readTransfer({ ...WIRE_MEASURED, quality: null })).toBeUndefined();
  });
});

function wireCharacter(voice: Record<string, unknown>): Character {
  return {
    character_id: "sarah", name: "Sarah", category: "cloned", tags: [], lang: "en",
    emotions: ["angry"], coverage: 1, total: 1,
    voices: [{
      voice_id: "v_d", character_id: "sarah", emotion: "angry", name: "Sarah",
      category: "cloned", lang: "en", ...voice,
    } as unknown as Voice],
  };
}

describe("normalizeCharacter — the transfer block", () => {
  it("normalizes it at the one fetch boundary", () => {
    const c = normalizeCharacter(wireCharacter({
      origin: "derived",
      derived_from: { source: "basis", donor: null, transfer: WIRE_MEASURED },
    }));
    expect(c.voices[0].derived_from?.transfer?.state).toBe("measured");
  });

  it("leaves a row that predates the block with no transfer at all", () => {
    const c = normalizeCharacter(wireCharacter({
      origin: "derived", derived_from: { source: "donor", donor: "mary" },
    }));
    expect(c.voices[0].derived_from).toBeTruthy();
    expect(c.voices[0].derived_from?.transfer).toBeUndefined();
    expect(transferChip(c.voices[0], "Angry")).toBeNull();
  });

  it("says nothing about transfer for a recording", () => {
    const c = normalizeCharacter(wireCharacter({ origin: "recorded" }));
    expect(transferChip(c.voices[0], "Angry")).toBeNull();
  });
});

describe("transferChip", () => {
  it("names the three states and nothing else", () => {
    const chip = (transfer: unknown) => transferChip({
      voice_id: "v", character_id: "c", emotion: "angry", name: "S",
      category: "cloned", lang: "en", origin: "derived",
      derived_from: { source: "basis", transfer: readTransfer(transfer) },
    } as Voice, "Angry");

    expect(chip(WIRE_MEASURED)?.tone).toBe("measured");
    expect(chip({ ...WIRE_MEASURED, state: "below-bar", quality: 0.31 })?.tone).toBe("below");
    expect(chip({ state: "unmeasured", quality: null, speakers: 0, in_sample: 0,
                  min_quality: 0.5, measured: null, version: 1 })?.tone).toBe("unknown");
    expect(chip({ state: "provisional" })).toBeNull();
  });

  it("does not put a number in the unmeasured sentence", () => {
    const c = transferChip({
      voice_id: "v", character_id: "c", emotion: "angry", name: "S",
      category: "cloned", lang: "en", origin: "derived",
      derived_from: { source: "basis", transfer: readTransfer({
        state: "unmeasured", quality: null, speakers: 0, in_sample: 0,
        min_quality: 0.5, measured: null, version: 1 }) },
    } as Voice, "Angry");
    expect(c?.label).toBe("transfer unmeasured");
    expect(`${c?.label} ${c?.title}`).not.toMatch(/\d\.\d/);
  });

  it("reads the singular when exactly one speaker was tested", () => {
    const c = transferChip({
      voice_id: "v", character_id: "c", emotion: "angry", name: "S",
      category: "cloned", lang: "en", origin: "derived",
      derived_from: { source: "basis", transfer: readTransfer({ ...WIRE_MEASURED, speakers: 1 }) },
    } as Voice, "Angry");
    expect(c?.title).toContain("across 1 speaker,");
  });
});
