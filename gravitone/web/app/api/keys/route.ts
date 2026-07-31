import { proxyJson } from "@/lib/backend";

export async function GET() {
  return proxyJson(`/v1/keys`);
}

export async function POST(req: Request) {
  return proxyJson(`/v1/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: await req.text(),
  });
}
