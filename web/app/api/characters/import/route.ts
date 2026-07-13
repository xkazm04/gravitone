// Import a Character Pack (.gravichar) — multipart passthrough to the backend.
import { backendFetch } from "@/lib/backend";

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const r = await backendFetch(`/v1/characters/import`, {
      method: "POST", body: form, signal: AbortSignal.timeout(120_000),
    });
    return new Response(await r.text(), { status: r.status, headers: { "Content-Type": "application/json" } });
  } catch {
    return new Response(JSON.stringify({ detail: "backend unreachable" }), {
      status: 503, headers: { "Content-Type": "application/json" },
    });
  }
}
