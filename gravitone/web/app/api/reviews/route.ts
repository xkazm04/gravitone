// Create a client-review link from 2-6 shared takes.
import { proxyJson } from "@/lib/backend";

export async function POST(req: Request) {
  return proxyJson(`/v1/reviews`, {
    credential: "operator",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: await req.text(),
  });
}
