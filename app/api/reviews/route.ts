// Create a client-review link from 2-6 shared takes.
import { backendFetch } from "@/lib/backend";

export async function POST(req: Request) {
  try {
    const r = await backendFetch(`/v1/reviews`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: await req.text(),
    });
    return new Response(await r.text(), { status: r.status, headers: { "Content-Type": "application/json" } });
  } catch {
    return new Response(JSON.stringify({ detail: "backend unreachable" }), {
      status: 503, headers: { "Content-Type": "application/json" },
    });
  }
}
