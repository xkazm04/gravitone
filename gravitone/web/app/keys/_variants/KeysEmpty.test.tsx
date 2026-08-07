import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import KeysEmpty from "./KeysEmpty";

function stubMatchMedia(reduced: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduced,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

const COPY = "No keys yet — create one above.";
const strokes = (c: HTMLElement) => [...c.querySelectorAll("path")].map((p) => p.getAttribute("d") ?? "");

describe("KeysEmpty", () => {
  it("keeps the ledger's own sentence as the one line of prose", () => {
    const { container } = render(<KeysEmpty posture="enforced">{COPY}</KeysEmpty>);
    expect(screen.getByText(COPY)).toBeInTheDocument();
    expect(container.querySelectorAll("p")).toHaveLength(1);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden");
  });

  it("draws the unkeyed request turned back only when the probe MEASURED that", () => {
    const { container } = render(<KeysEmpty posture="enforced">{COPY}</KeysEmpty>);
    // The refusal is the only path that curves back on itself.
    expect(strokes(container).some((d) => d.includes("C") && d.endsWith("H70"))).toBe(true);
    expect(screen.getByText("refused")).toBeInTheDocument();
  });

  it("on an OPEN deployment draws the unkeyed request served, never refused", () => {
    // The posture strip above has just said every key here enforces nothing.
    // A picture of a refusal would contradict the measurement on the same page.
    const { container } = render(<KeysEmpty posture="open">{COPY}</KeysEmpty>);
    expect(strokes(container)).toContain("M40 84 H414");
    expect(screen.queryByText("refused")).toBeNull();
    expect(screen.getByText("served too")).toBeInTheDocument();
  });

  it("claims no verdict at all before the probe answers", () => {
    for (const posture of ["unmeasured", "unreachable"] as const) {
      const { container, unmount } = render(<KeysEmpty posture={posture}>{COPY}</KeysEmpty>);
      // The lane reaches the boundary and stops there — absence, not a verdict.
      expect(strokes(container)).toContain("M40 84 H256");
      expect(screen.queryByText("refused")).toBeNull();
      expect(screen.queryByText("served too")).toBeNull();
      unmount();
    }
  });

  it("stilled, the drawing is COMPLETE — every lane, the gate, and the caption", () => {
    stubMatchMedia(true);
    const { container } = render(<KeysEmpty posture="enforced">{COPY}</KeysEmpty>);
    // gate + keyed + refused = 3 strokes, plus the parked pulse.
    expect(container.querySelectorAll("path")).toHaveLength(4);
    expect(screen.getByText("with a key")).toBeInTheDocument();
    expect(screen.getByText("without one")).toBeInTheDocument();
    expect(screen.getByText(COPY)).toBeInTheDocument();
    stubMatchMedia(false);
  });
});
