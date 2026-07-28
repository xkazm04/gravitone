// The web-side half of the expose-header drift guard.
//
// service/tests/test_cors.py::ExposeHeaderDriftTests already fails when a route
// sets an X- header that CORS_EXPOSE_HEADERS omits. That protects browsers
// talking to the service DIRECTLY — but every studio request goes through a
// Next route handler, and a header the proxy does not copy is just as invisible
// as one CORS hides. This test closes that half: the studio's forwarded set and
// the service's exposed set must be the SAME set, so a header added in app.py
// either reaches the browser or turns the suite red.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { SERVICE_EXPOSED_HEADERS, forwardExposedHeaders } from "./serviceHeaders";

/** The header names inside app.py's `CORS_EXPOSE_HEADERS = [...]` literal. */
function serviceExposedHeaders(): string[] {
  // vitest runs with the web app as its root; the service lives beside it.
  const appPy = resolve(process.cwd(), "../service/app.py");
  // A missing service checkout must NOT silently pass: the guard would be gone
  // exactly when it is most needed.
  const source = readFileSync(appPy, "utf8");
  const block = /CORS_EXPOSE_HEADERS\s*=\s*\[([\s\S]*?)\]/.exec(source);
  expect(block, "CORS_EXPOSE_HEADERS literal not found in service/app.py").toBeTruthy();
  return [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("expose-header drift between the service and the studio proxy", () => {
  it("forwards exactly the headers the service exposes", () => {
    const service = new Set(serviceExposedHeaders().map((h) => h.toLowerCase()));
    const studio = new Set(SERVICE_EXPOSED_HEADERS.map((h) => h.toLowerCase()));
    const missing = [...service].filter((h) => !studio.has(h)).sort();
    const extra = [...studio].filter((h) => !service.has(h)).sort();
    expect(missing, "exposed by service/app.py but NOT forwarded by the studio proxy — "
      + "add it to SERVICE_EXPOSED_HEADERS").toEqual([]);
    expect(extra, "forwarded by the studio proxy but no longer exposed by service/app.py")
      .toEqual([]);
  });

  it("still lists the header this guard was written for", () => {
    // X-Synth-Segments was emitted by /v1/speak and /v1/performance and dropped
    // by all three proxy routes.
    expect(SERVICE_EXPOSED_HEADERS).toContain("X-Synth-Segments");
  });
});

describe("forwardExposedHeaders", () => {
  it("copies the headers the upstream actually set", () => {
    const from = new Headers({ "X-Audio-Seconds": "1.5", "X-Synth-Segments": "4" });
    const to = forwardExposedHeaders(from, new Headers());
    expect(to.get("X-Audio-Seconds")).toBe("1.5");
    expect(to.get("X-Synth-Segments")).toBe("4");
  });

  it("omits a header the upstream did not send instead of writing an empty string", () => {
    const to = forwardExposedHeaders(new Headers(), new Headers());
    expect(to.get("X-Audio-Seconds")).toBeNull();
    expect(to.has("X-Realtime-Factor")).toBe(false);
  });

  it("never invents headers outside the exposed set", () => {
    const from = new Headers({ "X-Internal-Debug": "leak", "Set-Cookie": "a=b" });
    const to = forwardExposedHeaders(from, new Headers());
    expect(to.has("X-Internal-Debug")).toBe(false);
    expect(to.has("Set-Cookie")).toBe(false);
  });
});
