import { beforeAll, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import SelectionSweep from "./SelectionSweep";

function stubMatchMedia(reduced: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduced,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}
beforeAll(() => stubMatchMedia(false));

describe("SelectionSweep", () => {
  it("is one hairline, decorative, and cannot swallow a click on the row", () => {
    const { container } = render(<SelectionSweep />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("aria-hidden");
    expect(svg.className.baseVal).toContain("pointer-events-none");
    expect(container.querySelectorAll("path")).toHaveLength(1);
  });

  it("stilled, the hairline is drawn — the accent is a state, not an animation", () => {
    stubMatchMedia(true);
    const { container } = render(<SelectionSweep />);
    const path = container.querySelector("path")!;
    expect(path.getAttribute("d")).toBe("M0 1 H100");
    // A stilled Draw is the finished stroke: no dash left masking it.
    expect(path.getAttribute("stroke-dasharray")).toBeNull();
    stubMatchMedia(false);
  });
});
