import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import Equalizer from "./Equalizer";
import { Waveform } from "./Primitives";

// Equalizer and Waveform used to be two copies of the same markup on a fixed
// CSS timer. They are now one bar field with two modes; these tests pin the
// keyframe fallback (which every existing call site depends on) and the per-bar
// weights the live mode divides the signal by.

describe("bar field", () => {
  it("keeps the keyframe fallback offsets for idle decoration", () => {
    const { container } = render(<Equalizer bars={5} />);
    const bars = container.querySelectorAll(".eq-bar");
    expect(bars).toHaveLength(5);
    const first = bars[0] as HTMLElement;
    expect(first.style.animationDelay).toBe("0s");
    expect(first.style.animationDuration).toBe("0.9s");
    expect((bars[1] as HTMLElement).style.animationDelay).toBe("0.09s");
  });

  it("gives every bar a low/high band weight for the live mode", () => {
    const { container } = render(<Equalizer bars={4} />);
    const bars = Array.from(container.querySelectorAll(".eq-bar")) as HTMLElement[];
    for (const bar of bars) {
      expect(Number(bar.style.getPropertyValue("--gt-bar-lo"))).toBeGreaterThan(0);
      expect(Number(bar.style.getPropertyValue("--gt-bar-hi"))).toBeGreaterThan(0);
    }
    // low band leans left, high band leans right — that is the brightness tilt
    expect(Number(bars[0].style.getPropertyValue("--gt-bar-lo"))).toBeGreaterThan(
      Number(bars[3].style.getPropertyValue("--gt-bar-lo")),
    );
    expect(Number(bars[3].style.getPropertyValue("--gt-bar-hi"))).toBeGreaterThan(
      Number(bars[0].style.getPropertyValue("--gt-bar-hi")),
    );
  });

  it("stays decorative for screen readers", () => {
    const { container } = render(<Equalizer bars={3} />);
    expect(container.firstElementChild).toHaveAttribute("aria-hidden");
  });

  it("Waveform shares the field and keeps its colour variants", () => {
    const { container } = render(<Waveform bars={3} color="violet" />);
    const bars = container.querySelectorAll(".eq-bar");
    expect(bars).toHaveLength(3);
    expect((bars[0] as HTMLElement).className).toContain("from-violet-400/40");
    expect((bars[0] as HTMLElement).style.height).toBe("100%");
  });

  it("Equalizer keeps its fixed 40px bar height", () => {
    const { container } = render(<Equalizer bars={2} />);
    expect((container.querySelector(".eq-bar") as HTMLElement).style.height).toBe("40px");
  });
});
