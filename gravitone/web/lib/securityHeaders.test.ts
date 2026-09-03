// The frame policy has one exception and it is a shipped feature, so the
// exception is what these tests pin: `/t/{id}/embed` must stay embeddable, and
// nothing else may be. The rest asserts that the CSP still permits the two
// flows a careless policy breaks — Google sign-in and the live socket.

import { describe, expect, it } from "vitest";

import { contentSecurityPolicy, EMBED_PATH } from "./securityHeaders";

const directives = (csp: string) =>
  Object.fromEntries(csp.split("; ").map((d) => {
    const [name, ...rest] = d.split(" ");
    return [name, rest.join(" ")];
  })) as Record<string, string>;

describe("the frame policy", () => {
  it("lets anyone embed the Voice Card — that is what it is for", () => {
    expect(directives(contentSecurityPolicy("/t/abc123/embed"))["frame-ancestors"]).toBe("*");
    expect(EMBED_PATH.test("/t/abc123/embed")).toBe(true);
    expect(EMBED_PATH.test("/t/abc123/embed/")).toBe(true);
  });

  it("lets nobody else frame the studio", () => {
    for (const path of ["/", "/keys", "/playground", "/t/abc123", "/api/keys", "/t/abc/embed/x"]) {
      expect(directives(contentSecurityPolicy(path))["frame-ancestors"]).toBe("'self'");
      expect(EMBED_PATH.test(path)).toBe(false);
    }
  });
});

describe("the CSP does not break what the app actually does", () => {
  const csp = directives(contentSecurityPolicy("/"));

  it("permits the Firebase sign-in redirect flow", () => {
    // The popup needs no directive (CSP governs no window.open target), but the
    // redirect fallback — the path a blocked popup takes — loads Google's gapi
    // helper and mounts an iframe on the Firebase auth domain.
    expect(csp["script-src"]).toContain("https://apis.google.com");
    expect(csp["frame-src"]).toContain("https://*.firebaseapp.com");
    expect(csp["frame-src"]).toContain("https://accounts.google.com");
  });

  it("permits the live conversation socket and a backend on another host", () => {
    expect(csp["connect-src"]).toContain("wss:");
    expect(csp["connect-src"]).toContain("https:");
    // and still refuses the plaintext schemes
    expect(csp["connect-src"]).not.toContain("ws:");
    expect(csp["connect-src"]).not.toContain("http:");
  });

  it("permits Next's inline bootstrap, and blob audio/workers", () => {
    expect(csp["script-src"]).toContain("'unsafe-inline'");
    expect(csp["media-src"]).toContain("blob:");
    expect(csp["worker-src"]).toContain("blob:");
  });

  it("keeps eval out of production and allows it for the dev HMR runtime", () => {
    expect(contentSecurityPolicy("/", false)).not.toContain("'unsafe-eval'");
    expect(contentSecurityPolicy("/", true)).toContain("'unsafe-eval'");
  });

  it("closes the defaults an injected page would use", () => {
    expect(csp["object-src"]).toBe("'none'");
    expect(csp["base-uri"]).toBe("'self'");
    expect(csp["form-action"]).toBe("'self'");
    expect(csp["default-src"]).toBe("'self'");
  });
});
