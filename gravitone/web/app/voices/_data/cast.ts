// ── the cast manifest ─────────────────────────────────────────────────────────
//
// A Character's whole cast, as the JSON a DEVELOPER needs to speak as it:
// every Voice's id, the address to POST to, its emotion, and the metatag
// vocabulary that switches emotion mid-script. This is the handoff from the
// studio (where a human auditions and names things) to the code that ships.
//
// Deliberately NOT the same artifact as the .gravichar pack
// (/api/characters/{id}/pack): the pack carries EMBEDDINGS so a Character can be
// re-imported on another Gravitone instance. This carries no audio at all — it
// is addressing metadata for calling an instance that already has the voices.
//
// Built PURELY from the Character the page has already loaded. No new API route:
// every field below is on the roster payload, and a second endpoint serving a
// re-shape of data already in the browser is a second thing that can disagree.
//
// TRUTH RULES for this file:
//   - Nothing is invented. `name`, `tags`, `lang`, `voice_id`, `emotion` are the
//     registry's own values.
//   - `address` is `character_id:emotion`, which is what the ElevenLabs-compatible
//     route actually accepts as a voice_id (service/voices.py resolves it; the
//     per-character API panel prints the same form).
//   - `origin` travels with each Voice, so a consumer can tell a performance
//     from a slot the studio COMPUTED. Dropping it here would let a derived
//     voice be re-presented downstream as a recording.
//   - `base_url` is a PLACEHOLDER (the studio does not know the deployment's
//     public hostname), and it is named as one.

import { DEFAULT_BASE_URL } from "@/lib/switchkit";
import type { Character, Voice } from "./characters";

/** Schema version. Bump when a field's MEANING changes, not when one is added. */
export const CAST_MANIFEST_VERSION = 1;

export type CastVoice = {
  voice_id: string;
  name: string;
  emotion: string;
  /** What to put in POST /v1/text-to-speech/{voice_id} to get this emotion. */
  address: string;
  lang: string;
  origin: "recorded" | "derived";
};

export type CastManifest = {
  gravitone_cast: number;
  character_id: string;
  name: string;
  tags: string[];
  lang: string;
  /** Emotions this Character can actually SPEAK — one entry per filled slot. */
  emotions: string[];
  /** Slots on this Character's scale with no Voice. A request for one of these
   *  is served by the baseline Voice, so they are listed as what they are:
   *  addressable, but not distinct. Empty array = the rack is complete. */
  falls_back_to_baseline: string[];
  voices: CastVoice[];
  api: {
    endpoint: string;
    base_url: string;
    base_url_is_placeholder: boolean;
    auth_header: string;
    /** Inline emotion metatags — the one call that switches emotion mid-script. */
    metatag_example: string;
    notes: string[];
  };
  exported_at: string;
};

/** Voices that actually speak, in scale order, speaker-first per emotion.
 *  `character.voices` is already scale-sorted by the service and `buildSlots`
 *  relies on the same fact — the FIRST voice on an emotion is the one that
 *  speaks it. A shadowed duplicate is dropped here on purpose: it is not
 *  separately addressable, so listing it would advertise an address that
 *  resolves to its sibling. */
function speakingVoices(character: Character): Voice[] {
  const seen = new Set<string>();
  const out: Voice[] = [];
  for (const v of character.voices ?? []) {
    if (seen.has(v.emotion)) continue;
    seen.add(v.emotion);
    out.push(v);
  }
  return out;
}

/** The whole cast of one Character, as an API consumer needs it. */
export function buildCastManifest(character: Character, now = new Date()): CastManifest {
  const voices = speakingVoices(character);
  const filled = voices.map((v) => v.emotion);
  const scale = character.scale?.length ? character.scale : filled;
  const emotion = filled.find((e) => e !== "baseline") ?? filled[0] ?? "baseline";
  return {
    gravitone_cast: CAST_MANIFEST_VERSION,
    character_id: character.character_id,
    name: character.name,
    tags: character.tags ?? [],
    lang: character.lang,
    emotions: filled,
    falls_back_to_baseline: scale.filter((e) => !filled.includes(e)),
    voices: voices.map((v) => ({
      voice_id: v.voice_id,
      name: v.name,
      emotion: v.emotion,
      address: `${character.character_id}:${v.emotion}`,
      lang: v.lang,
      origin: v.origin === "derived" ? "derived" : "recorded",
    })),
    api: {
      endpoint: "POST /v1/text-to-speech/{voice_id}",
      base_url: DEFAULT_BASE_URL,
      base_url_is_placeholder: true,
      auth_header: "xi-api-key",
      metatag_example:
        `POST /v1/speak {"character_id": "${character.character_id}", ` +
        `"text": "Hello there. [${emotion}]This is amazing![/${emotion}]"}`,
      notes: [
        "voice_id accepts either a raw id or the character:emotion address.",
        "An emotion this character has no voice for is served by its baseline voice; "
          + "the substitution is reported in the X-Emotion-* response headers.",
        "base_url is a placeholder — replace it with your own deployment's URL.",
        "xi-api-key is only checked when the service has TTS_API_KEY set.",
        "origin \"derived\" means the studio computed that emotion from a baseline "
          + "plus a shared emotion direction; nobody performed it.",
      ],
    },
    exported_at: now.toISOString(),
  };
}

/** The manifest as the file/clipboard text — one formatting, both actions. */
export function castManifestJson(character: Character, now = new Date()): string {
  return JSON.stringify(buildCastManifest(character, now), null, 2);
}

/** The download filename. Slugged from the character id, which is already a
 *  slug — falling back to "cast" rather than emitting a name with a slash in it. */
export function castFilename(character: Character): string {
  const id = character.character_id.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "");
  return `${id || "cast"}.cast.json`;
}
