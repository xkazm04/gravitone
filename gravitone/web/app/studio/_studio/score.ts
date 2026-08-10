// Glass Harbor's sound and cut: the music cues (one refused, honestly) and
// the timeline the Cut phase renders — drift and gaps included.

import type { Cue, TimelineClip, TrackId } from "./projectTypes";

export const CUES: Cue[] = [
  {
    id: "cue-1",
    title: "The door (build)",
    mood: "low pulse, no melody yet",
    bpm: 84,
    startS: 0,
    durS: 13,
    status: "rendered",
    model: "lyria-3",
    note: "Sits under scenes 1–2; ducks −6dB under VO automatically.",
    sceneSpan: [1, 2],
  },
  {
    id: "cue-2",
    title: "Never at the gate (turn)",
    mood: "pulse doubles, brass low",
    bpm: 112,
    startS: 13,
    durS: 13,
    status: "failed",
    model: "lyria-3",
    note: "Lyria refused the request in this region — no clip was produced. The cut plays silence here and says so.",
    sceneSpan: [3, 4],
  },
  {
    id: "cue-3",
    title: "Waterline (release)",
    mood: "open fifths, resolve",
    bpm: 84,
    startS: 26,
    durS: 5,
    status: "rendered",
    model: "lyria-3",
    note: "Tail rings 1.5s past picture — intended.",
    sceneSpan: [5, 5],
  },
];

export const TIMELINE: TimelineClip[] = [
  { id: "t-v1", track: "video", label: "sc-1 pier walk", startS: 0, durS: 6, status: "ok" },
  { id: "t-v2", track: "video", label: "sc-2 crane cab", startS: 6, durS: 7, status: "ok" },
  { id: "t-v3", track: "video", label: "sc-3 rooftop", startS: 13, durS: 6, status: "missing" },
  { id: "t-v4", track: "video", label: "sc-4 the door", startS: 19, durS: 7, status: "missing" },
  { id: "t-v5", track: "video", label: "sc-5 waterline", startS: 26, durS: 5, status: "missing" },
  { id: "t-a1", track: "vo", label: "cold open (aud-1)", startS: 0.4, durS: 11.4, status: "ok" },
  { id: "t-a2", track: "vo", label: "heist beat (aud-2)", startS: 13.2, durS: 14.8, status: "drift", offsetMs: 300 },
  { id: "t-m1", track: "music", label: "cue-1 build", startS: 0, durS: 13, status: "ok" },
  { id: "t-m2", track: "music", label: "cue-2 turn", startS: 13, durS: 13, status: "missing" },
  { id: "t-m3", track: "music", label: "cue-3 release", startS: 26, durS: 5, status: "ok" },
];

export const TRACKS: { id: TrackId; label: string }[] = [
  { id: "video", label: "picture" },
  { id: "vo", label: "voice" },
  { id: "music", label: "music" },
];
