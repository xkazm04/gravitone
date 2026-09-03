import { proxyJson } from "@/lib/backend";

export async function POST(req: Request) {
  return proxyJson(`/v1/ingest/scan`, {
    credential: "operator",
    method: "POST",
    body: await req.formData(),
    timeoutMs: 120_000,
  });
}
