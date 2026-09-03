/**
 * The studio's error reporting — the part of it that is pure, and therefore
 * testable.
 *
 * Gravitone's whole claim is that it runs on a box you own and nothing leaves
 * it. An error tracker is the one piece of infrastructure that exists to make
 * something leave, so it is built here as an OPT-IN with a hard off switch
 * rather than a default with an escape hatch:
 *
 *   - No DSN, no SDK. `instrumentation.ts` and `instrumentation-client.ts`
 *     both check for a DSN BEFORE they `import("@sentry/nextjs")`. With the
 *     variable unset the SDK module is never evaluated, `Sentry.init` is never
 *     called, no transport is constructed and no socket is opened. This is a
 *     stronger guarantee than the SDK's own "init with an undefined dsn is a
 *     no-op" behaviour, which is true but leaves the library loaded and its
 *     integrations patched into fetch, console and the global error handlers.
 *   - Errors only. `tracesSampleRate` and `profilesSampleRate` default to 0,
 *     so no transaction and no profile is ever sent; the browser-tracing and
 *     local-variables integrations are removed outright rather than merely
 *     sampled to nothing.
 *   - Nothing about a person. This app handles voice recordings, transcripts
 *     and consent receipts. `sendDefaultPii` is false — the SDK's own default,
 *     set explicitly here so it cannot drift — and on top of that
 *     `scrubEvent` deletes the request body, cookies, headers and user object
 *     from every event, and strips query strings off URLs in events and
 *     breadcrumbs alike (an API key pasted into a query string is exactly the
 *     kind of thing that ends up in a breadcrumb).
 *
 * The sample rate deserves a word. `tracesSampleRate` is 0 because performance
 * data is volume with no incident value here. `sampleRate` — the ERROR rate —
 * defaults to 1: an error tracker that silently drops three quarters of its
 * errors is worse than no error tracker, because it turns "we never saw that"
 * into an unreliable statement. Volume control is a knob (SENTRY_SAMPLE_RATE /
 * NEXT_PUBLIC_SENTRY_SAMPLE_RATE), not a default, and Sentry's own client-side
 * dedupe plus server-side rate limiting already blunt the flood case.
 */

/** The subset of a Sentry event this module knows how to strip. */
export interface ScrubbableEvent {
  request?: {
    url?: string;
    query_string?: unknown;
    data?: unknown;
    cookies?: unknown;
    headers?: unknown;
  };
  user?: unknown;
}

/** The subset of a Sentry breadcrumb this module knows how to strip. */
export interface ScrubbableBreadcrumb {
  data?: { url?: unknown; [key: string]: unknown };
}

/**
 * `url` with everything from the first `?` or `#` removed.
 *
 * Deliberately string surgery rather than `new URL`: breadcrumb URLs are
 * routinely relative ("/api/tts?voice=..."), which `new URL` throws on, and a
 * throw inside `beforeBreadcrumb` would take the event with it.
 */
export function stripQuery(url: string): string {
  const cut = Math.min(
    ...[url.indexOf("?"), url.indexOf("#")].filter((i) => i >= 0),
    url.length,
  );
  return url.slice(0, cut);
}

/**
 * Remove everything that could carry a person, a credential or a recording
 * from an event, in place, and return it.
 *
 * Headers go wholesale rather than by deny-list: this app authenticates with
 * `xi-api-key` AND `Authorization` AND a Firebase ID token, and a deny-list is
 * a promise to remember the next one.
 */
export function scrubEvent<E extends ScrubbableEvent>(event: E): E {
  delete event.user;
  const request = event.request;
  if (request) {
    delete request.data;
    delete request.cookies;
    delete request.headers;
    delete request.query_string;
    if (typeof request.url === "string") request.url = stripQuery(request.url);
  }
  return event;
}

/** As `scrubEvent`, for the URL a breadcrumb records. */
export function scrubBreadcrumb<B extends ScrubbableBreadcrumb>(crumb: B): B {
  const url = crumb.data?.url;
  if (crumb.data && typeof url === "string") crumb.data.url = stripQuery(url);
  return crumb;
}

/**
 * A sample rate from an env var, or `fallback` if it is unset, unparseable or
 * outside 0..1 — a typo must never silently mean "send nothing".
 */
export function sampleRateFrom(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) return fallback;
  return value;
}

/** True only for a DSN that is present and non-blank. */
export function sentryEnabled(dsn: string | undefined): dsn is string {
  return typeof dsn === "string" && dsn.trim() !== "";
}

export interface SentryOptionsInput {
  dsn: string;
  environment?: string;
  release?: string;
  /** Raw env value; see `sampleRateFrom`. */
  sampleRate?: string;
  /** Raw env value. Anything but a valid non-zero rate leaves tracing OFF. */
  tracesSampleRate?: string;
}

/**
 * The `Sentry.init` options shared by the browser, node and edge runtimes.
 *
 * Kept as a plain object factory so the posture above is asserted by tests
 * rather than by reading three near-identical config files.
 */
export function baseSentryOptions(input: SentryOptionsInput) {
  return {
    dsn: input.dsn,
    environment: input.environment || "development",
    release: input.release,
    // Explicit, not inherited: this is the single setting that decides whether
    // IP addresses, cookies and user ids ride along with an event.
    sendDefaultPii: false,
    sampleRate: sampleRateFrom(input.sampleRate, 1),
    tracesSampleRate: sampleRateFrom(input.tracesSampleRate, 0),
    profilesSampleRate: 0,
    // A stack trace plus a breadcrumb trail is the payload; 30 crumbs is
    // plenty of trail and a smaller surface than the default 100.
    maxBreadcrumbs: 30,
    beforeSend: <E extends ScrubbableEvent>(event: E): E => scrubEvent(event),
    beforeBreadcrumb: <B extends ScrubbableBreadcrumb>(crumb: B): B =>
      scrubBreadcrumb(crumb),
  };
}

/**
 * Integration names dropped from the SDK defaults, on every runtime.
 *
 * `BrowserTracing` / `Express` / `Http` spans are performance data, which is
 * out of scope. `LocalVariables` attaches the local scope of every frame in a
 * stack trace — in this service that means API keys, decoded audio and
 * transcript text — and is the one default that could smuggle exactly what
 * `scrubEvent` exists to remove, since it lives inside the exception rather
 * than in `event.request`.
 */
export const DROPPED_INTEGRATIONS = ["BrowserTracing", "LocalVariables"];

/** `defaults.filter(keepIntegration)` — usable as the `integrations` callback. */
export function keepIntegration(integration: { name: string }): boolean {
  return !DROPPED_INTEGRATIONS.includes(integration.name);
}
