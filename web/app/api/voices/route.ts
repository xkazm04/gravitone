// Voice list + clone-from-upload, proxied to the Gravitone backend.
import { NextRequest } from "next/server";

import { backendFetch, jsonError } from "@/lib/backend";

export async function GET() {
  try {
    const r = await backendFetch(`/v1/voices`, { cache: "no-store" });
    if (!r.ok) return jsonError("upstream error", 502);
    return new Response(await r.text(), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return jsonError("backend unreachable", 503);
  }
}

export async function POST(req: NextRequest) {
  // multipart passthrough: file + name + tags
  try {
    const form = await req.formData();
    const upstream = await backendFetch(`/v1/voices`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(300_000), // cloning loads a model (~20s+)
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return jsonError("backend unreachable", 503);
  }
}
