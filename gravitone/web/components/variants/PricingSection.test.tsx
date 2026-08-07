import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import PricingSection from "./PricingSection";
import { ELEVENLABS_PRICING, ELEVENLABS_PRICING_NOTE, breakEvenChars } from "@/lib/switchkit";
import { BOX, HEADLINE_CHARS, HEADLINE_TIER, TIMELINE_MONTHS } from "./pricingTimeline";

// This section renders competitor prices, so the claims contract in
// lib/content.ts applies to it: the citation is only defensible while it travels
// with its date and its source. Two more things have to survive every future
// redesign of this band — the crossover, where our own box is the WORSE buy, and
// the volume the cumulative comparison assumes (a two-year total without its
// monthly volume is not a comparison, it is a number picked to win).

// framer's scroll-entrance hooks (whileInView, useInView) need an
// IntersectionObserver, which every browser has and jsdom does not. It never
// fires here, so the illustration stays unmounted — which is exactly the state
// this file wants to test: the drawing is aria-hidden by construction, so
// everything that matters must be readable without it.
beforeAll(() => {
  // useStillMotion subscribes to a media query; jsdom ships no matchMedia at
  // all. "Motion is fine" is the same answer the server gives.
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

  it("says out loud where the box is the worse buy", () => {
    render(<PricingSection />);
    const chars = breakEvenChars(BOX)!;
    const honesty = screen.getByText(/costs MORE than the ElevenLabs tier/);
    expect(honesty).toHaveTextContent(chars.toLocaleString("en-US"));
    expect(honesty).toHaveTextContent("The box only wins once you use it");
    // Nothing self-hosted beats free, and the drawing cannot say so out loud.
    expect(honesty).toHaveTextContent(/Free tier's first 10,000 chars\/mo are \$0/);
  });

  it("states the volume the cumulative comparison assumes, in words", () => {
    render(<PricingSection />);
    // The illustration carries this too, but it is aria-hidden — so the prose
    // has to name it independently or the totals are unanchored.
    const volume = HEADLINE_CHARS.toLocaleString("en-US");
    expect(screen.getByText(new RegExp(`over ${TIMELINE_MONTHS} months at a fixed\\s+${volume} chars/mo`))).toBeTruthy();
    expect(screen.getAllByText(new RegExp(volume)).length).toBeGreaterThanOrEqual(2);
  });

  it("names the box price as a 24/7 cost, not a cost-per-use", () => {
    render(<PricingSection />);
    // $12.26 is what the machine bills whether or not it speaks — the legend
    // must not let that read as a usage charge.
    expect(screen.getByText(/flat, running 24\/7/)).toBeTruthy();
    expect(screen.getByText(/billed all 730 hours of\s+every month/)).toBeTruthy();
  });

  it("keeps the open-source line separate from the hardware line", () => {
    render(<PricingSection />);
    // The cheap line in the picture is a rented machine, not the software. If
    // those two ever merge into one "self-hosted" number, the section has
    // started selling a licence it does not charge for.
    expect(screen.getByText("Gravitone itself")).toBeTruthy();
    expect(screen.getByText("$0 / forever")).toBeTruthy();
    expect(screen.getByText(/the line above the floor is rented hardware, not a licence/)).toBeTruthy();
  });

  it("carries a legend for every series — identity is never colour alone", () => {
    render(<PricingSection />);
    // Named in the legend AND in the table header — the two places identity is
    // allowed to live. Never in the stroke colour alone.
    expect(screen.getAllByText(`ElevenLabs ${HEADLINE_TIER.name}`).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(new RegExp(BOX.name.replace(/[().]/g, "\\$&"))).length).toBeGreaterThanOrEqual(2);
  });

  it("offers the drawing's numbers as a table, so no value is picture-gated", () => {
    render(<PricingSection />);
    const table = screen.getByRole("table");
    expect(table).toHaveTextContent("Creator");
    expect(table).toHaveTextContent("Business");
    // Losing rows say so in words, not in colour.
    expect(table).toHaveTextContent("(more)");
    // And the cumulative half of the story is in the table too, not only drawn.
    expect(table).toHaveTextContent(`ElevenLabs · ${TIMELINE_MONTHS} mo`);
  });

  it("survives server rendering with the illustration unmounted", () => {
    // The landing is statically prerendered (`next build`). If this throws, the
    // home page fails to build.
    const html = renderToStaticMarkup(<PricingSection />);
    expect(html).toContain('id="switch"');
    expect(html).toContain(ELEVENLABS_PRICING.sourceLabel);
    expect(html).toContain("costs MORE than the ElevenLabs tier");
    // …and the story is readable without a single pixel of drawing.
    expect(html).toContain("<table");
  });
});
