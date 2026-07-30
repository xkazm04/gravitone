// The studio's ear. Proxies the service's own `/v1/speech-to-text` (local
// faster-whisper, word timestamps included) so the punch-in editor can ask
// "where in this take is that word" without the browser ever seeing the API key.
//
// Same shape as /api/takes: a multipart body forwarded whole through proxyJson,
// which owns the status passthrough (a 503 "faster-whisper is not installed" and
// a 413 "clip too long" are different answers and both must survive), the
// unreachable-backend JSON shape, and the timeout.
import { jsonError, proxyJson } from "@/lib/backend";

// Transcription is CPU-bound on the same box that synthesizes: whisper runs at
// roughly 5-10x realtime, so a 3-minute take is well inside this budget while a
// hung backend still cannot pin the route open.
const STT_TIMEOUT_MS = 180_000;

// A take, not a recording session. The service enforces its own MAX_UPLOAD_BYTES
// and clip-length limits; this only stops the studio from buffering something
// absurd on the way there.
const MAX_STT_BODY_BYTES = 32 * 1024 * 1024;

const tooLarge = () =>
  jsonError(
    `recording is larger than the ${Math.round(MAX_STT_BODY_BYTES / (1024 * 1024))} MB the studio forwards`,
    413,
  );

export async function POST(req: Request) {
  // The multipart envelope is forwarded BYTE FOR BYTE rather than parsed and
  // rebuilt here. The service owns the field grammar (`file`, `language_code`,
  // `timestamps_granularity`, `diarize`…) and validates it; re-encoding the
  // upload in the middle would only add a place for the two to disagree — and
  // would silently drop any field this route had not heard of.
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return jsonError("expected a multipart upload carrying the audio as `file`", 400);
  }
  const declared = req.headers.get("content-length");
  if (declared && Number(declared) > MAX_STT_BODY_BYTES) return tooLarge();
  const body = new Uint8Array(await req.arrayBuffer());
  // A missing/lying Content-Length is exactly how the declared check is evaded.
  if (body.byteLength > MAX_STT_BODY_BYTES) return tooLarge();
  if (body.byteLength === 0) return jsonError("no audio in the upload", 400);
  return proxyJson("/v1/speech-to-text", {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
    timeoutMs: STT_TIMEOUT_MS,
  });
}
