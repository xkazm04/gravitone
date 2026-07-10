// Backend health + live metrics, proxied so the browser never talks to the
// service directly. Feeds the savings ticker in the app shell.
import { backendFetch } from "@/lib/backend";

export async function GET() {
  try {
    const r = await backendFetch(`/health`, { cache: "no-store" });
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
