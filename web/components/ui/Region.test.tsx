import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import Region from "./Region";

// M2's second named risk: "drag interactions must stay keyboard- and
// touch-operable or the feature is exclusionary". So the keyboard path is the
// one under test here, edge by edge.

function mount(over: Partial<React.ComponentProps<typeof Region>> = {}) {
  const onResize = vi.fn();
  const onSelect = vi.fn();
  const onPreview = vi.fn();
  render(
    <Region
      start={4} end={7} total={13} hue={20}
      label="Excited" text="two" index={0} count={2}
      onResize={onResize} onSelect={onSelect} onPreview={onPreview}
      offsetAt={(x) => Math.round(x / 10)}
      {...over}
    />,
  );
  return { onResize, onSelect, onPreview };
}

const startHandle = () => screen.getByRole("slider", { name: /region start/i });
const endHandle = () => screen.getByRole("slider", { name: /region end/i });

describe("Region — a span you can move without a mouse", () => {
  it("places itself proportionally over the character range", () => {
    mount();
    const body = screen.getByRole("button").parentElement as HTMLElement;
    expect(body.style.left).toBe(`${(4 / 13) * 100}%`);
    expect(body.style.width).toBe(`${(3 / 13) * 100}%`);
  });

  it("says which region it is, where it is and what it covers", () => {
    mount();
    const body = screen.getByRole("button");
    expect(body).toHaveAccessibleName(/Region 1 of 2/);
    expect(body).toHaveAccessibleName(/characters 4 to 7/);
    expect(body).toHaveAccessibleName(/text: two/);
  });

  it("exposes each edge as a slider over character offsets", () => {
    mount();
    expect(startHandle()).toHaveAttribute("aria-valuenow", "4");
    expect(startHandle()).toHaveAttribute("aria-valuemax", "13");
    expect(endHandle()).toHaveAttribute("aria-valuenow", "7");
    expect(endHandle()).toHaveAttribute("aria-valuetext", "character 7 of 13");
  });

  it("nudges an edge by one character with an arrow key", () => {
    const { onResize } = mount();
    fireEvent.keyDown(endHandle(), { key: "ArrowRight" });
    expect(onResize).toHaveBeenLastCalledWith("end", 8);
    fireEvent.keyDown(startHandle(), { key: "ArrowLeft" });
    expect(onResize).toHaveBeenLastCalledWith("start", 3);
  });

  it("nudges by five with shift held", () => {
    const { onResize } = mount();
    fireEvent.keyDown(endHandle(), { key: "ArrowRight", shiftKey: true });
    expect(onResize).toHaveBeenLastCalledWith("end", 12);
  });

  it("takes an edge to its limit with Home/End", () => {
    const { onResize } = mount();
    fireEvent.keyDown(startHandle(), { key: "Home" });
    expect(onResize).toHaveBeenLastCalledWith("start", 0);
    fireEvent.keyDown(endHandle(), { key: "End" });
    expect(onResize).toHaveBeenLastCalledWith("end", 13);
  });

  it("ignores keys that are not a nudge", () => {
    const { onResize } = mount();
    fireEvent.keyDown(endHandle(), { key: "a" });
    expect(onResize).not.toHaveBeenCalled();
  });

  it("selects and previews on click — one gesture, both meanings", () => {
    const { onSelect, onPreview } = mount();
    fireEvent.click(screen.getByRole("button"));
    expect(onSelect).toHaveBeenCalled();
    expect(onPreview).toHaveBeenCalled();
  });

  it("drags an edge to the offset the rail resolves", () => {
    const { onResize } = mount();
    const handle = endHandle();
    fireEvent.pointerDown(handle, { pointerId: 1 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 95 });
    expect(onResize).toHaveBeenLastCalledWith("end", 10);
  });

  it("ignores a drag that never started on the handle", () => {
    const { onResize } = mount();
    fireEvent.pointerMove(endHandle(), { pointerId: 1, clientX: 95 });
    expect(onResize).not.toHaveBeenCalled();
  });

  it("offers no handles at all when it cannot be resized", () => {
    mount({ onResize: undefined });
    expect(screen.queryAllByRole("slider")).toHaveLength(0);
  });

  it("moves nothing while disabled", () => {
    const { onResize } = mount({ disabled: true });
    fireEvent.keyDown(endHandle(), { key: "ArrowRight" });
    expect(onResize).not.toHaveBeenCalled();
    expect(screen.getByRole("button")).toBeDisabled();
  });
});
