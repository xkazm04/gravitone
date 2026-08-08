import { proxyJson } from "@/lib/backend";

// One voiceover job: poll it, cancel it. Replica-affine like ingest jobs —
// the poller talks to whichever process answered the POST.
export async function GET(_req: Request, ctx: { params: Promise<{ job: string }> }) {
  const { job } = await ctx.params;
  return proxyJson(`/v1/voiceover/${encodeURIComponent(job)}`, {
    credential: "operator",
  });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ job: string }> }) {
  const { job } = await ctx.params;
  return proxyJson(`/v1/voiceover/${encodeURIComponent(job)}`, {
    method: "DELETE",
    credential: "operator",
  });
}
