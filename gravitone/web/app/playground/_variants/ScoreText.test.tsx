import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ScoreText from "./ScoreText";
import { runs } from "./scoreRuns";
import { scoreRegion } from "./playgroundHelpers";

// A highlight overlay is only worth having if it lands on the right characters.
// The two things that can go wrong are (a) the partition is wrong, so colour is
// on the wrong words, and (b) the mirror lays out differently from the textarea,
// so colour is in the wrong PLACE. (a) is pure and tested exhaustively here;
// (b) cannot be reproduced in jsdom (which lays nothing out), so what is tested
// is the DECISION the component makes when it detects it.

const emo = (s: number, e: number, v: string) => scoreRegion(s, e, v);

describe("runs — the partition", () => {
  it("is empty for empty text", () => {
    expect(runs("", [], null)).toEqual([]);
  });

  it("covers the whole text exactly once, in order, with no gaps", () => {
    const text = "Hello there. This part is amazing! And now, back to normal.";
    const parts = runs(text, [emo(13, 33, "excited"), emo(35, 43, "calm")], { start: 5, end: 20 });
    expect(parts[0].start).toBe(0);
    expect(parts[parts.length - 1].end).toBe(text.length);
    for (let i = 1; i < parts.length; i++) expect(parts[i].start).toBe(parts[i - 1].end);
    expect(parts.map((p) => text.slice(p.start, p.end)).join("")).toBe(text);
  });

  it("tags each run with the region that contains it, and nothing else", () => {
    const text = "abcdefghij";
    const parts = runs(text, [emo(2, 5, "sad")], null);
    expect(parts).toEqual([
      { start: 0, end: 2, value: undefined, selected: false },
      { start: 2, end: 5, value: "sad", selected: false },
      { start: 5, end: 10, value: undefined, selected: false },
    ]);
  });

  it("keeps two ADJACENT regions as two runs — they must not read as one span", () => {
    const parts = runs("abcdef", [emo(0, 3, "angry"), emo(3, 6, "calm")], null);
    expect(parts).toEqual([
      { start: 0, end: 3, value: "angry", selected: false },
      { start: 3, end: 6, value: "calm", selected: false },
    ]);
  });

  it("cuts a region where the selection starts, so a partial selection shows as partial", () => {
    const parts = runs("abcdefghij", [emo(0, 6, "whisper")], { start: 3, end: 8 });
    expect(parts).toEqual([
      { start: 0, end: 3, value: "whisper", selected: false },
      { start: 3, end: 6, value: "whisper", selected: true },
      { start: 6, end: 8, value: undefined, selected: true },
      { start: 8, end: 10, value: undefined, selected: false },
    ]);
  });

  it("reads a backwards selection the same as a forwards one", () => {
    expect(runs("abcdef", [], { start: 5, end: 1 })).toEqual(runs("abcdef", [], { start: 1, end: 5 }));
  });

  it("shows NOTHING for a bare caret — there is nothing about to be wrapped", () => {
    expect(runs("abcdef", [], { start: 3, end: 3 })).toEqual([
      { start: 0, end: 6, value: undefined, selected: false },
    ]);
  });

  it("clamps a selection that runs past the end rather than inventing a run", () => {
    const parts = runs("abc", [], { start: 1, end: 99 });
    expect(parts[parts.length - 1].end).toBe(3);
    expect(parts.every((p) => p.end <= 3)).toBe(true);
  });

  it("survives the 8000-character cap without losing a character", () => {
    const text = "x".repeat(8000);
    const regions = Array.from({ length: 40 }, (_, i) => emo(i * 200, i * 200 + 90, "excited"));
    const parts = runs(text, regions, { start: 4000, end: 4500 });
    expect(parts.map((p) => text.slice(p.start, p.end)).join("")).toBe(text);
    expect(parts.filter((p) => p.value === "excited").reduce((n, p) => n + (p.end - p.start), 0)).toBe(40 * 90);
  });
});

describe("ScoreText — the surface", () => {
  const props = {
    text: "Hello there. This part is amazing!",
    regions: [emo(13, 33, "excited")],
    onChangeText: () => {},
    label: "Score text",
  };

  it("mirrors the textarea's characters exactly — the overlay is that text, not a paraphrase", () => {
    render(<ScoreText {...props} />);
    const mirror = screen.getByTestId("score-mirror");
    // The mirror carries a trailing newline so its last line is as tall as the
    // textarea's; everything before it must be the value, character for character.
    expect(mirror.textContent?.replace(/\n$/, "")).toBe(props.text);
    expect((screen.getByLabelText("Score text") as HTMLTextAreaElement).value).toBe(props.text);
  });

  it("paints the directed run and only the directed run", () => {
    render(<ScoreText {...props} />);
    const painted = screen.getByTestId("score-mirror").querySelectorAll("[data-emotion]");
    expect(painted).toHaveLength(1);
    expect(painted[0].textContent).toBe("This part is amazing");
    expect(painted[0].getAttribute("data-emotion")).toBe("excited");
    // Not colour alone: a rule under the span and dark rules down its sides.
    expect((painted[0] as HTMLElement).style.boxShadow).toContain("inset 0 -2px 0");
  });

  it("keeps the selection visible even though the textarea does not have focus", () => {
    render(<ScoreText {...props} selection={{ start: 0, end: 5 }} />);
    const spans = [...screen.getByTestId("score-mirror").querySelectorAll("span")];
    const hello = spans.find((s) => s.textContent === "Hello") as HTMLElement;
    expect(hello).toBeTruthy();
    expect(hello.style.boxShadow).toContain("inset 0 0 0 1px");
  });

  it("is hidden from the accessibility tree — the same words must not be announced twice", () => {
    render(<ScoreText {...props} />);
    expect(screen.getByTestId("score-mirror")).toHaveAttribute("aria-hidden");
  });

  it("WITHDRAWS the paint when the mirror and the textarea lay out differently", () => {
    // Misaligned colour is a confident lie about which words are directed, so
    // the contract is degrade-to-plain, never paint-anyway.
    const spy = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.tagName === "TEXTAREA" ? 200 : 60;
    });
    try {
      render(<ScoreText {...props} selection={{ start: 0, end: 5 }} />);
      const mirror = screen.getByTestId("score-mirror");
      expect(mirror.querySelectorAll("[data-emotion]")).toHaveLength(0);
      expect([...mirror.querySelectorAll("span")].every((s) => !(s as HTMLElement).style.boxShadow)).toBe(true);
      // …but the characters stay, because an emptied mirror could never be
      // measured back into agreement and the overlay would latch off forever.
      expect(mirror.textContent?.replace(/\n$/, "")).toBe(props.text);
    } finally {
      spy.mockRestore();
    }
  });

  it("reports selection changes in plain-text offsets", () => {
    const seen: Array<{ start: number; end: number }> = [];
    render(<ScoreText {...props} onSelectionChange={(s) => seen.push(s)} />);
    const ta = screen.getByLabelText("Score text") as HTMLTextAreaElement;
    ta.setSelectionRange(13, 33);
    fireEvent.select(ta);
    expect(seen.at(-1)).toEqual({ start: 13, end: 33 });
  });
});
