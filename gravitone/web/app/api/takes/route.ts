// Persist a rendered take (wav + metadata) for a public share page.
import { proxyJson } from "@/lib/backend";

export async function POST(req: Request) {
  return proxyJson(`/v1/takes`, {
    credential: "operator",
    method: "POST",
    body: await req.formData(),
    timeoutMs: 60_000,
  });
}
