/**
 * Next's CLIENT instrumentation hook (Next >= 15.3), run in the browser before
 * the app hydrates.
 *
 * `process.env.NEXT_PUBLIC_SENTRY_DSN` is written out longhand because that is
 * the only form Next substitutes at build time — it is a literal text
 * replacement of the exact expression, not a lookup on a `process.env` object
 * that exists in the bundle. Reading it through a helper would produce
 * `undefined` in the browser and silently disable reporting on a deployment
 * that had configured it.
 *
 * The `import()` is inside the `if`, so on a deployment with no DSN the SDK
 * chunk is emitted but never fetched: no Sentry code executes in the visitor's
 * browser, no global handlers are patched, and no request leaves the page.
 * That is the same guarantee instrumentation.ts makes on the server.
 */
import { baseSentryOptions, keepIntegration, sentryEnabled } from "@/lib/sentry";

const DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (sentryEnabled(DSN)) {
  void (async () => {
    const Sentry = await import("@sentry/nextjs");
    Sentry.init({
      ...baseSentryOptions({
        dsn: DSN,
        environment:
          process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV,
        release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
        sampleRate: process.env.NEXT_PUBLIC_SENTRY_SAMPLE_RATE,
        // Tracing stays off in the browser regardless: the studio's hot path is
        // audio streaming, and a transaction per synthesis is volume with no
        // incident value. There is deliberately no env var to turn it on here.
        tracesSampleRate: "0",
      }),
      integrations: (defaults) => defaults.filter(keepIntegration),
    });
  })();
}
