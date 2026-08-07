// One recorded track of a conversation (user | agent), streamed for the
// forensic room's players. The two tracks share one timeline, so the client
// can seek both to a turn's at_s and hear the moment.
//
// streamIngestAsset gives this the same contract as every other served wav:
// body streamed (not buffered), refusals passed through with their upstream
// sentences, private cache — a completed recording never changes.
import { NextRequest } from "next/server";

import { streamIngestAsset } from "@/lib/backend";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; track: string }> },
) {
  const { id, track } = await ctx.params;
  return streamIngestAsset(
    `/v1/convai/conversations/${encodeURIComponent(id)}/audio/${encodeURIComponent(track)}`,
    { credential: "operator" },
  );
}
