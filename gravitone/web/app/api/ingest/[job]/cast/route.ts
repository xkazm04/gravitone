// Cast N speakers of one recording into N Characters.
//
// The sibling of `speaker/route.ts`: plain JSON in, plain JSON out, with every
// refusal (400 for the selection, 409 for a job that has left the speaker step,
// 422 for the attestation, 429 with Retry-After from the admission gate) passed
// straight through — the studio renders each of those next to the control that
// caused it, and a generic failure here would flatten five different facts.
import { NextRequest } from "next/server";
import { proxyJson, readCappedText } from "@/lib/backend";

// {members: [{speaker_id, character}], attested, statement}. Six members and a
// consent sentence; anything near this cap is not a request worth relaying.
const MAX_BODY_BYTES = 8 * 1024;

export async function POST(req: NextRequest, ctx: { params: Promise<{ job: string }> }) {
  const { job } = await ctx.params;
  const body = await readCappedText(req, MAX_BODY_BYTES);
  if (body instanceof Response) return body;
  return proxyJson(`/v1/ingest/${encodeURIComponent(job)}/cast`, {
    credential: "operator",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}
