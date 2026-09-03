import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import CostBar from "./CostBar";

function stubMatchMedia(reduced: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduced,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

describe("CostBar", () => {
  it("draws the length it is GIVEN — no arithmetic on a cost happens here", () => {
    const { container } = render(<CostBar rowKey="Gravitone · c8g" accent pct={41.5} />);
    expect(container.querySelector("path")?.getAttribute("d")).toBe("M0 1.25 H41.5");
  });

  it("keeps the accent for a measured box and goes hairline for the comparison", () => {
    const { container: g } = render(<CostBar rowKey="g" accent pct={80} />);
    expect(g.querySelector("path")?.getAttribute("stroke")).toContain("url(#");
    expect(g.querySelector("linearGradient")).toBeTruthy();

    const { container: e } = render(<CostBar rowKey="el" accent={false} pct={80} />);
    expect(e.querySelector("path")?.getAttribute("stroke")).toBe("rgba(255,255,255,0.14)");
    // No gradient node for a row that is not the point.
    expect(e.querySelector("linearGradient")).toBeNull();
  });

  it("gives each row its own gradient id — two bars cannot share one node", () => {
    const { container: a } = render(<CostBar rowKey="Gravitone · c8g.2xl" accent pct={10} />);
    const { container: b } = render(<CostBar rowKey="Gravitone · t4g.small" accent pct={20} />);
    const idOf = (c: HTMLElement) => c.querySelector("linearGradient")?.getAttribute("id");
    expect(idOf(a)).toBeTruthy();
    expect(idOf(a)).not.toBe(idOf(b));
  });

  it("draws the bar rather than nothing when the engine has no IntersectionObserver", () => {
    // A bar that never appears is a MISSING DATUM — a worse failure than a
    // missing animation, so the absence of the observer means "draw it now".
    const { container } = render(<CostBar rowKey="g" accent pct={55} />);
    expect(container.querySelectorAll("path")).toHaveLength(1);
  });

  it("stilled, the bar is its finished stroke — the number never needed motion", () => {
    stubMatchMedia(true);
    const { container } = render(<CostBar rowKey="g" accent pct={62.5} />);
    const path = container.querySelector("path")!;
    expect(path.getAttribute("d")).toBe("M0 1.25 H62.5");
    expect(path.getAttribute("stroke-dasharray")).toBeNull();
    stubMatchMedia(false);
  });

  it("is decorative — the price beside it is what a reader is given", () => {
    const { container } = render(<CostBar rowKey="g" accent pct={30} />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden");
  });
});
