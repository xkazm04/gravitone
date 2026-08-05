import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { proxyJson } from "@/lib/backend";

/**
 * Entity tag for one job payload: a strong hash of the exact bytes.
 *
 * Strong, not weak, and content-derived rather than a version counter — the
 * service has no revision to expose (`get_job` projects a dict of public keys
 * out of an in-memory job) and, because the deployment is N single-worker
 * processes behind SO_REUSEPORT, any counter this proxy kept would be per
 * replica and would disagree with itself between polls.
 */
function etagOf(body: string): string {
  return `"${createHash("sha256").update(body).digest("base64url")}"`;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ job: string }> }) {
  // The poller — hit every 1-5s during a job. proxyJson gives it the read
  // timeout it never had (a hung backend used to pin this handler open).
  const { job } = await ctx.params;
  const upstream = await proxyJson(`/v1/ingest/${encodeURIComponent(job)}`, { credential: "operator" });
  // Refusals, 503s and empty bodies pass through untouched: an ETag on an
  // error would let a client validate a failure as if it were the job.
  if (!upstream.ok || upstream.status === 204) return upstream;

  // A job's payload is its WHOLE result — every stem, the casting map, and each
  // segment with its transcript — re-shipped on every poll of a step that has
  // not moved, then re-parsed and re-rendered on arrival. Most polls of a long
  // step change nothing, and while the review screen is merely being watched
  // NOTHING ever changes.
  //
  // The trade-off is stated rather than hidden: this proxy still pays the full
  // upstream fetch (the service exposes no validator of its own, and giving it
  // one is a service change). What the 304 buys is the bytes over the wire, the
  // JSON parse, and — the one that shows — the dispatch and re-render of a
  // ledger the user is mid-edit on.
  const body = await upstream.text();
  const etag = etagOf(body);
  const headers = new Headers({
    "Content-Type": "application/json",
    ETag: etag,
    // The validator is this handler's, not a licence for anything in between to
    // answer on the backend's behalf: every poll still arrives here.
    "Cache-Control": "no-store",
  });
  if (req.headers.get("If-None-Match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, { status: upstream.status, headers });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ job: string }> }) {
  const { job } = await ctx.params;
  return proxyJson(`/v1/ingest/${encodeURIComponent(job)}`, { credential: "operator", method: "DELETE" });
}
