// public/narrate.js runs on OTHER PEOPLE'S SITES. That is the whole reason
// this file exists: the ordinary web tests protect our users, and these protect
// the users of a customer who pasted one script tag into their docs and trusted
// it. So the assertions are about the promises the file makes in its header —
// no secrets, no autoplay, no third-party traffic, no globals — and they are
// made against the SHIPPED BYTES, not against an import of a source module.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(process.cwd(), "public", "narrate.js"), "utf-8");

describe("narrate.js as shipped", () => {
  it("is small enough to be a one-line embed", () => {
    // The budget is a product claim ("dependency-free, under 15KB"), so it is
    // enforced rather than hoped for.
    expect(Buffer.byteLength(SOURCE, "utf-8")).toBeLessThan(15 * 1024);
  });

  it("is ASCII, so no encoding header can garble it", () => {
    const offenders = SOURCE.split("\n")
      .map((line, i) => [i + 1, line] as const)
      // eslint-disable-next-line no-control-regex
      .filter(([, line]) => /[^\x09\x0a\x0d\x20-\x7e]/.test(line));
    expect(offenders).toEqual([]);
  });

  it("carries no key, token or secret of any kind", () => {
    // A public static asset cannot hold a credential. This catches the exact
    // mistake of "just hardcode the demo key so it works out of the box".
    expect(SOURCE).not.toMatch(/xi-api-key"\s*\]\s*=\s*"[^"]/);
    expect(SOURCE).not.toMatch(/(sk|pk|api|secret|token)[-_]?(key)?\s*[:=]\s*["'][A-Za-z0-9_-]{12,}/i);
  });

  it("never autoplays: every sound is behind a click handler", () => {
    // `.play()` may only be reached from the click path. A play call at the top
    // level, in a timer, or on load would violate the file's second rule.
    expect(SOURCE).not.toMatch(/setTimeout\([^)]*play/);
    expect(SOURCE).not.toMatch(/addEventListener\(\s*"(load|DOMContentLoaded|scroll)"/);
    expect(SOURCE).toMatch(/playBtn\.addEventListener\("click"/);
  });

  it("talks to the configured host and to nothing else", () => {
    const targets = [...SOURCE.matchAll(/fetch\(\s*([^,]+),/g)].map((m) => m[1].trim());
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) expect(target.startsWith("HOST +")).toBe(true);
    // No analytics, no beacons, no image pings.
    expect(SOURCE).not.toMatch(/sendBeacon|XMLHttpRequest|new Image\(/);
  });

  it("keeps the listener's key in sessionStorage, never localStorage", () => {
    // A key typed into someone else's page must not outlive the tab.
    expect(SOURCE).toMatch(/sessionStorage\.setItem/);
    expect(SOURCE).not.toMatch(/localStorage\s*\.\s*(get|set)Item/);
  });

  it("defines no globals — one IIFE, in strict mode", () => {
    // Everything after the header comment is a single wrapped expression, so
    // there is no top-level declaration to collide with the host page's code.
    const code = SOURCE.replace(/^\/\*[\s\S]*?\*\/\s*/, "").trim();
    expect(code.startsWith("(function () {")).toBe(true);
    expect(code.endsWith("})();")).toBe(true);
    expect(code).toMatch(/^\(function \(\) \{\n\s*"use strict";/);
    // A stray top-level declaration would sit at column 0 inside the wrapper.
    expect(code.split("\n").slice(1, -1).filter((l) => /^(var|let|const|function)\s/.test(l)))
      .toEqual([]);
  });
});

// ── it actually runs ─────────────────────────────────────────────────────────

describe("narrate.js in a page", () => {
  let script: HTMLScriptElement;

  beforeEach(() => {
    document.body.innerHTML = "<article><h1>A doc</h1><p>" + "word ".repeat(30) + "</p></article>";
    script = document.createElement("script");
    script.src = "https://voice.example.com/narrate.js";
    script.setAttribute("data-host", "https://voice.example.com");
    script.setAttribute("data-voice", "alba");
    document.head.appendChild(script);
    Object.defineProperty(document, "currentScript", { value: script, configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  const run = () => new Function(SOURCE)();
  const widget = () => document.querySelector("gravitone-narrate");
  const inside = (selector: string) =>
    widget()!.shadowRoot!.querySelector(selector) as HTMLElement;

  it("injects one opt-in widget and makes no request on load", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(""));
    run();
    expect(widget()).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("hides the panel until the reader opens it", () => {
    run();
    const panel = inside(".p") as HTMLElement & { hidden: boolean };
    expect(panel.hidden).toBe(true);
    const toggle = widget()!.shadowRoot!.querySelector(".w > button") as HTMLButtonElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("lives in a shadow root, so the host page's CSS cannot reach it", () => {
    run();
    expect(widget()!.shadowRoot).not.toBeNull();
    expect(widget()!.shadowRoot!.querySelector("style")).not.toBeNull();
  });

  it("never mounts twice, however many times the tag is included", () => {
    run();
    run();
    expect(document.querySelectorAll("gravitone-narrate")).toHaveLength(1);
  });

  it("posts the page text to the configured host, and only on click", async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ narration_id: "x", blocks: [] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    });
    run();
    (inside("#play") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]).toBe("https://voice.example.com/v1/narrate");
  });

  it("NAMES a deployment that wants a key instead of failing silently", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "no" }), { status: 401 }));
    run();
    (inside("#play") as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(inside("#status").textContent).toMatch(/needs a key/i));
    expect((inside("#key") as HTMLInputElement).hidden).toBe(false);
  });

  it("NAMES a page with nothing to read, without calling anything", async () => {
    document.body.innerHTML = "<article>hi</article>";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(""));
    run();
    (inside("#play") as HTMLButtonElement).click();
    expect(inside("#status").textContent).toMatch(/not enough text/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
