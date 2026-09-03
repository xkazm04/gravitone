// The recording's own dialogue, addressed to the Characters the cast created.
//
// Read-only and cheap (the service merges lines out of the transcript it
// already has), and it answers `{available:false, reason}` far more often than
// it fails — those reasons are what the "open as scene" affordance prints
// INSTEAD of rendering a dead button, so they must reach the browser intact.
import { NextRequest } from "next/server";
import { proxyJson } from "@/lib/backend";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ job: string }> }) {
  const { job } = await ctx.params;
  return proxyJson(`/v1/ingest/${encodeURIComponent(job)}/scene`, { credential: "operator" });
}
