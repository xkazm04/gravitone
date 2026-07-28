import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import EmotionPicker from "./EmotionPicker";

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
