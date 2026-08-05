/**
 * Sentry for the Node runtime — the API proxies under app/api, the server
 * components, and the route handlers that hold GRAVITONE_API_KEY.
 *
 * This module is only ever reached through `instrumentation.ts`, which imports
 * it dynamically AND ONLY IF a DSN is set. Nothing here runs on a deployment
 * that has not opted in; the module is not even evaluated. See lib/sentry.ts
 * for the full posture and the reason it is built this way round.
 */
import * as Sentry from "@sentry/nextjs";

import { baseSentryOptions, keepIntegration } from "@/lib/sentry";

Sentry.init({
  ...baseSentryOptions({
    // SENTRY_DSN is the server-only name and takes precedence; the public one
    // is honoured as a fallback so a single-DSN deployment sets one variable.
    dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN || "",
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV,
    release: process.env.SENTRY_RELEASE,
    sampleRate: process.env.SENTRY_SAMPLE_RATE,
    tracesSampleRate: process.env.SENTRY_TRACES_SAMPLE_RATE,
  }),
  integrations: (defaults) => defaults.filter(keepIntegration),
});
