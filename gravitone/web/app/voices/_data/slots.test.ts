import { describe, expect, it, vi } from "vitest";

// The module's hooks pull in Firebase auth, which refuses to initialize without
// real keys. Only slot assembly and the delete request are under test here.
vi.mock("@/lib/useAuth", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/lib/voiceVault", () => ({ recordVoiceOwnership: async () => ({ saved: 0, failed: 0 }) }));

import { buildSlots, deleteVoiceReq, type Character, type Voice } from "./characters";

// The registry TOLERATES two voices on one emotion (service/voices.py::_by_emotion)
// so the extra one stays deletable. Slot assembly used to `.find()` the first
// match, which gave the shadowed voice no row, no id and no remove button — the
// API kept the duplicate fixable and the UI was the reason it wasn't.

function voice(id: string, emotion: string): Voice {
  return {
    voice_id: id, character_id: "sarah", emotion, name: "Sarah",
    category: "cloned", lang: "en", created: null, sample_seconds: 4,
  };
}

/** A Character as the backend hands it over: voices already sorted into scale
 *  order, coverage counting DISTINCT emotions. */
function character(voices: Voice[]): Character {
  const emotions = voices.map((v) => v.emotion);
  return {
    character_id: "sarah", name: "Sarah", category: "cloned", tags: [], lang: "en",
    voices, emotions, coverage: new Set(emotions).size, total: 8,
    scale: ["baseline", "angry"],
  };
}

describe("buildSlots — a duplicate you can see is a duplicate you can delete", () => {
  it("keeps an ordinary one-voice slot exactly as it was", () => {
    const only = voice("v_base", "baseline");
    const slots = buildSlots(character([only]));

    expect(slots.map((s) => s.emotion)).toEqual(["baseline", "angry"]);
    expect(slots[0].voice).toBe(only);
    expect(slots[0].voices).toEqual([only]); // no extra rows to render
    expect(slots[1].voice).toBeNull();
    expect(slots[1].voices).toEqual([]);
  });

  it("surfaces BOTH voices of a doubled slot, speaker first", () => {
    const speaks = voice("v_first", "angry");
    const shadow = voice("v_second", "angry");
    const slots = buildSlots(character([voice("v_base", "baseline"), speaks, shadow]));

    const angry = slots.find((s) => s.emotion === "angry")!;
    expect(angry.voices).toEqual([speaks, shadow]);
    // The speaking voice is the backend's answer (first in the list it sorted
    // into scale order), not a rule re-derived in the browser.
    expect(angry.voice).toBe(speaks);
  });

  it("counts coverage by distinct emotions, so a duplicate never inflates it", () => {
    const slots = buildSlots(character([voice("a", "angry"), voice("b", "angry")]));
    expect(slots.filter((s) => s.voice).length).toBe(1);
  });

  it("falls back to the base scale before the character has loaded", () => {
    expect(buildSlots(null).length).toBeGreaterThan(0);
    expect(buildSlots(null).every((s) => s.voice === null && s.voices.length === 0)).toBe(true);
  });

  it("deleting the shadowed voice resolves the duplicate and leaves the speaker", async () => {
    const speaks = voice("v_first", "angry");
    const shadow = voice("v_second", "angry");
    const before = character([speaks, shadow]);
    expect(buildSlots(before).find((s) => s.emotion === "angry")!.voices).toHaveLength(2);

    const f = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", f);
    await deleteVoiceReq(shadow.voice_id);
    expect(f).toHaveBeenCalledWith("/api/voices/v_second", { method: "DELETE" });

    // Server truth after that delete: the slot is single-voice again and the
    // voice that speaks it is untouched.
    const after = buildSlots(character([speaks])).find((s) => s.emotion === "angry")!;
    expect(after.voices).toEqual([speaks]);
    expect(after.voice).toBe(speaks);
    vi.unstubAllGlobals();
  });
});
