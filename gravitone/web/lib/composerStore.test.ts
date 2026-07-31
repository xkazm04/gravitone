import { describe, expect, it } from "vitest";
import { loadComposer, reconcileCharacters, sanitizeComposer, saveComposer, type ComposerState } from "./composerStore";
import { DEFAULT_EXPRESSION } from "@/app/playground/_variants/shared";

const base: ComposerState = {
  text: "hello", script: [], expr: DEFAULT_EXPRESSION, mode: "solo",
  charId: "sarah", activeLine: 0,
};

describe("sanitizeComposer", () => {
  it("restores a well-formed session", () => {
    expect(sanitizeComposer({ ...base, mode: "script", script: [{ id: "l1", characterId: "sarah", text: "hi" }] }))
      .toMatchObject({ text: "hello", mode: "script", charId: "sarah" });
  });

  it("returns null for nothing worth restoring", () => {
    // An empty stored composer must not overwrite the default one.
    expect(sanitizeComposer(null)).toBeNull();
    expect(sanitizeComposer({ text: "   ", script: [], charId: "" })).toBeNull();
  });

  it("refuses a mode it cannot render", () => {
    expect(sanitizeComposer({ ...base, mode: "duet" })?.mode).toBe("solo");
  });

  it("clamps expression values back onto their sliders", () => {
    // A record from an older build (or a hand-edited store) must not put a
    // slider off its scale — the request would be rejected by the backend and
    // the control would render outside its track.
    const s = sanitizeComposer({ ...base, expr: { temperature: 9, stability: -3, quality: 42 } })!;
    expect(s.expr).toEqual({ temperature: 1, stability: 0, quality: 5 });
  });

  it("falls back to defaults for a missing expression", () => {
    expect(sanitizeComposer({ ...base, expr: undefined })!.expr).toEqual(DEFAULT_EXPRESSION);
  });

  it("gives every script line an id and drops junk entries", () => {
    const s = sanitizeComposer({
      ...base,
      script: [{ characterId: "sarah", text: "a" }, null, "nope", { id: "l2", text: 7 }],
    })!;
    expect(s.script).toHaveLength(2);
    expect(s.script[0].id).toBeTruthy();
    expect(s.script[1].text).toBe("");
  });

  it("clamps the active line inside the script", () => {
    const s = sanitizeComposer({ ...base, activeLine: 99, script: [{ id: "l1", characterId: "s", text: "a" }] })!;
    expect(s.activeLine).toBe(0);
  });
});

describe("reconcileCharacters", () => {
  it("keeps a selection that still exists", () => {
    const { state, dropped } = reconcileCharacters(base, ["sarah", "milo"], "milo");
    expect(state.charId).toBe("sarah");
    expect(dropped).toEqual([]);
  });

  it("replaces a deleted Character and REPORTS it", () => {
    // Silently selecting nothing leaves Generate inert; silently substituting a
    // different voice is worse. The caller gets both the repair and the news.
    const { state, dropped } = reconcileCharacters(base, ["milo"], "milo");
    expect(state.charId).toBe("milo");
    expect(dropped).toEqual(["sarah"]);
  });

  it("repairs script lines too, listing each missing Character once", () => {
    const s: ComposerState = {
      ...base, charId: "gone", mode: "script",
      script: [
        { id: "1", characterId: "gone", text: "a" },
        { id: "2", characterId: "milo", text: "b" },
        { id: "3", characterId: "gone", text: "c" },
      ],
    };
    const { state, dropped } = reconcileCharacters(s, ["milo"], "milo");
    expect(state.script.map((l) => l.characterId)).toEqual(["milo", "milo", "milo"]);
    expect(dropped).toEqual(["gone"]);
  });

  it("does not report an empty id as a deleted Character", () => {
    const { dropped } = reconcileCharacters({ ...base, charId: "" }, ["milo"], "milo");
    expect(dropped).toEqual([]);
  });
});

describe("storage failure", () => {
  it("save and load report unavailable storage instead of pretending to work", async () => {
    // jsdom has no IndexedDB — the same shape as a browser in private mode.
    await expect(saveComposer(base)).rejects.toThrow(/IndexedDB unavailable/);
    await expect(loadComposer()).rejects.toThrow(/IndexedDB unavailable/);
  });
});
