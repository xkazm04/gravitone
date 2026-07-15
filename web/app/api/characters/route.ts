import { backendFetch, jsonError } from "@/lib/backend";

export async function GET() {
  try {
    const r = await backendFetch(`/v1/characters`, { cache: "no-store" });
    if (!r.ok) return jsonError("upstream error", 502);
    return new Response(await r.text(), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return jsonError("backend unreachable", 503);
  }
}
