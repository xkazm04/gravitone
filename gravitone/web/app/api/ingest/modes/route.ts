import { proxyJson } from "@/lib/backend";

// The upload panel's source of truth for what sovereign mode cannot do, and
// for which mode `auto` will resolve to. Static segment, so Next matches it
// ahead of [job] — and the backend declares /modes ahead of /{job_id} for the
// same reason.
export async function GET() {
  return proxyJson("/v1/ingest/modes");
}
