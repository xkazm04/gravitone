// From a video to a scene: the payload → composer session mapping, and the
// sentences the hand-off owes the user about what it left out.

import { describe, expect, it } from "vitest";
import { DEFAULT_EXPRESSION, DEFAULT_TEXT, MAX_SCRIPT_LINES } from "@/app/playground/_variants/playgroundHelpers";
import { sanitizeComposer } from "@/lib/composerStore";
import { sceneCastSummary, sceneComposer, sceneNotes, type Scene } from "./scene";

const SCENE: Scene = {
  available: true,
  lines: [
    { speaker: "speaker_0", character_id: "ada", text: "You said you would call." },
    { speaker: "speaker_1", character_id: "bo", text: "I did call." },
    { speaker: "speaker_0", character_id: "ada", text: "Not once." },
  ],
  total_lines: 3, truncated: false, max_lines: 64, omitted: [],
  names: { ada: "Ada", bo: "Bo" },
};

describe("sceneComposer", () => {
  it("becomes a script-mode session with each line on its own Character", () => {
    const state = sceneComposer(SCENE)!;
    expect(state.mode).toBe("script");
    expect(state.script.map((l) => l.characterId)).toEqual(["ada", "bo", "ada"]);
    expect(state.script.map((l) => l.text)).toEqual([
      "You said you would call.", "I did call.", "Not once.",
    ]);
    // Unique ids: a collision would break React keys and reordering.
    expect(new Set(state.script.map((l) => l.id)).size).toBe(3);
    // The rail follows the top of the script, not whatever was selected before.
    expect(state.charId).toBe("ada");
    expect(state.expr).toEqual(DEFAULT_EXPRESSION);
    // Flipping back to solo must not land in an empty box.
    expect(state.text).toBe(DEFAULT_TEXT);
    expect(state.activeLine).toBe(0);
  });

  it("survives the store's own sanitizer unchanged — no new contract", () => {
    const state = sceneComposer(SCENE)!;
    expect(sanitizeComposer(state)).toEqual(state);
  });

  it("is nothing at all when there is no scene to open", () => {
    expect(sceneComposer({ available: false, reason: "no transcript" })).toBeNull();
    expect(sceneComposer({ available: true, lines: [] })).toBeNull();
  });
});

describe("sceneNotes", () => {
  it("says nothing when nothing was left out", () => {
    expect(sceneNotes(SCENE)).toEqual([]);
  });

  it("names BOTH numbers when the script was truncated", () => {
    const note = sceneNotes({ ...SCENE, truncated: true, total_lines: 210,
      max_lines: MAX_SCRIPT_LINES })[0];
    expect(note).toMatch(/first 3 lines of 210/);
    expect(note).toMatch(new RegExp(`${MAX_SCRIPT_LINES} lines`));
  });

  it("states an uncast speaker's lines as omitted, with a reason", () => {
    const note = sceneNotes({ ...SCENE, omitted: [{ speaker: "speaker_2", segments: 7 }] })[0];
    expect(note).toMatch(/speaker_2 \(7\)/);
    expect(note).toMatch(/not cast/);
  });

  it("carries one note per thing it did", () => {
    expect(sceneNotes({ ...SCENE, truncated: true,
      omitted: [{ speaker: "speaker_2", segments: 1 }] })).toHaveLength(2);
  });
});

describe("sceneCastSummary", () => {
  it("counts lines per Character, by name", () => {
    expect(sceneCastSummary(SCENE)).toBe("Ada · 2 lines  ·  Bo · 1 line");
  });

  it("falls back to the id rather than rendering 'undefined'", () => {
    expect(sceneCastSummary({ ...SCENE, names: {} })).toContain("ada · 2 lines");
  });
});
