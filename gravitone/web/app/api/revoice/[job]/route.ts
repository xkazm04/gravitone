import { proxyJson } from "@/lib/backend";

export async function GET(_req: Request, ctx: { params: Promise<{ job: string }> }) {
  const { job } = await ctx.params;
  return proxyJson(`/v1/revoice/${encodeURIComponent(job)}`, {
    credential: "operator",
  });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ job: string }> }) {
  const { job } = await ctx.params;
  return proxyJson(`/v1/revoice/${encodeURIComponent(job)}`, {
    method: "DELETE",
    credential: "operator",
  });
}
