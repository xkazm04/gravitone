import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import ScriptScore from "./ScriptScore";
import { characterHue, type ScriptLine } from "./shared";

// A scene is N strings the console owns. Every test here asserts on the STRINGS
// that come back out — if the lanes and the script ever disagree, the user
// renders a performance they did not direct.

const SCRIPT: ScriptLine[] = [
  { id: "a", characterId: "sarah", text: "one [excited]two[/excited] three" },
  { id: "b", characterId: "malik", text: "hello there" },
];

function Host({
  initial = SCRIPT,
  ...rest
}: { initial?: ScriptLine[] } & Partial<React.ComponentProps<typeof ScriptScore>>) {
  const [lines, setLines] = useState(initial);
  return (
    <>
      <ScriptScore
        lines={lines}
        onChangeLine={(id, next) => setLines((ls) => ls.map((l) => (l.id === id ? { ...l, text: next } : l)))}
        characterName={(id) => ({ sarah: "Sarah", malik: "Malik" })[id] ?? id}
        availableFor={() => ["baseline", "excited"]}
        scale={["excited", "whisper"]}
        {...rest}
      />
      <output data-testid="wire">{lines.map((l) => `${l.id}=${l.text}`).join(" | ")}</output>
    </>
  );
}

const mount = (over: Partial<React.ComponentProps<typeof ScriptScore>> & { initial?: ScriptLine[] } = {}) =>
  render(<Host {...over} />);

const wire = () => screen.getByTestId("wire").textContent ?? "";
const lane = (n: number) => screen.getByRole("button", { name: new RegExp(`^Line ${n},`) });
const notice = () => document.querySelector("[aria-live]")?.textContent ?? "";

describe("ScriptScore — the scene as stacked lanes", () => {
  it("draws one lane per line, named by its Character", () => {
    mount();
    expect(lane(1)).toHaveAccessibleName(/Sarah/);
    expect(lane(2)).toHaveAccessibleName(/Malik/);
    expect(screen.getByRole("group", { name: /Line 1, Sarah — 1 directed span/ })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Line 2, Malik — 0 directed spans/ })).toBeInTheDocument();
  });

  it("shows each line's directed spans over its own text, not the tagged string", () => {
    mount();
    const region = screen.getByRole("button", { name: /Region 1 of 1/ });
    // offsets are into "one two three", i.e. the text WITHOUT its tags
    expect(region).toHaveAccessibleName(/characters 4 to 7/);
    expect(region).toHaveAccessibleName(/text: two/);
  });

  it("tints each Character's lane with that Character's own hue", () => {
    expect(characterHue("sarah")).not.toBe(characterHue("malik"));
    expect(characterHue("sarah")).toBe(characterHue("sarah"));
  });

  it("takes you to the line in the composer when its lane is clicked", () => {
    const onFocusLine = vi.fn();
    mount({ onFocusLine });
    fireEvent.click(lane(2));
    expect(onFocusLine).toHaveBeenCalledWith("b", 1);
  });

  it("walks the lanes with the arrow keys", () => {
    mount();
    lane(1).focus();
    fireEvent.keyDown(lane(1), { key: "ArrowDown" });
    expect(document.activeElement).toBe(lane(2));
    fireEvent.keyDown(lane(2), { key: "ArrowUp" });
    expect(document.activeElement).toBe(lane(1));
    fireEvent.keyDown(lane(1), { key: "End" });
    expect(document.activeElement).toBe(lane(2));
  });

  it("nudges a region's edge from the keyboard and writes only that line back", () => {
    mount();
    fireEvent.keyDown(screen.getByRole("slider", { name: /Excited region end/ }), { key: "ArrowRight" });
    expect(wire()).toBe("a=one [excited]two [/excited]three | b=hello there");
  });

  it("directs a whole line, then keeps the rest of the script untouched", () => {
    mount({ activeLineId: "b" });
    fireEvent.click(screen.getByRole("button", { name: /direct this whole line/ }));
    expect(wire()).toBe("a=one [excited]two[/excited] three | b=[excited]hello there[/excited]");
  });

  it("refuses an overlapping placement by name instead of dropping it", () => {
    mount({ initial: [{ id: "a", characterId: "sarah", text: "one [excited]two[/excited] three" }], activeLineId: "a" });
    fireEvent.click(screen.getByRole("button", { name: /direct this whole line/ }));
    expect(notice()).toMatch(/overlaps the excited region/);
    expect(wire()).toBe("a=one [excited]two[/excited] three");
  });

  it("retags a selected region through the same grammar", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Region 1 of 1/ }));
    fireEvent.change(screen.getByRole("combobox", { name: /Emotion for the selected region on line 1/ }), {
      target: { value: "whisper" },
    });
    expect(wire()).toMatch(/a=one \[whisper\]two\[\/whisper\] three/);
  });

  it("moves an edge from the numeric field, the accessible path", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Region 1 of 1/ }));
    fireEvent.change(screen.getByRole("spinbutton", { name: /Region start on line 1/ }), {
      target: { value: "0" },
    });
    expect(wire()).toMatch(/a=\[excited\]one two\[\/excited\] three/);
  });

  it("says what a deletion did, and returns those words to baseline", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Region 1 of 1/ }));
    fireEvent.click(screen.getByRole("button", { name: "delete" }));
    expect(wire()).toBe("a=one two three | b=hello there");
    expect(notice()).toMatch(/Removed the Excited region from line 1/);
  });

  it("draws no rail for a line with no words yet", () => {
    mount({ initial: [{ id: "a", characterId: "sarah", text: "" }] });
    expect(screen.queryByRole("group", { name: /Line 1/ })).not.toBeInTheDocument();
    expect(screen.getByText(/No words on this line yet/)).toBeInTheDocument();
  });

  it("renders nothing at all for an empty script", () => {
    const { container } = render(<ScriptScore lines={[]} onChangeLine={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("dims the badge of an emotion the Character has not recorded", () => {
    mount({ availableFor: () => ["baseline"] });
    // the region still draws — the engine substitutes; the score does not hide it
    expect(screen.getByRole("button", { name: /Region 1 of 1/ })).toBeInTheDocument();
  });
});
