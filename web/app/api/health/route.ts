// Backend health + live metrics, proxied so the browser never talks to the
// service directly. Feeds the savings ticker in the app shell.
import { backendFetch, READ_TIMEOUT_MS } from "@/lib/backend";

// Deliberately NOT proxyJson: every consumer of this route reads `status`
// (useHealthPoll -> the playground's engine notice, SavingsTicker, the
// benchmarks view), and proxyJson's unreachable body is `{detail: …}`, which
// would leave `status` undefined. What it DOES have to share with the other
// proxy reads is the timeout — this was the one read that could pin a route
// handler open on a backend that accepts the connection and never answers,
// while the playground re-polls it every 5 seconds during a render.
export async function GET() {
  try {
    const r = await backendFetch(`/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    return new Response(await r.text(), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return new Response(JSON.stringify({ status: "unreachable" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
}
