// The backend's /metrics, proxied so the browser never talks to the service
// directly — and so the operator credential stays server-side.
//
// /metrics is a PROTECTED surface upstream (service/app.py::_require_metrics_access
// requires the observability scope, or a loopback peer). backendFetch attaches
// GRAVITONE_API_KEY, which is exactly why this has to be a proxy route rather
// than a client fetch: a browser has no key to send, and giving it one would
// put an operator credential in a bundle.
//
// proxyJson, not a hand-rolled try/fetch: this read gets the same timeout, the
// same {detail: …} unreachable shape and the same status passthrough as every
// other proxied read, so /ops surfaces a 401 (no key configured) as the real
// 401 it is rather than as "unreachable".
import { proxyJson } from "@/lib/backend";

export async function GET() {
  return proxyJson("/metrics");
}
