// The ONE list of upstream response headers the studio's proxy routes forward
// to the browser.
//
// It mirrors `service/app.py::CORS_EXPOSE_HEADERS` — the service's own answer to
// "which headers is a client meant to read". Before this existed, three routes
// (/api/speak, /api/performance, /api/tts) each kept a hand-maintained subset of
// that list, every one of them shorter than the service's, and nothing failed
// when they drifted. That is how `X-Synth-Segments` came to be emitted by both
// premium routes and never reach a browser at all, and how the only route that
// emits `X-Cache` dropped it.
//
// `lib/serviceHeaders.test.ts` fails the suite when this list and the service's
// diverge, so adding a header in app.py is the whole change: the proxy already
// forwards it.

/** Mirror of service/app.py::CORS_EXPOSE_HEADERS. Keep sorted as it is there. */
export const SERVICE_EXPOSED_HEADERS = [
  "ETag",
  "Retry-After",
  "X-Alignment-Cache",
  "X-Audio-Seconds",
  "X-Cache",
  "X-Character",
  "X-Emotion-Fallback",
  "X-Emotion-Requested",
  "X-Emotion-Used",
  "X-Fidelity-Deltas",
  "X-Fidelity-Retries",
  "X-Fidelity-Score",
  "X-Fidelity-Unavailable",
  "X-Gravitone-Cache",
  "X-Gravitone-Deadline",
  "X-Ignored-Settings",
  "X-Performance-Report",
  "X-Quality-Level",
  "X-Queue-Seconds",
  "X-Realtime-Factor",
  "X-Sample-Rate",
  "X-Segments",
  "X-Speech-Digest",
  "X-Stream",
  // Why an mp3 "stream" arrived as one body. Forwarded, not swallowed: the
  // studio's proxy hiding it would put the caveat only on the header a browser
  // cannot see, which is the same as not saying it.
  "X-Stream-Fallback",
  "X-Stream-Segments",
  "X-Synth-Seconds",
  "X-Synth-Segments",
] as const;

/**
 * Copy every exposed header the upstream response ACTUALLY set onto `to`.
 *
 * Forwarding the whole exposed set is deliberate: a route cannot emit a header
 * that this misses, and a header the upstream did not send is OMITTED rather
 * than forwarded as `""` (the old /api/tts wrote empty strings, so a client
 * reading `X-Audio-Seconds` got "" instead of null and `Number("")` → 0).
 */
export function forwardExposedHeaders(from: Headers, to: Headers): Headers {
  for (const h of SERVICE_EXPOSED_HEADERS) {
    const v = from.get(h);
    if (v) to.set(h, v);
  }
  return to;
}
