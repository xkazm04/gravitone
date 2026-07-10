import { backendFetch } from "@/lib/backend";

export async function GET() {
  try {
    const r = await backendFetch(`/v1/keys`, { cache: "no-store" });
    if (!r.ok) return new Response("upstream error", { status: 502 });
    return new Response(await r.text(), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch {
    return new Response("backend unreachable", { status: 503 });
  }
}

export async function POST(req: Request) {
  try {
    const r = await backendFetch(`/v1/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: await req.text(),
    });
    return new Response(await r.text(), { status: r.status, headers: { "Content-Type": "application/json" } });
  } catch {
    return new Response(JSON.stringify({ detail: "backend unreachable" }), { status: 503, headers: { "Content-Type": "application/json" } });
  }
}
