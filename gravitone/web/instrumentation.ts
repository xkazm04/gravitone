/**
 * Next's server instrumentation hook — the studio's one server-side entry
 * point for error reporting, and the gate that keeps it off by default.
 *
 * The DSN check happens BEFORE the dynamic `import()`, deliberately. Calling
 * `Sentry.init({ dsn: undefined })` would also send nothing, but it would load
 * the SDK and let it patch `fetch`, `console` and the process-level
 * `uncaughtException` / `unhandledRejection` handlers. On a product whose
 * claim is that it runs on your box and nothing leaves it, "installed but
 * quiet" is not the same promise as "not installed". With SENTRY_DSN unset,
 * `@sentry/nextjs` is never evaluated in this process.
 */
import type { Instrumentation } from "next";

/** The DSN this runtime should use, or "" for off. */
function dsn(): string {
  return process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN || "";
}

export async function register(): Promise<void> {
  if (!dsn().trim()) return;
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  } else if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

/**
 * Errors thrown while rendering a route, a server component or a route
 * handler. Next calls this for App Router failures that never reach a
 * try/catch — the ones that today reach stdout and stop there.
 *
 * Guarded by the same DSN check: with no DSN this is a function that returns
 * immediately and imports nothing.
 */
export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  context,
) => {
  if (!dsn().trim()) return;
  const Sentry = await import("@sentry/nextjs");
  // `captureRequestError` reads `request.headers` to reconstruct the trace
  // context. The event it produces still goes through `beforeSend`, which
  // deletes headers, cookies, body and user before anything is transmitted.
  Sentry.captureRequestError(error, request, context);
};
