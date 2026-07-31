// Derive an emotion slot instead of recording it (Emotion Algebra).
//
// A plain passthrough, and the status code matters more here than on most of
// these proxies: the backend answers 501 when this server cannot read embeddings
// at all, 422 when there is no basis / the emotion does not transfer, 409 when
// the slot is taken — three different things for the user to do next, each with
// its own `detail` sentence. `proxyJson` forwards both, so the rack can render
// the reason verbatim rather than inventing "derive failed".
import { NextRequest } from "next/server";
import { proxyJson } from "@/lib/backend";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; emotion: string }> },
) {
  const { id, emotion } = await ctx.params;
  return proxyJson(
    `/v1/characters/${encodeURIComponent(id)}/emotions/${encodeURIComponent(emotion)}/derive`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: await req.text(),
    },
  );
}
