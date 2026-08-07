import { beforeAll, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import PricingChart from "./PricingChart";
import { CHART } from "@/components/ui/tokens";
import { breakEvenChars } from "@/lib/switchkit";
import { SMALL_BOX, milestones } from "./pricingSeries";

/*
 * A smoke test for the recharts half, not a pixel test.
 *
 * recharts renders nothing at all inside a zero-sized ResponsiveContainer, and
 * jsdom gives every element zero size — so the container is fed a real box here
 * and the SVG is then inspected for the four things a silent config mistake
 * would take out: the log scales (a bad domain makes recharts drop the axis
 * rather than complain), the volume ticks, the three series strokes, and the
 * crossover marking. Without this the first sign of a broken chart would be a
 * blank panel in production.
 */

const BOX = { width: 800, height: 380, top: 0, left: 0, bottom: 380, right: 800, x: 0, y: 0 };

beforeAll(() => {
  // useStillMotion reads the media query directly; jsdom ships no matchMedia.
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private cb: ResizeObserverCallback) {}
      observe(el: Element) {
        this.cb([{ target: el, contentRect: BOX } as unknown as ResizeObserverEntry], this);
      }
      unobserve() {}
      disconnect() {}
    },
  );
  // recharts measures through the DOM; jsdom has no layout to measure.
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => BOX,
  });
  for (const prop of ["clientWidth", "offsetWidth"] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, value: BOX.width });
  }
  for (const prop of ["clientHeight", "offsetHeight"] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, value: BOX.height });
  }
});

describe("PricingChart", () => {
  it("draws all three cost series", () => {
    const { container } = render(<PricingChart />);
    for (const stroke of [CHART.el, CHART.box, CHART.boxLarge]) {
      expect(container.querySelector(`path[stroke="${stroke}"]`)).toBeTruthy();
    }
  });

  it("labels both axes as logarithmic — an unannounced log scale misleads", () => {
    const { container } = render(<PricingChart />);
    const text = container.textContent ?? "";
    expect(text).toContain("characters / month · log scale");
    expect(text).toContain("$ / month · log scale");
  });

  it("ticks the volume axis at the tiers a reader recognises", () => {
    const { container } = render(<PricingChart />);
    const text = container.textContent ?? "";
    for (const tier of milestones()) expect(text).toContain(tier.name);
    expect(text).toContain("100k");
    expect(text).toContain("11M");
  });

  it("marks the region where the box is the worse buy, in the plot itself", () => {
    const { container } = render(<PricingChart />);
    expect(container.textContent).toContain("box costs more");
    expect(container.textContent).toContain("box is the cheaper bill");
    // The warning wash is the status amber, never a series colour.
    expect(container.querySelector(`[fill="${CHART.warn}"]`)).toBeTruthy();
    expect(breakEvenChars(SMALL_BOX)).not.toBeNull();
  });
});
