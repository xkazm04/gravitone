// switchkit renders into three surfaces — the reveal modal's MigrationKit, the
// profile "your key" panel and the landing page's SwitchKit — and had no test.
// The snippets are code a user PASTES, so the guarantees worth pinning are the
// ones that decide whether the paste works: the right header, the substituted
// key, and an honest word about the path the snippet actually runs on.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_BASE_URL, KEY_PLACEHOLDER, SNIPPET_LANGS, migrationSnippet,
} from "./switchkit";

describe("migrationSnippet", () => {
  it("sends the key as xi-api-key in every language — the whole migration claim", async () => {
    for (const lang of SNIPPET_LANGS) {
      const s = migrationSnippet(lang, { apiKey: "gk_live_abc" });
      expect(s, lang).toContain("gk_live_abc");
      // python goes through the ElevenLabs SDK, which sets the header itself
      if (lang !== "python") expect(s.toLowerCase(), lang).toContain("xi-api-key");
    }
  });

  it("substitutes the deployment host, and never leaves the ElevenLabs one", () => {
    for (const lang of SNIPPET_LANGS) {
      const s = migrationSnippet(lang, { baseUrl: "https://tts.example.com", apiKey: "k" });
      expect(s, lang).toContain("https://tts.example.com");
      // api.elevenlabs.io may only appear as the "was:" annotation, never as a
      // live URL the pasted code would call.
      for (const line of s.split("\n")) {
        if (line.includes("api.elevenlabs.io")) expect(line.trim(), lang).toMatch(/^(#|\/\/)|←|was:/);
      }
    }
  });

  it("falls back to visible placeholders rather than an empty credential", () => {
    const s = migrationSnippet("curl");
    expect(s).toContain(KEY_PLACEHOLDER);
    expect(s).toContain(DEFAULT_BASE_URL);
  });

  it("warns, in the javascript snippet itself, that a browser needs CORS", () => {
    // CORS is default-closed (service/app.py::cors_policy), so pasted into a
    // browser this dies at the preflight before the key is ever sent. The
    // studio's own compatibility check cannot exercise this path, so the
    // snippet has to carry the caveat.
    const js = migrationSnippet("javascript", { apiKey: "k" });
    expect(js).toContain("TTS_CORS_ORIGINS");
    expect(js).toMatch(/server-side/i);
  });
});
