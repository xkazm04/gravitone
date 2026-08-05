import { proxyJson } from "@/lib/backend";

export async function GET() {
  return proxyJson(`/v1/keys`, { credential: "operator" });
}

export async function POST(req: Request) {
  return proxyJson(`/v1/keys`, {
    credential: "operator",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: await req.text(),
  });
}
