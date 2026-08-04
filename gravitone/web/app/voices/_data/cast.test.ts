import { describe, expect, it } from "vitest";
import { buildCastManifest, castFilename, castManifestJson } from "./cast";
import type { Character, Voice } from "./characters";

function voice(p: Partial<Voice> & { emotion: string }): Voice {
  return {
    voice_id: `v_${p.emotion}`,
    character_id: "sarah",
    name: `Sarah (${p.emotion})`,
    category: "cloned",
    lang: "en",
    ...p,
  };
}

function sarah(over: Partial<Character> = {}): Character {
  return {
    character_id: "sarah",
    name: "Sarah",
    category: "cloned",
    tags: ["lead", "noir"],
    lang: "en",
    voices: [voice({ emotion: "baseline" }), voice({ emotion: "angry" })],
    emotions: ["baseline", "angry"],
    coverage: 2,
    total: 8,
    scale: ["baseline", "angry", "sad"],
    ...over,
  };
}

const AT = new Date("2026-08-04T10:00:00.000Z");

describe("buildCastManifest", () => {
  it("carries the fields an API consumer needs to address every voice", () => {
    const m = buildCastManifest(sarah(), AT);
    expect(m.character_id).toBe("sarah");
    expect(m.name).toBe("Sarah");
    expect(m.tags).toEqual(["lead", "noir"]);
    expect(m.emotions).toEqual(["baseline", "angry"]);
    expect(m.voices).toHaveLength(2);
    expect(m.voices[1]).toMatchObject({
      voice_id: "v_angry", emotion: "angry", address: "sarah:angry", origin: "recorded",
    });
    expect(m.api.endpoint).toBe("POST /v1/text-to-speech/{voice_id}");
    expect(m.api.auth_header).toBe("xi-api-key");
    expect(m.exported_at).toBe(AT.toISOString());
  });

  it("names the empty slots as baseline fallbacks rather than as speakable", () => {
    // A slot with no Voice IS addressable, but it does not sound different —
    // listing it under `emotions` would advertise an emotion nobody recorded.
    const m = buildCastManifest(sarah(), AT);
    expect(m.falls_back_to_baseline).toEqual(["sad"]);
    expect(m.emotions).not.toContain("sad");
  });

  it("keeps a derived voice marked as derived", () => {
    // The trust contract: a computed slot must never leave the studio dressed
    // as a performance.
    const m = buildCastManifest(
      sarah({ voices: [voice({ emotion: "sad", origin: "derived" })] }), AT);
    expect(m.voices[0].origin).toBe("derived");
  });

  it("lists a shadowed duplicate only once — the voice that actually speaks", () => {
    // Two voices can occupy one emotion; only the first is served, so the
    // second has no address of its own to publish.
    const m = buildCastManifest(sarah({
      voices: [
        voice({ emotion: "angry", voice_id: "v_first" }),
        voice({ emotion: "angry", voice_id: "v_shadowed" }),
      ],
    }), AT);
    expect(m.voices.map((v) => v.voice_id)).toEqual(["v_first"]);
  });

  it("survives a Character with no voices without inventing any", () => {
    const m = buildCastManifest(sarah({ voices: [], emotions: [] }), AT);
    expect(m.voices).toEqual([]);
    expect(m.emotions).toEqual([]);
    expect(m.falls_back_to_baseline).toEqual(["baseline", "angry", "sad"]);
  });

  it("serializes to parseable JSON and a safe filename", () => {
    expect(JSON.parse(castManifestJson(sarah(), AT)).character_id).toBe("sarah");
    expect(castFilename(sarah())).toBe("sarah.cast.json");
    expect(castFilename(sarah({ character_id: "mary o'brien/x" }))).toBe("mary-o-brien-x.cast.json");
  });
});
