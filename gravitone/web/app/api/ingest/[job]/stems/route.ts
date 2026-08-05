// Re-splice this job's stems from the segments the user cast into them.
//
// Plain JSON in, plain JSON out — `proxyJson` already passes the upstream status
// (and Retry-After) straight through, which is what the studio needs: every
// refusal on this path is a NAMED 400/409 the board renders next to the row that
// caused it, not a generic failure. The body is a small index map; the service
// caps the selection itself, so the shared write timeout is the right budget.
import { NextRequest } from "next/server";
import { proxyJson, readCappedText } from "@/lib/backend";

// {assignments: {emotion: [ints]}, reset?: bool}. The service caps a stem at 200
// segments, so a body anywhere near this is not a request worth relaying.
const MAX_BODY_BYTES = 16 * 1024;

export async function POST(req: NextRequest, ctx: { params: Promise<{ job: string }> }) {
  const { job } = await ctx.params;
  const body = await readCappedText(req, MAX_BODY_BYTES);
  if (body instanceof Response) return body;
  return proxyJson(`/v1/ingest/${encodeURIComponent(job)}/stems`, {
    credential: "operator",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}
