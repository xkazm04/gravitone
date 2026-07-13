// What clients actually approve → the studio's default voice recommendation.
import { backendFetch } from "@/lib/backend";

export async function GET() {
  try {
    const r = await backendFetch(`/v1/reviews/preferred`, { cache: "no-store" });
    return new Response(await r.text(), { status: r.status, headers: { "Content-Type": "application/json" } });
  } catch {
    return new Response(JSON.stringify({ character_id: null, picks: 0 }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
}
