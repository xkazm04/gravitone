import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import PricingSection from "./PricingSection";
import { ELEVENLABS_PRICING, ELEVENLABS_PRICING_NOTE, breakEvenChars } from "@/lib/switchkit";
import { LARGE_BOX, SMALL_BOX } from "./pricingSeries";

// This section renders competitor prices, so the claims contract in
// lib/content.ts applies to it: the citation is only defensible while it travels
// with its date and its source. And the crossover — the volumes where our own
// box is the WORSE buy — has to survive every future redesign of this band.

// framer's scroll-entrance hooks (whileInView, useInView) need an
// IntersectionObserver, which every browser has and jsdom does not. It never
// fires here, so the chart stays unarmed — which is exactly the state this file
// wants to test: everything that matters is readable before the chart arrives.
beforeAll(() => {
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

  it("says out loud where the box is the worse buy", () => {
    render(<PricingSection />);
    const chars = breakEvenChars(SMALL_BOX)!;
    const honesty = screen.getByText(/costs MORE than the ElevenLabs tier/);
    expect(honesty).toHaveTextContent(chars.toLocaleString("en-US"));
    expect(honesty).toHaveTextContent("The box only wins once you use it");
    // The free tier is not on the log axis, so it has to be in the words.
    expect(honesty).toHaveTextContent(/Free tier's first 10,000 chars\/mo are \$0/);
  });

  it("names the box price as a 24/7 cost, not a cost-per-use", () => {
    render(<PricingSection />);
    // $12.26 is what the machine bills whether or not it speaks — the legend
    // must not let that read as a usage charge.
    expect(screen.getAllByText(/flat, running 24\/7/).length).toBeGreaterThan(0);
    expect(screen.getByText(/billed all\s+730 hours of the month/)).toBeTruthy();
  });

  it("carries a legend for every series — identity is never colour alone", () => {
    render(<PricingSection />);
    // Named in the legend AND in the table header — the two places identity is
    // allowed to live. Never in the stroke colour alone.
    expect(screen.getAllByText("ElevenLabs").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(SMALL_BOX.name).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(LARGE_BOX.name).length).toBeGreaterThanOrEqual(2);
  });

  it("offers the chart's numbers as a table, so no value is hover-gated", () => {
    render(<PricingSection />);
    const table = screen.getByRole("table");
    expect(table).toHaveTextContent("Creator");
    expect(table).toHaveTextContent("Business");
    // Losing rows say so in words, not in colour.
    expect(table).toHaveTextContent("(more)");
  });

  it("survives server rendering with the chart chunk absent", () => {
    // recharts is behind next/dynamic (ssr:false) precisely so the landing can
    // prerender. If this throws, `next build` fails on the home page.
    const html = renderToStaticMarkup(<PricingSection />);
    expect(html).toContain('id="switch"');
    expect(html).toContain(ELEVENLABS_PRICING.sourceLabel);
    expect(html).toContain("costs MORE than the ElevenLabs tier");
    // …and the story is readable without a single pixel of chart.
    expect(html).toContain("<table");
  });
});
