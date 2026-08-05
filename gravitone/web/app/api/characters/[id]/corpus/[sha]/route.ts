// Remove every segment and stem derived from ONE kept recording.
//
// The service deliberately answers with a REPORT rather than a 204
// (service/ingest_api.py::delete_corpus_clip): a deletion the user cannot see
// the shape of is one they have to take on trust. So this route must pass the
// body through — `proxyJson` does, including a 404 ("no recording with that clip
// hash") and its `detail`. Returning `new Response(null, {status: 204})` here
// would throw away the only evidence the deletion happened.
import { NextRequest } from "next/server";
import { proxyJson } from "@/lib/backend";

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; sha: string }> },
) {
  const { id, sha } = await ctx.params;
  return proxyJson(
    `/v1/characters/${encodeURIComponent(id)}/corpus/${encodeURIComponent(sha)}`,
    { credential: "operator", method: "DELETE" },
  );
}
