"use client";

import { useEffect, useState } from "react";
import { apiJson } from "@/lib/apiFetch";
import type { ModeInfo } from "./machine";

/** GET /api/ingest/modes, held as the two facts the mode panel renders. */
export function useIngestModes() {
  // What the BACKEND says each mode does — including which mode `auto` resolves
  // to on this box. The panel below states sovereign's limits from this, never
  // from a copy of the constant kept over here.
  const [modeInfo, setModeInfo] = useState<ModeInfo | null>(null);
  const [modeInfoFailed, setModeInfoFailed] = useState(false);

  // Mode descriptions are backend constants — fetch once. A failure is SAID
  // (the panel can't invent the limits), never swallowed into silence.
  useEffect(() => {
    let alive = true;
    void apiJson<ModeInfo>("/api/ingest/modes", { cache: "no-store" },
      "could not load ingest modes")
      .then((m) => { if (alive) { setModeInfo(m); setModeInfoFailed(false); } })
      .catch(() => { if (alive) setModeInfoFailed(true); });
    return () => { alive = false; };
  }, []);

  return { modeInfo, modeInfoFailed };
}
