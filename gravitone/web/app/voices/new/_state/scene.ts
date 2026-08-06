// From a video to a scene — the pure half of the hand-off.
//
// A cast leaves the box holding two things it has never put together: the
// Characters it just cloned, and the diarized transcript they were cloned from.
// `GET /api/ingest/{job}/scene` joins them (service/ingest_api.py::build_scene:
// consecutive same-speaker segments merged into lines, uncast speakers omitted
// and counted, the engine's line cap applied where it can be stated). This
// module turns that payload into the composer state the playground already
// restores from, and into the sentences the affordance owes the user.
//
// Deliberately NOT a new storage contract: the hand-off rides lib/composerStore
// exactly as app/t/[id]/OpenInRack does — the playground restores a session, as
// it always has, and the session happens to be this recording's dialogue.

import { DEFAULT_EXPRESSION, DEFAULT_TEXT } from "@/app/playground/_variants/shared";
import type { ComposerState } from "@/lib/composerStore";

export type SceneLine = { speaker: string; character_id: string; text: string };

export type Scene = {
  available: boolean;
  /** Why there is no scene. Present exactly when `available` is false, and it
   *  is the SERVICE's sentence — a transcriptless sovereign scan, a swept
   *  workdir and a cast where nobody finished are three different facts. */
  reason?: string | null;
  lines?: SceneLine[];
  total_lines?: number;
  truncated?: boolean;
  max_lines?: number;
  omitted?: { speaker: string; segments: number }[];
  characters?: { speaker_id: string; character_id: string; character: string }[];
  /** character_id -> name, so a line can be labelled before the roster lands. */
  names?: Record<string, string>;
};

/**
 * The composer session this scene becomes.
 *
 * `charId` is the first line's Character: it is the solo-mode selection the
 * rail shows behind a script, and picking the first speaker means the rail
 * agrees with the top of the script instead of with whatever was there before.
 * `text` keeps the studio's default line rather than "" — a user who flips the
 * restored session back to solo mode should not find an empty box.
 */
export function sceneComposer(scene: Scene): ComposerState | null {
  const lines = scene.lines ?? [];
  if (!scene.available || lines.length === 0) return null;
  return {
    text: DEFAULT_TEXT,
    script: lines.map((l, i) => ({
      id: `line-scene-${i}`,
      characterId: l.character_id,
      text: l.text,
    })),
    expr: DEFAULT_EXPRESSION,
    mode: "script",
    charId: lines[0].character_id,
    activeLine: 0,
  };
}

/**
 * What the user must know BEFORE they open it — each one a thing this hand-off
 * is doing to their dialogue that they did not ask for.
 *
 * Omission is stated as omission (those lines are in the recording and will not
 * be in the scene), and truncation names both numbers, because "64 lines" reads
 * as the whole video until you know the video had 200.
 */
export function sceneNotes(scene: Scene): string[] {
  const notes: string[] = [];
  const lines = scene.lines ?? [];
  if (scene.truncated) {
    notes.push(
      `Only the first ${lines.length} lines of ${scene.total_lines ?? lines.length} are carried over — the engine renders at most ${scene.max_lines ?? lines.length} lines in one performance.`,
    );
  }
  const omitted = scene.omitted ?? [];
  if (omitted.length > 0) {
    const who = omitted.map((o) => `${o.speaker} (${o.segments})`).join(", ");
    notes.push(
      omitted.length === 1
        ? `Lines spoken by ${who} are left out — that speaker was not cast, so there is no Character to perform them.`
        : `Lines spoken by ${who} are left out — those speakers were not cast, so there is no Character to perform them.`,
    );
  }
  return notes;
}

/** One line of preview copy: who says how many lines. Reads off the scene the
 *  service built, never off the cast — a Character that was cast but never
 *  speaks in the trimmed scene must not be promised here. */
export function sceneCastSummary(scene: Scene): string {
  const lines = scene.lines ?? [];
  const per = new Map<string, number>();
  for (const l of lines) per.set(l.character_id, (per.get(l.character_id) ?? 0) + 1);
  return [...per.entries()]
    .map(([cid, n]) => `${scene.names?.[cid] ?? cid} · ${n} line${n === 1 ? "" : "s"}`)
    .join("  ·  ");
}
