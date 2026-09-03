// Remove an empty custom emotion slot (backend 409s while a Voice occupies it).
import { NextRequest } from "next/server";
import { proxyJson } from "@/lib/backend";

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string; emotion: string }> }) {
  const { id, emotion } = await ctx.params;
  return proxyJson(
    `/v1/characters/${encodeURIComponent(id)}/emotions/${encodeURIComponent(emotion)}`,
    { credential: "operator", method: "DELETE" },
  );
}
