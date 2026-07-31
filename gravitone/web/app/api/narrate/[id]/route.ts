import { proxyJson } from "@/lib/backend";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[a-z0-9]{1,32}$/i.test(id)) return Response.json({ detail: "not a narration id" }, { status: 400 });
  return proxyJson(`/v1/narrate/${id}`);
}
