// Mint a custom emotion slot on one Character.
import { NextRequest } from "next/server";
import { proxyJson } from "@/lib/backend";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return proxyJson(`/v1/characters/${encodeURIComponent(id)}/emotions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: await req.text(),
  });
}
