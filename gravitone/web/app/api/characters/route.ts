import { proxyJson } from "@/lib/backend";

export async function GET() {
  // Status passthrough — a backend 404/429 must not read as a generic 502.
  return proxyJson(`/v1/characters`, { credential: "operator" });
}
