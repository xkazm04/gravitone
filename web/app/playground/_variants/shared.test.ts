import { describe, expect, it } from "vitest";
import { composerLimit, MAX_SCRIPT_LINES, MAX_TEXT_CHARS, stripTags } from "./shared";

const line = (text: string) => ({ text });

describe("composerLimit — the ceiling, before the request", () => {
  it("passes an ordinary take", () => {
    expect(composerLimit({ mode: "solo", text: "hello there", script: [] })).toBeNull();
  });

  it("counts metatags: the backend measures the raw text, not the spoken words", () => {
    // stripTags() is the right length for the AUDIO estimate and the wrong one
    // for the limit — the tags are sent.
    const tagged = `[excited]${"a".repeat(MAX_TEXT_CHARS - 10)}[/excited]`;
    expect(stripTags(tagged).length).toBeLessThan(MAX_TEXT_CHARS);
    expect(composerLimit({ mode: "solo", text: tagged, script: [] })).toMatch(/over the/);
  });

  it("says how far over the solo limit the text is", () => {
    const msg = composerLimit({ mode: "solo", text: "a".repeat(MAX_TEXT_CHARS + 5), script: [] });
    expect(msg).toContain("5 over");
  });

  it("names the offending script line", () => {
    const msg = composerLimit({
      mode: "script", text: "",
      script: [line("ok"), line("b".repeat(MAX_TEXT_CHARS + 1))],
    });
    expect(msg).toMatch(/^Line 2 /);
  });

  it("blocks a script past the engine's line cap", () => {
    const msg = composerLimit({
      mode: "script", text: "",
      script: Array.from({ length: MAX_SCRIPT_LINES + 1 }, () => line("hi")),
    });
    expect(msg).toContain(`at most ${MAX_SCRIPT_LINES}`);
  });

  it("blocks a body the studio's proxy would reject with a bare 413", () => {
    // Every line is legal on its own; together they exceed the 128 KB the proxy
    // forwards, which used to surface as "request body too large" and nothing
    // about which line to shorten.
    const msg = composerLimit({
      mode: "script", text: "",
      script: Array.from({ length: 40 }, () => line("c".repeat(4000))),
    });
    expect(msg).toMatch(/KB/);
  });

  it("ignores the script while in solo mode, and the solo text while in script mode", () => {
    const huge = [line("d".repeat(MAX_TEXT_CHARS + 1))];
    expect(composerLimit({ mode: "solo", text: "fine", script: huge })).toBeNull();
    expect(composerLimit({ mode: "script", text: "e".repeat(MAX_TEXT_CHARS + 1), script: [line("fine")] })).toBeNull();
  });
});
