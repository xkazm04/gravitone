const BASE = process.env.GRAVITONE_URL ?? "http://127.0.0.1:8080";

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const r = await fetch(`${BASE}/v1/ingest/scan`, {
      method: "POST", body: form, signal: AbortSignal.timeout(120_000),
    });
    return new Response(await r.text(), { status: r.status, headers: { "Content-Type": "application/json" } });
  } catch {
    return new Response(JSON.stringify({ detail: "backend unreachable" }), { status: 503, headers: { "Content-Type": "application/json" } });
  }
}
