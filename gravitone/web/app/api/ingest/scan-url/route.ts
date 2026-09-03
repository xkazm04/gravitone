// Start a scan from a pasted YouTube link instead of an uploaded file.
// service/ingest_api.py::start_scan_url — the backend fetches the audio and
// then joins the ordinary analyze path, so the response is the same
// `{job_id, mode}` (plus a `source` marker) the upload door answers with and
// the studio polls it on the SAME surface (GET /api/ingest/{job}).
//
// Forwarding the status codes faithfully is the point here too: the backend
// answers its refusals by name and synchronously —
//   400/403 — the link is not a http(s) YouTube URL, or resolves somewhere
//             this box will not fetch from,
//   413     — the audio is over the byte ceiling,
//   422     — the extractor could not get audio (private/age-gated/removed),
//   429     — the scan budget or the admission gate is full (Retry-After rides
//             along, and the studio counts down on it),
//   503     — this deployment has no extractor installed,
// so the paste box states what happened instead of spinning. The `detail`
// strings are written for humans and never carry yt-dlp's own output.
//
// The download itself is slow (a real fetch), which is why the timeout is the
// scan-sized one rather than the default.
import { NextRequest } from "next/server";
import { proxyJson, readCappedText } from "@/lib/backend";

// {url, mode?, corpus?}. A URL far past this is not a link worth relaying.
const MAX_BODY_BYTES = 4 * 1024;

export async function POST(req: NextRequest) {
  const body = await readCappedText(req, MAX_BODY_BYTES);
  if (body instanceof Response) return body;
  return proxyJson(`/v1/ingest/scan-url`, {
    credential: "operator",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    timeoutMs: 240_000,
  });
}
