import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import GravitoneTokens from "./GravitoneTokens";
import {
  ACCENT,
  CHART,
  CSS_TOKENS,
  EASE,
  EASE_CSS,
  INK,
  SIGNAL_DEFAULTS,
  makeRise,
  rise,
  tokensCss,
} from "./tokens";

// Step 1 of the Signal Layer was a refactor with a hard promise attached: the
// design language moves from three drifting sources to one, and NOTHING changes
// visually. These tests pin the values that globals.css now reads through vars —
// if someone edits a token, this file is where the pixel change gets noticed.

describe("token emission", () => {
  it("emits every token and every signal channel on :root", () => {
    const css = tokensCss();
    expect(css.startsWith(":root{")).toBe(true);
    for (const [name, value] of Object.entries({ ...CSS_TOKENS, ...SIGNAL_DEFAULTS })) {
      expect(css).toContain(`${name}:${value};`);
    }
  });

  it("declares the C4 signal channels with no-op defaults", () => {
    expect(SIGNAL_DEFAULTS).toEqual({
      "--gt-level": "0",
      "--gt-peak": "0",
      "--gt-centroid": "0.5",
      "--gt-hue": "190",
      "--gt-working": "0",
    });
  });

  it("keeps the shipped literals byte-identical (before/after parity)", () => {
    expect(CSS_TOKENS["--gt-accent-cyan"]).toBe("#67e8f9");
    expect(CSS_TOKENS["--gt-accent-violet"]).toBe("#a78bfa");
    expect(CSS_TOKENS["--gt-accent-emerald"]).toBe("#6ee7b7");
    expect(CSS_TOKENS["--gt-surface-top"]).toBe("rgba(255,255,255,0.05)");
    expect(CSS_TOKENS["--gt-surface-bottom"]).toBe("rgba(255,255,255,0.015)");
    expect(CSS_TOKENS["--gt-hairline"]).toBe("rgba(255,255,255,0.08)");
    expect(CSS_TOKENS["--gt-blur"]).toBe("14px");
    expect(CSS_TOKENS["--gt-aurora-1"]).toBe("rgba(34,211,238,0.18)");
    expect(CSS_TOKENS["--gt-aurora-2"]).toBe("rgba(139,92,246,0.16)");
    expect(CSS_TOKENS["--gt-aurora-3"]).toBe("rgba(16,185,129,0.10)");
    expect(CSS_TOKENS["--gt-ring-cyan"]).toBe("rgba(103,232,249,0.3)");
    expect(CSS_TOKENS["--gt-glow-cyan"]).toBe("rgba(103,232,249,0.45)");
    expect(CSS_TOKENS["--gt-eq-period"]).toBe("1.1s");
    expect(CSS_TOKENS["--gt-aurora-period"]).toBe("22s");
    expect(CSS_TOKENS["--gt-ink"]).toBe(INK);
    expect(CSS_TOKENS["--gt-accent-cyan"]).toBe(ACCENT.cyan);
  });

  // DELIBERATE ADDITION (landing pricing chart). These are NOT the ACCENT trio
  // and must not be "tidied up" into it: the accents are display colours that
  // fail the dataviz palette checks as 2px data strokes (too light, and cyan vs
  // emerald falls under the normal-vision ΔE floor). These steps passed the
  // validator against this page's own surface. Changing one means re-running it,
  // not adjusting the expectation below.
  it("publishes the validated chart series colours", () => {
    expect(CHART.el).toBe("#9a6cf9");
    expect(CHART.box).toBe("#09a1c1");
    expect(CHART.boxLarge).toBe("#0b6d84");
    expect(CSS_TOKENS["--gt-chart-el"]).toBe(CHART.el);
    expect(CSS_TOKENS["--gt-chart-box"]).toBe(CHART.box);
    expect(CSS_TOKENS["--gt-chart-box-large"]).toBe(CHART.boxLarge);
  });

  it("keeps the chart series out of the status vocabulary", () => {
    // amber = warning and rose = error everywhere in this app (ErrorBanner).
    // A competitor's price line is an identity, not a fault condition, so no
    // series may wear a status hue.
    for (const c of [CHART.el, CHART.box, CHART.boxLarge]) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
      expect(r).toBeLessThan(Math.max(g, b)); // never a warm/red-dominant hue
    }
  });

  it("keeps the CSS ease and the framer ease the same curve", () => {
    expect(EASE_CSS).toBe(`cubic-bezier(${EASE.join(", ")})`);
    expect(CSS_TOKENS["--gt-ease"]).toBe(EASE_CSS);
  });

  it("renders one style tag containing the rule", () => {
    const html = renderToStaticMarkup(createElement(GravitoneTokens));
    expect(html).toContain('id="gravitone-tokens"');
    expect(html).toContain("--gt-accent-cyan:#67e8f9");
    expect(html).toContain("--gt-level:0");
  });
});

describe("rise presets", () => {
  it("default rise is unchanged (opacity/y 20, 0.6s, 0.07 stagger)", () => {
    expect(rise.hidden).toEqual({ opacity: 0, y: 20 });
    expect(rise.show(2)).toEqual({
      opacity: 1,
      y: 0,
      transition: { duration: 0.6, ease: EASE, delay: 2 * 0.07 },
    });
  });

  it("makeRise reproduces StudioDark's former local preset exactly", () => {
    const landing = makeRise({ y: 24, duration: 0.7, stagger: 0.08 });
    expect(landing.hidden).toEqual({ opacity: 0, y: 24 });
    expect(landing.show(3)).toEqual({
      opacity: 1,
      y: 0,
      transition: { duration: 0.7, ease: EASE, delay: 3 * 0.08 },
    });
  });
});
