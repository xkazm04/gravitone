// The mocked PROJECT — Glass Harbor's story: beats and five scenes, states
// deliberately uneven because a real project always is (scene 5 unpicked,
// scene 3's render rejected, scene 4 in flight).

import type { Beat, Scene } from "./projectTypes";

export const PROJECT = {
  title: "Glass Harbor",
  logline:
    "A crew that never breaks in — they wait for the one door every city leaves unlocked.",
  totalS: 31,
};

export const BEATS: Beat[] = [
  { act: 1, title: "The door", summary: "A harbor at night; the claim that every city has one unlocked door." },
  { act: 2, title: "The crew", summary: "The plan, the crew, the one rule — and the rooftop reversal that breaks it." },
  { act: 3, title: "The water", summary: "Out by the waterline at dawn; the door closes behind them." },
];

export const SCENES: Scene[] = [
  {
    id: "sc-1",
    index: 1,
    slug: "EXT. PIER 7 — NIGHT",
    synopsis: "A figure walks the container pier toward camera; sodium lamps, light rain.",
    mood: "tense / patient",
    targetS: 6,
    lines: [{ speaker: "MARLA", kind: "vo", text: "Every city keeps one door unlocked." }],
    frames: [
      { id: "f-1a", prompt: "Container pier at night, lone figure, sodium lamps, rain", model: "imagen-3", tone: "from-cyan-950 via-slate-900 to-slate-950", note: "picked — the walk reads at trailer scale" },
      { id: "f-1b", prompt: "Same, low angle from the rails", model: "imagen-3", tone: "from-slate-800 via-slate-900 to-black" },
      { id: "f-1c", prompt: "Same, high wide from the crane", model: "imagen-3", tone: "from-indigo-950 via-slate-900 to-slate-950", note: "too far — the figure vanishes" },
    ],
    pickedFrameId: "f-1a",
    clip: {
      id: "cl-1",
      status: "rendered",
      durS: 6.2,
      model: "veo-3",
      motionPrompt: "Slow push-in following the walk; rain constant; lamps flicker once",
      note: "Rendered at 6.2s against a 6s slot — 0.2s trim planned in the cut.",
    },
    vfx: ["rain plate", "sodium glow"],
  },
  {
    id: "sc-2",
    index: 2,
    slug: "INT. CRANE CAB — NIGHT",
    synopsis: "The plan, laid out on glass: the crew, the route, the rule they keep.",
    mood: "coiled / precise",
    targetS: 7,
    lines: [
      { speaker: "MARLA", kind: "vo", text: "Ours was on the water." },
      { speaker: "DUSK", kind: "dialogue", text: "Nobody runs. That's the whole rule." },
    ],
    frames: [
      { id: "f-2a", prompt: "Crane cab interior, plans on glass, city bokeh", model: "imagen-3", tone: "from-amber-950/70 via-slate-900 to-slate-950" },
      { id: "f-2b", prompt: "Same, over-shoulder on the glass", model: "imagen-3", tone: "from-slate-800 via-slate-900 to-slate-950", note: "picked — the glass carries the plan" },
      { id: "f-2c", prompt: "Same, faces only, no plans", model: "imagen-3", tone: "from-cyan-900/60 via-slate-900 to-slate-950" },
    ],
    pickedFrameId: "f-2b",
    clip: {
      id: "cl-2",
      status: "rendered",
      durS: 7.0,
      model: "veo-3",
      motionPrompt: "Rack focus from glass plan to skyline; hands trace the route",
      note: "Rendered on the slot.",
    },
    vfx: ["screen inserts"],
  },
  {
    id: "sc-3",
    index: 3,
    slug: "EXT. ROOFTOP — NIGHT",
    synopsis: "The reversal: the door they wanted was never the one being watched.",
    mood: "vertigo / turn",
    targetS: 6,
    lines: [{ speaker: "MARLA", kind: "vo", text: "They watched the gate. We were never at the gate." }],
    frames: [
      { id: "f-3a", prompt: "Rooftop edge over the harbor, two figures, wind", model: "imagen-3", tone: "from-sky-950 via-slate-900 to-slate-950", note: "picked" },
      { id: "f-3b", prompt: "Same, drone top-down", model: "imagen-3", tone: "from-slate-900 via-slate-950 to-black" },
      { id: "f-3c", prompt: "Same, from the water looking up", model: "imagen-3", tone: "from-cyan-950 via-slate-950 to-black" },
    ],
    pickedFrameId: "f-3a",
    clip: {
      id: "cl-3",
      status: "failed",
      model: "veo-3",
      motionPrompt: "Slow orbit around the pair at the edge",
      note: "The render drifted off the source frame by the second half — rejected in review, retry queued with a tighter orbit.",
    },
    vfx: ["wire removal", "wind cards"],
  },
  {
    id: "sc-4",
    index: 4,
    slug: "INT. HARBOR GATE — NIGHT",
    synopsis: "The unlocked door itself — pushed open, no alarm, no drama. That's the point.",
    mood: "held breath",
    targetS: 7,
    lines: [{ speaker: "DUSK", kind: "dialogue", text: "Told you. Unlocked." }],
    frames: [
      { id: "f-4a", prompt: "Industrial gate door ajar, warm light spilling", model: "imagen-3", tone: "from-amber-950/60 via-slate-900 to-slate-950", note: "picked — the spill is the story" },
      { id: "f-4b", prompt: "Same, closed, before", model: "imagen-3", tone: "from-slate-800 via-slate-900 to-black" },
      { id: "f-4c", prompt: "Hand on the handle, macro", model: "imagen-3", tone: "from-rose-950/40 via-slate-900 to-slate-950" },
    ],
    pickedFrameId: "f-4a",
    clip: {
      id: "cl-4",
      status: "rendering",
      model: "veo-3",
      motionPrompt: "Door swings slowly; light widens across the floor",
      note: "In flight — third of four render passes.",
    },
    vfx: ["light spill boost"],
  },
  {
    id: "sc-5",
    index: 5,
    slug: "EXT. WATERLINE — DAWN",
    synopsis: "Out. The harbor at first light; the door, somewhere behind, closed again.",
    mood: "release",
    targetS: 5,
    lines: [{ speaker: "MARLA", kind: "vo", text: "We locked it on the way out." }],
    frames: [
      { id: "f-5a", prompt: "Waterline at dawn, boat wake, harbor behind", model: "imagen-3", tone: "from-cyan-900/50 via-slate-900 to-slate-950" },
      { id: "f-5b", prompt: "Same, closer on the wake", model: "imagen-3", tone: "from-sky-950 via-slate-900 to-slate-950" },
      { id: "f-5c", prompt: "Harbor skyline from the water, sun just up", model: "imagen-3", tone: "from-amber-950/50 via-slate-900 to-slate-950" },
    ],
    pickedFrameId: null,
    clip: null,
    vfx: [],
  },
];
