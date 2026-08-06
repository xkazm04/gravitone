// The paste-time verdict: what will happen to this link, before any media
// moves. service/ingest_api.py::probe_link (POST /v1/ingest/link/probe).
//
// It exists because the studio's own duration pre-check
// (app/voices/new/_state/uploadLimits.ts) can only run on a File — a pasted URL
// has no bytes to decode — so without this call a two-hour podcast is refused
// only after the download. One metadata call answers instead: fits / will be
// trimmed to the first 15 minutes / cannot be used, and why.
//
// The body is a VERDICT, not a status code: `ok: false` is a link we read and
// refused (too short, no readable length) and it carries the sentence to print.
// Only a link that could not be READ is an error status — 403 not YouTube, 422
// private/unavailable, 429 budget (Retry-After rides along), 503 no extractor —
// and those `detail` strings all name the file-drop fallback.
import { NextRequest } from "next/server";
import { proxyJson, readCappedText } from "@/lib/backend";

// {url}. Anything larger than this is not a link.
const MAX_BODY_BYTES = 4 * 1024;

export async function POST(req: NextRequest) {
  const body = await readCappedText(req, MAX_BODY_BYTES);
  if (body instanceof Response) return body;
  return proxyJson(`/v1/ingest/link/probe`, {
    credential: "operator",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    // Metadata only, but it is still a round-trip to YouTube from the box.
    timeoutMs: 30_000,
  });
}
