// The embeddable Voice Card — the one surface of this app a STRANGER is
// allowed to frame (lib/securityHeaders: `frame-ancestors *`, and no
// X-Frame-Options at all, for this path only). Two properties are what make
// that permission safe to keep, and both are asserted here:
//
//   1. it degrades HONESTLY. An embed lives in someone else's page, so
//      collapsing a backend restart into "not found" told every host their
//      embed had been deleted. Missing is a 404; unreachable is not.
//   2. it holds no session authority and offers nothing to click to a
//      visitor's detriment — no pick, no re-perform, no fork, no keys.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));
vi.mock("@/lib/peaks", () => ({ computePeaks: vi.fn(async () => ({ peaks: [], duration: 1 })) }));

import TakeEmbedPage, { metadata } from "./page";
import { EMBED_PATH } from "@/lib/securityHeaders";
import type { SharedTake } from "@/lib/takes";

const TAKE: SharedTake = {
  id: "t1", character_id: "sarah", character_name: "Sarah",
  text: "[angry] You said you would call.", seconds: 2, rtf: 0.2,
  segments: [{ text: "You said you would call.", requested: "angry", used: "angry", fallback: false, seconds: 2 }],
  created: "2026-08-01T10:00:00+00:00",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function stubBackend(reply: () => Response | Error) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("/v1/takes/")) return new Response("", { status: 404 });
    const r = reply();
    if (r instanceof Error) throw r;
    return r;
  }));
}

const page = () => TakeEmbedPage({ params: Promise.resolve({ id: "t1" }) });

beforeEach(() => {
  URL.createObjectURL = () => "blob:take";
  URL.revokeObjectURL = () => {};
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("the embed is the one deliberately frameable path", () => {
  it("is the ONLY shape that matches the frame-ancestors exception", () => {
    expect(EMBED_PATH.test("/t/t1/embed")).toBe(true);
    expect(EMBED_PATH.test("/t/t1/embed/")).toBe(true);
    expect(EMBED_PATH.test("/t/t1")).toBe(false);
    expect(EMBED_PATH.test("/r/rev1")).toBe(false);
    expect(EMBED_PATH.test("/keys")).toBe(false);
    expect(EMBED_PATH.test("/t/t1/embed/../../keys")).toBe(false);
  });

  it("offers a stranger's page nothing but a player", async () => {
    stubBackend(() => json(TAKE));
    render(await page());
    // one control: play. Nothing that could be clickjacked into a mutation.
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName(/play/i);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("keeps itself out of the index — the share page is the indexable one", () => {
    expect(metadata.robots).toEqual({ index: false });
  });
});

describe("the embed degrades honestly", () => {
  it("404s a take the backend says is gone", async () => {
    stubBackend(() => json({ detail: "no such take" }, 404));
    await expect(page()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("does NOT tell its host the embed was deleted when the box is down", async () => {
    stubBackend(() => new Error("ECONNREFUSED"));
    render(await page());
    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent("Gravitone backend unreachable");
    expect(banner).toHaveTextContent(/has not been removed/i);
    expect(banner.className).toMatch(/rose/);
  });

  it("carries the backend's own sentence for a 5xx", async () => {
    stubBackend(() => json({ detail: "request 7f3a failed" }, 500));
    render(await page());
    expect(screen.getByRole("alert")).toHaveTextContent("request 7f3a failed");
  });

  it("renders the card compactly — no page chrome to inherit", async () => {
    stubBackend(() => json(TAKE));
    render(await page());
    expect(screen.getByText("Sarah")).toBeInTheDocument();
    // `compact` drops the text block and the copy/embed buttons
    expect(screen.queryByText(TAKE.text)).toBeNull();
    expect(screen.queryByRole("button", { name: /copy link/i })).toBeNull();
    // and it links OUT to the full share page rather than framing more of itself
    expect(screen.getByRole("link", { name: /open/i })).toHaveAttribute("href", "/t/t1");
  });
});
