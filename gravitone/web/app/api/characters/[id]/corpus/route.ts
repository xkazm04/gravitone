// What audio of this person the box kept — the read half of the retention
// surface (service/ingest_api.py::get_corpus).
//
// A plain `proxyJson` passthrough on purpose. The service answers a character
// with NO corpus as an empty view (`totals.clips = 0`) rather than a 404,
// because "this box keeps nothing of yours" IS the answer to the question — so
// the route must not invent a 404 either. Anything that IS an error (a bad
// character id → 400, an unreachable backend → 503) keeps its status and its
// `detail`, which is what the panel renders verbatim.
//
// Deliberately NOT streamIngestAsset's shape: that helper flattens every non-OK
// upstream to a bare "not found", which would turn "the corpus index is
// unreadable" into "you have no corpus" — the exact lie this surface exists to
// prevent.
import { NextRequest } from "next/server";
import { proxyJson } from "@/lib/backend";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return proxyJson(`/v1/characters/${encodeURIComponent(id)}/corpus`, { credential: "operator" });
}
