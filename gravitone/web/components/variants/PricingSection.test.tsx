import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import PricingSection from "./PricingSection";
import { ELEVENLABS_PRICING, ELEVENLABS_PRICING_NOTE } from "@/lib/switchkit";
import {
  BOX,
  EL_CHEAPER_THROUGH_CHARS,
  END_CHARS,
  GROWTH_PCT,
  START_CHARS,
  TIMELINE_MONTHS,
  crossoverMonth,
  growthSeries,
} from "./pricingTimeline";

// This section renders competitor prices, so the claims contract in
// lib/content.ts applies to it: the citation is only defensible while it travels
// with its date and its source. Two more things have to survive every future
// redesign of this band — the months where our own box is the WORSE buy, and the
// usage curve the whole comparison assumes (a two-year story without its growth
// assumption is not a comparison, it is a shape picked to win).

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

const SERIES = growthSeries();
const CROSS = crossoverMonth(SERIES)!;

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
    const honesty = screen.getByText(/costs MORE than the ElevenLabs tier/);
    // The threshold quoted is the volume the subscription is cheaper THROUGH —
    // not the tier ceiling above it, which would overstate our own losing range.
    expect(honesty).toHaveTextContent(EL_CHEAPER_THROUGH_CHARS!.toLocaleString("en-US"));
    expect(honesty).toHaveTextContent(`months 1–${CROSS - 1} of this timeline`);
    expect(honesty).toHaveTextContent("The box only wins once you use it");
    // Nothing self-hosted beats free, and the drawing cannot say so out loud.
    expect(honesty).toHaveTextContent(/Free tier's first 10,000 chars\/mo are \$0/);
  });

  it("states the growth assumption the whole timeline rests on, in words", () => {
    render(<PricingSection />);
    // The read-out carries it too, but the illustration is aria-hidden — so the
    // prose has to name it independently or the curve is unanchored.
    const start = START_CHARS.toLocaleString("en-US");
    const end = END_CHARS.toLocaleString("en-US");
    expect(
      screen.getByText(
        new RegExp(
          `one project growing from\\s+${start} to ${end} characters a month over ${TIMELINE_MONTHS} months`,
        ),
      ),
    ).toBeTruthy();
    // …and the rate, so a reader can check the curve rather than trust it.
    expect(screen.getByText(/growth every month/)).toBeTruthy();
  });

  it("names the box price as a 24/7 cost, not a cost-per-use", () => {
    render(<PricingSection />);
    // $12.26 is what the machine bills whether or not it speaks — the legend
    // must not let that read as a usage charge.
    expect(screen.getByText(/flat, running 24\/7/)).toBeTruthy();
    expect(screen.getByText(/billed all 730\s+hours of every month/)).toBeTruthy();
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
    expect(screen.getByText("ElevenLabs tiers")).toBeTruthy();
    expect(screen.getAllByText(new RegExp(BOX.name.replace(/[().]/g, "\\$&"))).length).toBeGreaterThanOrEqual(2);
  });

  it("offers the drawing's numbers as a table, so no value is picture-gated", () => {
    render(<PricingSection />);
    const table = screen.getByRole("table");
    // One row per month, usage included: the picture's x-axis and its engine.
    expect(table).toHaveTextContent(START_CHARS.toLocaleString("en-US"));
    expect(table).toHaveTextContent(END_CHARS.toLocaleString("en-US"));
    expect(table.querySelectorAll("tbody tr").length).toBe(TIMELINE_MONTHS);
    // Losing months say so in words, not in colour.
    expect(table).toHaveTextContent("(more)");
    expect(table).toHaveTextContent("(they cross)");
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

/*
 * PROTOTYPING SCAFFOLD (deleted at consolidation together with the lens strip).
 * The one property worth asserting about a throwaway switcher is that it is
 * throwaway: `current` is what a reader gets, so every test above still
 * describes the shipping page.
 */
describe("PricingSection · the prototype lens strip", () => {
  it("defaults to the shipping lens, so nothing changes on load", () => {
    render(<PricingSection />);
    const current = screen.getByRole("button", { name: "current" });
    expect(current).toHaveAttribute("aria-pressed", "true");
    for (const other of ["A", "B"]) {
      expect(screen.getByRole("button", { name: other })).toHaveAttribute("aria-pressed", "false");
    }
  });

  it.each(["A", "B"])("lens %s swaps the picture and drops the paragraphs, keeping the contracts", async (lens) => {
    render(<PricingSection />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: lens }));
    });

    // The two paragraph blocks are the thing these variants exist to kill.
    expect(screen.queryByText(/costs MORE than the ElevenLabs tier/)).toBeNull();
    expect(screen.queryByText(/The assumption, plainly/)).toBeNull();

    // Their facts survive as chips…
    const chips = screen.getByLabelText("the assumptions this comparison rests on");
    expect(chips).toHaveTextContent(`+${GROWTH_PCT}% every month`);
    expect(chips).toHaveTextContent(`${TIMELINE_MONTHS} months`);
    expect(chips).toHaveTextContent("730 h/mo");

    // …and the two contracts are outside the lens, so no variant can lose them.
    expect(screen.getByRole("link", { name: ELEVENLABS_PRICING.sourceLabel })).toBeTruthy();
    expect(screen.getByRole("table").querySelectorAll("tbody tr").length).toBe(TIMELINE_MONTHS);
  });
});
