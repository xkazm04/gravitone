// The share page's public compute relay: POST /t/{id}/reperform -> the
// service's POST /v1/takes/{id}/reperform.
//
// It lives beside the page it serves rather than under /api because it is not
// a studio API: it is the one endpoint a page whose whole audience is
// logged-out visitors needs, and keeping it here keeps "what a share page can
// do" readable in one directory.
//
// The service is the thing that decides whether this may run at all — the
// publisher's `allow_reperform` flag, the text cap and the per-IP budget all
// live there (service/takes.py, service/ratelimit.py), so a caller who skips
// this proxy is bound by exactly the same rules. proxyJson passes the status
// and the named `detail` through untouched, Retry-After included, which is
// what lets the panel show the refusal verbatim instead of inventing one.

import { proxyJson, readCappedText } from "@/lib/backend";

// A public fork is one edited line, not a script. Far above the service's own
// 1000-character cap so the NAMED "too-long" refusal is what a visitor sees;
// this only stops a body that was never going to be text at all.
const MAX_REPERFORM_BODY_BYTES = 8 * 1024;

export async function POST(req: Request,
                           { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readCappedText(req, MAX_REPERFORM_BODY_BYTES);
  if (body instanceof Response) return body;
  // The visitor's address, forwarded for the service's per-IP budget. The
  // service HONOURS it only when the operator has set TTS_TRUST_PROXY (this
  // studio being the only thing that can reach the port) — otherwise every
  // visitor would share this process's address and one bucket. Passing it is
  // what makes turning that flag on meaningful; it is never trusted here.
  const forwarded = req.headers.get("x-forwarded-for");
  return proxyJson(`/v1/takes/${encodeURIComponent(id)}/reperform`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(forwarded ? { "x-forwarded-for": forwarded } : {}),
    },
    body,
    // A render, not a metadata write: it queues behind the same worker pool
    // every other synthesis uses.
    timeoutMs: 180_000,
  });
}
