import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import PricingSection from "./PricingSection";
import { ELEVENLABS_PRICING, ELEVENLABS_PRICING_NOTE } from "@/lib/switchkit";
import {
  BOX,
  END_CHARS,
  GROWTH_PCT,
  START_CHARS,
  TIMELINE_MONTHS,
  growthSeries,
} from "./pricingTimeline";

// This section renders competitor prices, so the claims contract in
// lib/content.ts applies to it: the citation is only defensible while it travels
// with its date and its source. Two more things have to survive every future
// redesign of this band — the months where our own box is the WORSE buy, and the
// usage curve the whole comparison assumes (a two-year story without its growth
// assumption is not a comparison, it is a shape picked to win).
//
// CONSOLIDATED (owner verdict): variant A, "two bills, counted", is the only
// picture, and the prose paragraphs are extinct — the assumption travels as
// CHIPS, the losing months live in the drawing (PricingBills' own tests pin
// both crossings) and in the table's worded rows. These tests describe the
// section frame; pricingVariants.test.tsx describes the picture.

// framer's scroll-entrance hooks (whileInView, useInView) need an
// IntersectionObserver, which every browser has and jsdom does not. It never
// fires here, so the illustration stays unmounted — which is exactly the state
// this file wants to test: the drawing is aria-hidden by construction, so
// everything that matters must be readable without it.
beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
      takeRecords = vi.fn(() => []);
      root = null;
      rootMargin = "";
      thresholds = [];
    },
  );
});

describe("PricingSection", () => {
  it("renders the ElevenLabs attribution and its live source link", () => {
    render(<PricingSection />);
    expect(screen.getByText(new RegExp(ELEVENLABS_PRICING_NOTE))).toBeTruthy();
    const source = screen.getByRole("link", { name: ELEVENLABS_PRICING.sourceLabel });
    expect(source).toHaveAttribute("href", ELEVENLABS_PRICING.sourceUrl);
    expect(source).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
  });

  it("states the growth assumption as chips — the prose form is extinct", () => {
    render(<PricingSection />);
    // The read-out carries it too, but the illustration is aria-hidden — so the
    // chip strip has to name it independently or the curve is unanchored.
    expect(screen.getByText(`+${GROWTH_PCT}% every month`)).toBeTruthy();
    expect(screen.getByText(`${TIMELINE_MONTHS} months`)).toBeTruthy();
    // The box price is a 24/7 cost, not a cost-per-use — the chip says so.
    expect(screen.getByText(new RegExp("billed all 730\\s?h/mo"))).toBeTruthy();
    expect(screen.getByText(/whichever published tier covers the month/)).toBeTruthy();
  });

  it("keeps every paragraph short — no running prose survived consolidation", () => {
    const { container } = render(<PricingSection />);
    for (const p of container.querySelectorAll("p")) {
      expect((p.textContent ?? "").length).toBeLessThanOrEqual(160);
    }
  });

  it("offers the drawing's numbers as a table, so no value is picture-gated", () => {
    render(<PricingSection />);
    const table = screen.getByRole("table");
    // One row per month, usage included: the picture's x-axis and its engine.
    expect(table).toHaveTextContent(START_CHARS.toLocaleString("en-US"));
    expect(table).toHaveTextContent(END_CHARS.toLocaleString("en-US"));
    expect(table.querySelectorAll("tbody tr").length).toBe(TIMELINE_MONTHS);
    // Losing months say so in words, not in colour — the honesty that used to
    // be a paragraph lives here and in the drawing's two marked crossings.
    expect(table).toHaveTextContent("(more)");
    expect(table).toHaveTextContent("(they cross)");
    // Identity is never colour alone: both series are named in the table.
    expect(table.textContent).toContain(BOX.name);
  });

  it("survives server rendering with the illustration unmounted", () => {
    // The landing is statically prerendered (`next build`). If this throws, the
    // home page fails to build.
    const html = renderToStaticMarkup(<PricingSection />);
    expect(html).toContain('id="switch"');
    expect(html).toContain(ELEVENLABS_PRICING.sourceLabel);
    // …and the story is readable without a single pixel of drawing.
    expect(html).toContain("<table");
    expect(html).toContain(`+${GROWTH_PCT}% every month`);
  });
});

// Sanity: the series the section renders is the tested one.
it("renders exactly the growthSeries months", () => {
  expect(growthSeries()).toHaveLength(TIMELINE_MONTHS);
});
