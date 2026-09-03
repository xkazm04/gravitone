/**
 * Sentry for the Edge runtime — in this app that is `middleware.ts`, which
 * decides the CSP and the frame policy for every request.
 *
 * Same contract as sentry.server.config.ts: reached only through
 * `instrumentation.ts`, only when a DSN is set.
 */
import * as Sentry from "@sentry/nextjs";

import { baseSentryOptions, keepIntegration } from "@/lib/sentry";

Sentry.init({
  ...baseSentryOptions({
    dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN || "",
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV,
    release: process.env.SENTRY_RELEASE,
    sampleRate: process.env.SENTRY_SAMPLE_RATE,
    tracesSampleRate: process.env.SENTRY_TRACES_SAMPLE_RATE,
  }),
  integrations: (defaults) => defaults.filter(keepIntegration),
});
