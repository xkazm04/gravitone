const BASE = process.env.GRAVITONE_URL ?? "http://127.0.0.1:8080";

export async function GET() {
  try {
    const r = await fetch(`${BASE}/v1/characters`, { cache: "no-store" });
    if (!r.ok) return new Response("upstream error", { status: 502 });
    return new Response(await r.text(), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return new Response("backend unreachable", { status: 503 });
  }
}
