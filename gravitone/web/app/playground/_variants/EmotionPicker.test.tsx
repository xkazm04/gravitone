import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import EmotionPicker from "./EmotionPicker";
import { emotionMeta } from "@/lib/emotions";

const props = {
  onPick: vi.fn(), available: ["baseline"], scale: ["baseline", "excited"],
  characterName: "Sarah", characterId: "sarah",
};

/** The element the user was on when they opened the wheel. */
function opener() {
  const b = document.createElement("button");
  b.textContent = "open the wheel";
  document.body.append(b);
  b.focus();
  return b;
}

function focusables(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])'));
}

describe("EmotionPicker — it claims to be a modal, so it behaves like one", () => {
  it("moves focus into the dialog when it opens", () => {
    // It declared role="dialog" aria-modal="true" while leaving focus on the
    // page behind it, so a keyboard user was told they were in a modal that
    // did not contain them.
    const from = opener();
    render(<EmotionPicker open onClose={vi.fn()} {...props} />);
    expect(document.activeElement).not.toBe(from);
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    from.remove();
  });

  it("returns focus to whatever opened it on close", () => {
    const from = opener();
    const onClose = vi.fn();
    const { rerender } = render(<EmotionPicker open onClose={onClose} {...props} />);
    rerender(<EmotionPicker open={false} onClose={onClose} {...props} />);
    expect(document.activeElement).toBe(from);
    from.remove();
  });

  it("wraps Tab from the last control back to the first", () => {
    const from = opener();
    render(<EmotionPicker open onClose={vi.fn()} {...props} />);
    const dialog = screen.getByRole("dialog");
    const items = focusables(dialog);
    items[items.length - 1].focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(items[0]);
    from.remove();
  });

  it("wraps Shift+Tab backwards to the last control", () => {
    const from = opener();
    render(<EmotionPicker open onClose={vi.fn()} {...props} />);
    const dialog = screen.getByRole("dialog");
    const items = focusables(dialog);
    items[0].focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(items[items.length - 1]);
    from.remove();
  });

  it("still closes on Escape", () => {
    const onClose = vi.fn();
    render(<EmotionPicker open onClose={onClose} {...props} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

/** The spokes, in ring order — the order an arrow key walks. */
function ring(): HTMLButtonElement[] {
  return props.scale.map((id) => screen.getByRole("button", { name: new RegExp(`^${emotionMeta(id).label} —`) }) as HTMLButtonElement);
}

describe("EmotionPicker — a picker for every hand", () => {
  it("walks the ring with the arrow keys, in both directions, wrapping", () => {
    // The spokes were plain buttons with no arrow handling at all: the only way
    // around a RADIAL control was Tab, which has nothing to do with its shape.
    render(<EmotionPicker open onClose={vi.fn()} {...props} />);
    const spokes = ring();
    spokes[0].focus();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(document.activeElement).toBe(spokes[1]);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(document.activeElement).toBe(spokes[0]); // wrapped
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(spokes[spokes.length - 1]);
  });

  it("treats Down/Up as the same walk, and Home/End as the ends", () => {
    render(<EmotionPicker open onClose={vi.fn()} {...props} />);
    const spokes = ring();
    spokes[0].focus();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(document.activeElement).toBe(spokes[1]);
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(document.activeElement).toBe(spokes[0]);
    fireEvent.keyDown(window, { key: "End" });
    expect(document.activeElement).toBe(spokes[spokes.length - 1]);
    fireEvent.keyDown(window, { key: "Home" });
    expect(document.activeElement).toBe(spokes[0]);
  });

  it("lands the FIRST arrow press on the ring rather than skipping a spoke", () => {
    // Focus opens on the panel, not on a spoke, so index -1 must mean "start
    // here", not "start at the one after here".
    render(<EmotionPicker open onClose={vi.fn()} {...props} />);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(document.activeElement).toBe(ring()[0]);
  });

  it("applies with Enter on the focused spoke — the browser's own activation", () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<EmotionPicker open onClose={onClose} {...props} onPick={onPick} />);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.click(document.activeElement as HTMLElement); // what Enter on a <button> does
    expect(onPick).toHaveBeenCalledWith("baseline");
    expect(onClose).toHaveBeenCalled();
  });

  it("says whether an emotion is recorded IN THE ACCESSIBLE NAME, not only a tooltip", () => {
    // Availability used to be dimming plus `title`: invisible on touch, silent
    // to a screen reader, and the substitution consequence went with it.
    render(<EmotionPicker open onClose={vi.fn()} {...props} />);
    expect(screen.getByRole("button", { name: /^Baseline — available$/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Excited — not recorded; the nearest recorded emotion is used, then baseline$/ })).toBeTruthy();
  });

  it("spells the focused spoke's availability out in the hub, with no hover involved", () => {
    render(<EmotionPicker open onClose={vi.fn()} {...props} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("pick a mood");
    fireEvent.focus(ring()[1]);
    expect(dialog.textContent).toContain("Excited");
    expect(dialog.textContent).toContain("not recorded");
  });

  it("fits a 375px phone: the wheel and its spokes stay inside the viewport", () => {
    // `h-[440px] w-[440px]` with R = 150 overflowed every phone in existence.
    vi.stubGlobal("innerWidth", 375);
    vi.stubGlobal("innerHeight", 812);
    render(<EmotionPicker open onClose={vi.fn()} {...props} />);
    const wheel = screen.getByTestId("wheel");
    const box = Number.parseInt(wheel.style.width, 10);
    expect(box).toBeLessThanOrEqual(375 - 64);
    // Every spoke's centre plus half its own width has to stay inside the box.
    for (const spoke of ring()) {
      const holder = spoke.parentElement as HTMLElement;
      const [, dx, dy] = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(holder.style.transform)!;
      const half = Number.parseInt(spoke.style.width, 10) / 2;
      expect(Math.abs(Number(dx)) + half).toBeLessThanOrEqual(box / 2);
      expect(Math.abs(Number(dy)) + half).toBeLessThanOrEqual(box / 2);
    }
  });

  it("keeps every spoke at or above the 44px touch-target floor when compact", () => {
    vi.stubGlobal("innerWidth", 375);
    vi.stubGlobal("innerHeight", 812);
    render(<EmotionPicker open onClose={vi.fn()} {...props} />);
    for (const spoke of ring()) {
      const disc = spoke.querySelector<HTMLElement>("span[style*='height']")!;
      expect(Number.parseInt(disc.style.height, 10)).toBeGreaterThanOrEqual(44);
    }
  });

  it("keeps the wheel at its full size on a desktop viewport", () => {
    vi.stubGlobal("innerWidth", 1440);
    vi.stubGlobal("innerHeight", 900);
    render(<EmotionPicker open onClose={vi.fn()} {...props} />);
    const wheel = screen.getByTestId("wheel");
    expect(wheel.style.width).toBe("440px");
    // …and the per-spoke status lines that only fit at full size are still there.
    expect(screen.getByRole("link", { name: /record/ })).toBeTruthy();
  });
});
