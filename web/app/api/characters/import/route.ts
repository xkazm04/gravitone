// Import a Character Pack (.gravichar) — multipart passthrough to the backend.
import { proxyJson } from "@/lib/backend";

export async function POST(req: Request) {
  return proxyJson(`/v1/characters/import`, {
    method: "POST",
    body: await req.formData(),
    timeoutMs: 120_000,
  });
}
