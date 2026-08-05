// Rebuild a character's voices from the audio the box already kept — no upload,
// no cloud call, no new consent (the receipt stored with the audio IS the
// consent). service/ingest_api.py::start_rederive.
//
// The status codes are the whole point of forwarding this one faithfully: the
// service answers its three refusals SYNCHRONOUSLY and by name —
//   404 — nothing has ever been kept for this character,
//   409 — the corpus is over its byte cap, or holds nothing for what was asked,
//   429 — the admission gate is full (Retry-After rides along),
// so a caller learns "you have no corpus" here instead of from a job that fails
// a minute later. `proxyJson` passes status, `detail` and Retry-After through.
//
// On success the body is `{job_id, mode, selection, corpus_rev}` and the job is
// polled on the SAME surface a commit is (GET /api/ingest/{job}).
import { NextRequest } from "next/server";
import { proxyJson, readCappedText } from "@/lib/backend";

// {character_id: string, emotions?: string[]}. The emotion scale is small and
// server-validated; a body anywhere near this is not a request worth relaying.
const MAX_BODY_BYTES = 8 * 1024;

export async function POST(req: NextRequest) {
  const body = await readCappedText(req, MAX_BODY_BYTES);
  if (body instanceof Response) return body;
  return proxyJson(`/v1/ingest/rederive`, {
    credential: "operator",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}
