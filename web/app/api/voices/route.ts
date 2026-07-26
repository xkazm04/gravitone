// Voice list + clone-from-upload, proxied to the Gravitone backend.
import { NextRequest } from "next/server";

import { proxyJson } from "@/lib/backend";

export async function GET() {
  return proxyJson(`/v1/voices`);
}

export async function POST(req: NextRequest) {
  // multipart passthrough: file + name + tags
  return proxyJson(`/v1/voices`, {
    method: "POST",
    body: await req.formData(),
    timeoutMs: 300_000, // cloning loads a model (~20s+)
  });
}
