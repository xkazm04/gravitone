import { describe, expect, it } from "vitest";

import {
  DROPPED_INTEGRATIONS,
  baseSentryOptions,
  keepIntegration,
  sampleRateFrom,
  scrubBreadcrumb,
  scrubEvent,
  sentryEnabled,
  stripQuery,
} from "./sentry";

describe("sentryEnabled", () => {
  it("is false for every shape of 'not configured'", () => {
    // The whole opt-in guarantee hangs off this predicate: every one of these
    // must mean "do not load the SDK", not "load it and hope".
    expect(sentryEnabled(undefined)).toBe(false);
    expect(sentryEnabled("")).toBe(false);
    expect(sentryEnabled("   ")).toBe(false);
  });

  it("is true only for a real DSN", () => {
    expect(sentryEnabled("https://abc@o1.ingest.sentry.io/2")).toBe(true);
  });
});

describe("stripQuery", () => {
  it("keeps a URL that has nothing to strip", () => {
    expect(stripQuery("/api/tts")).toBe("/api/tts");
    expect(stripQuery("https://example.test/t/abc")).toBe("https://example.test/t/abc");
  });

  it("drops the query string, which is where a key ends up", () => {
    expect(stripQuery("/api/tts?xi-api-key=sk_live_secret")).toBe("/api/tts");
    expect(stripQuery("https://x.test/a?b=1&c=2")).toBe("https://x.test/a");
  });

  it("drops a fragment, and the earlier of the two markers", () => {
    expect(stripQuery("/keys#token=abc")).toBe("/keys");
    expect(stripQuery("/keys#a?b")).toBe("/keys");
    expect(stripQuery("/keys?a#b")).toBe("/keys");
  });

  it("does not throw on a relative URL, which new URL() would", () => {
    expect(() => stripQuery("../relative?x=1")).not.toThrow();
    expect(stripQuery("")).toBe("");
  });
});

describe("scrubEvent", () => {
  it("removes the body, cookies, headers and user from an event", () => {
    const event = {
      request: {
        url: "https://studio.test/api/ingest/scan?key=sk_live_secret",
        query_string: "key=sk_live_secret",
        data: { transcript: "the recording said this", email: "a@b.test" },
        cookies: { session: "abc" },
        headers: { "xi-api-key": "sk_live_secret", authorization: "Bearer x" },
      },
      user: { email: "a@b.test", ip_address: "203.0.113.4" },
    };

    const out = scrubEvent(event);

    expect(out.user).toBeUndefined();
    expect(out.request.data).toBeUndefined();
    expect(out.request.cookies).toBeUndefined();
    expect(out.request.headers).toBeUndefined();
    expect(out.request.query_string).toBeUndefined();
    expect(out.request.url).toBe("https://studio.test/api/ingest/scan");
    // Nothing secret survives anywhere in the serialized event.
    expect(JSON.stringify(out)).not.toContain("sk_live_secret");
    expect(JSON.stringify(out)).not.toContain("a@b.test");
    expect(JSON.stringify(out)).not.toContain("the recording said this");
  });

  it("survives an event with no request at all", () => {
    expect(() => scrubEvent({})).not.toThrow();
    expect(scrubEvent({ request: {} }).request).toEqual({});
  });
});

describe("scrubBreadcrumb", () => {
  it("strips the query off a fetch breadcrumb URL", () => {
    const crumb = scrubBreadcrumb({
      data: { url: "/api/tts?xi-api-key=sk_live_secret", status_code: 500 },
    });
    expect(crumb.data.url).toBe("/api/tts");
    expect(crumb.data.status_code).toBe(500);
  });

  it("leaves a breadcrumb with no URL alone", () => {
    expect(() => scrubBreadcrumb({})).not.toThrow();
    expect(scrubBreadcrumb({ data: { status_code: 200 } }).data.status_code).toBe(200);
  });
});

describe("sampleRateFrom", () => {
  it("falls back when the variable is absent or blank", () => {
    expect(sampleRateFrom(undefined, 1)).toBe(1);
    expect(sampleRateFrom("", 1)).toBe(1);
    expect(sampleRateFrom("   ", 0)).toBe(0);
  });

  it("falls back on a typo rather than silently sending nothing", () => {
    expect(sampleRateFrom("half", 1)).toBe(1);
    expect(sampleRateFrom("-0.5", 1)).toBe(1);
    expect(sampleRateFrom("2", 1)).toBe(1);
    expect(sampleRateFrom("NaN", 1)).toBe(1);
  });

  it("honours a valid rate, including an explicit zero", () => {
    expect(sampleRateFrom("0.25", 1)).toBe(0.25);
    expect(sampleRateFrom("0", 1)).toBe(0);
    expect(sampleRateFrom("1", 0)).toBe(1);
  });
});

describe("baseSentryOptions", () => {
  const opts = baseSentryOptions({ dsn: "https://k@o1.ingest.sentry.io/2" });

  it("never sends PII by default", () => {
    expect(opts.sendDefaultPii).toBe(false);
  });

  it("sends errors, not performance data", () => {
    expect(opts.sampleRate).toBe(1);
    expect(opts.tracesSampleRate).toBe(0);
    expect(opts.profilesSampleRate).toBe(0);
  });

  it("routes every event and breadcrumb through the scrubbers", () => {
    const event = opts.beforeSend({ user: { email: "a@b.test" } });
    expect(event.user).toBeUndefined();
    const crumb = opts.beforeBreadcrumb({ data: { url: "/x?secret=1" } });
    expect(crumb.data.url).toBe("/x");
  });

  it("lets tracing be turned on explicitly, and only then", () => {
    expect(baseSentryOptions({ dsn: "d", tracesSampleRate: "0.1" }).tracesSampleRate).toBe(0.1);
    expect(baseSentryOptions({ dsn: "d", tracesSampleRate: "oops" }).tracesSampleRate).toBe(0);
  });

  it("defaults the environment rather than reporting into an unnamed one", () => {
    expect(opts.environment).toBe("development");
    expect(baseSentryOptions({ dsn: "d", environment: "production" }).environment).toBe(
      "production",
    );
  });
});

describe("keepIntegration", () => {
  it("drops the integrations that carry performance data or locals", () => {
    for (const name of DROPPED_INTEGRATIONS) {
      expect(keepIntegration({ name })).toBe(false);
    }
  });

  it("keeps everything else, including the error plumbing", () => {
    for (const name of ["InboundFilters", "Dedupe", "GlobalHandlers", "Breadcrumbs"]) {
      expect(keepIntegration({ name })).toBe(true);
    }
  });
});
