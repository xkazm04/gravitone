// The uploaded half of the mocked library — the location scout's inbox.
// Split from the generated half purely for file-size discipline; assets.ts
// is the one import surface.

import type { Asset } from "./types";

export const SOURCE_ASSETS: Asset[] = [
  {
    id: "scr-1",
    kind: "script",
    title: "Glass Harbor — shooting script v4",
    mime: "application/pdf",
    bytes: 412_000,
    createdAt: "2026-08-08T09:12:00Z",
    caption:
      "Heist short, 12 pages. Two leads (MARLA, DUSK), night-exterior harbor setting, three acts with a rooftop reversal in act two.",
    captionStatus: "written",
    tags: ["script", "glass-harbor"],
    collection: "Glass Harbor / Source",
    provenance: { source: "upload", parentIds: [] },
    tone: "from-slate-800 via-slate-900 to-slate-950",
  },
  {
    id: "vid-1",
    kind: "video",
    title: "harbor_night_take3.mp4",
    mime: "video/mp4",
    bytes: 148_000_000,
    createdAt: "2026-08-08T09:20:00Z",
    durationS: 94,
    dims: "3840×2160",
    caption:
      "Handheld night exterior along a container pier; a figure in a dark coat walks toward camera past sodium lamps; light rain, wet asphalt reflections.",
    captionStatus: "written",
    tags: ["footage", "night", "glass-harbor"],
    collection: "Glass Harbor / Source",
    provenance: { source: "upload", parentIds: [] },
    tone: "from-cyan-950 via-slate-900 to-slate-950",
  },
  {
    id: "vid-2",
    kind: "video",
    title: "drone_rooftop_broll.mp4",
    mime: "video/mp4",
    bytes: 96_400_000,
    createdAt: "2026-08-10T07:55:00Z",
    durationS: 61,
    dims: "3840×2160",
    caption: null,
    captionStatus: "pending",
    tags: ["footage", "aerial"],
    collection: "Inbox",
    provenance: { source: "upload", parentIds: [] },
    tone: "from-sky-950 via-slate-900 to-slate-950",
  },
  {
    id: "img-1",
    kind: "image",
    title: "location_pier7.jpg",
    mime: "image/jpeg",
    bytes: 4_100_000,
    createdAt: "2026-08-08T09:31:00Z",
    dims: "6000×4000",
    caption:
      "Wide daylight reference of Pier 7: stacked containers left, cranes on the skyline, open concrete apron in the foreground.",
    captionStatus: "written",
    tags: ["location", "reference"],
    collection: "Glass Harbor / Source",
    provenance: { source: "upload", parentIds: [] },
    tone: "from-amber-950/70 via-slate-900 to-slate-950",
  },
  {
    id: "img-2",
    kind: "image",
    title: "cast_marla_ref.jpg",
    mime: "image/jpeg",
    bytes: 2_800_000,
    createdAt: "2026-08-08T09:33:00Z",
    dims: "3000×2000",
    caption: null,
    captionStatus: "failed",
    captionError:
      "The caption provider refused the request (429, retry budget spent). The image is filed; captioning can be retried.",
    tags: ["cast", "reference"],
    collection: "Glass Harbor / Source",
    provenance: { source: "upload", parentIds: [] },
    tone: "from-rose-950/60 via-slate-900 to-slate-950",
  },
];
