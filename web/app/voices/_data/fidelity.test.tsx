import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Both surfaces reach the data layer, whose hooks touch Firebase auth.
vi.mock("@/lib/useAuth", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/lib/voiceVault", () => ({
  CONSENT_PROMPT: "I attest…",
  recordVoiceOwnership: async () => ({ saved: 0, failed: 0 }),
}));

import CharacterTable from "../_variants/CharacterTable";
import SignalChip from "../_variants/SignalChip";
import EmotionRack from "../[characterId]/_variants/EmotionRack";
import {
  defectDirection, invalidateRoster, normalizeCharacter, readFidelity, signalOf,
  weakestVoice, weaknessOf, type Character, type Slot, type Voice,
} from "./characters";

// ── the wire → the type ───────────────────────────────────────────────────────
// The service reports named facts in snake_case, every field independently
// nullable. The rule this whole feature rests on: ABSENT IS NOT ZERO. A voice
// cloned before the ledger existed must be indistinguishable from one measured
// as fine only in the sense that neither shows a warning — and distinguishable
// from one measured as bad.

describe("readFidelity — what the service said, and nothing else", () => {
  it("maps the wire object onto the app's shape", () => {
    expect(readFidelity({
      version: 1, measured_at: "2026-07-30T00:00:00Z", identity: 0.91,
      speech_seconds: 6.2, clip_ratio: 0.002, noise_floor_db: -52.1,
      flags: ["clipped"],
    })).toEqual({ identity: 0.91, speechSeconds: 6.2, flags: ["clipped"] });
  });

  it("reads a not-measured voice as undefined, never as a zeroed measurement", () => {
    for (const absent of [null, undefined, "", 0, "excellent", []]) {
      expect(readFidelity(absent)).toBeUndefined();
    }
    // An object with every field null is the service saying "nothing measured".
    expect(readFidelity({ version: 1, identity: null, speech_seconds: null, flags: [] }))
      .toBeUndefined();
  });

  it("keeps a partial measurement rather than throwing the half away", () => {
    expect(readFidelity({ version: 1, identity: null, speech_seconds: null,
                          flags: ["low_sample_rate"] }))
      .toEqual({ identity: undefined, speechSeconds: undefined, flags: ["low_sample_rate"] });
  });

  it("refuses values that are not numbers, and non-string flags", () => {
    expect(readFidelity({ identity: "0.9", speech_seconds: NaN, flags: [1, "noisy", null] }))
      .toEqual({ identity: undefined, speechSeconds: undefined, flags: ["noisy"] });
  });
});

describe("normalizeCharacter — one translation, at the fetch boundary", () => {
  const wire = {
    character_id: "sarah", name: "Sarah", category: "cloned" as const, tags: [],
    lang: "en", emotions: ["baseline"], coverage: 1, total: 8,
    voices: [{ voice_id: "v1", character_id: "sarah", emotion: "baseline",
               name: "Sarah", category: "cloned" as const, lang: "en",
               fidelity: { version: 1, flags: ["noisy"], speech_seconds: 9 } }],
  } as unknown as Character;

  it("normalizes every voice's fidelity", () => {
    expect(normalizeCharacter(wire).voices[0].fidelity)
      .toEqual({ identity: undefined, speechSeconds: 9, flags: ["noisy"] });
  });

  it("leaves a payload with no voices array untouched instead of inventing one", () => {
    // "the response was partial" must not become "this Character has no voices".
    const partial = { character_id: "x", name: "X" } as unknown as Character;
    expect(normalizeCharacter(partial)).toBe(partial);
  });
});

// ── the fact worth showing ────────────────────────────────────────────────────
describe("signalOf — one named fact, worst first", () => {
  it("says nothing at all when nothing was measured", () => {
    expect(signalOf(undefined)).toBeNull();
  });

  it("prefers the flag over the number, because the flag is actionable", () => {
    const s = signalOf({ identity: 0.99, speechSeconds: 8, flags: ["clipped"] });
    expect(s?.label).toBe("clipped");
    expect(s?.flag).toBe("clipped");
  });

  it("ranks clipping above a short take", () => {
    const both = signalOf({ flags: ["short_speech", "clipped"], speechSeconds: 1.4 });
    expect(both?.label).toBe("clipped");
    expect(weaknessOf({ voices: [{ fidelity: { flags: ["clipped"], speechSeconds: 1 } }] } as Character))
      .toBeGreaterThan(
        weaknessOf({ voices: [{ fidelity: { flags: ["short_speech"] } }] } as Character));
  });

  it("states the MEASURED number when a flag is about a number", () => {
    expect(signalOf({ flags: ["short_speech"], speechSeconds: 1.4 })?.label)
      .toBe("1.4s speech");
  });

  it("presents similarity as identity MATCH, never as quality", () => {
    const s = signalOf({ identity: 0.9137, flags: [] });
    expect(s?.label).toBe("identity 0.91");
    expect(s?.flag).toBeNull();
    expect(s?.title).toMatch(/identity match/i);
    expect(s?.title).not.toMatch(/quality/i);
    expect(s?.severity).toBe(0); // a clean measurement is not a weakness
  });

  it("names an unknown flag from a newer service instead of dropping it", () => {
    const s = signalOf({ flags: ["dc_offset"] });
    expect(s?.label).toBe("dc offset");
    expect(s?.severity).toBe(1); // ranked below the flags we understand
  });
});

describe("defectDirection — the measurement changes what the user does next", () => {
  it("turns a flag into a recording instruction", () => {
    expect(defectDirection({ flags: ["clipped"] })).toMatch(/further from the mic/i);
    expect(defectDirection({ flags: ["noisy"] })).toMatch(/quieter/i);
  });

  it("has nothing to say about a clean or unmeasured take", () => {
    expect(defectDirection({ identity: 0.99, flags: [] })).toBeNull();
    expect(defectDirection(undefined)).toBeNull();
  });
});

describe("weakestVoice — only a FLAGGED voice can be the weak one", () => {
  const voice = (emotion: string, fidelity?: Voice["fidelity"]): Voice => ({
    voice_id: `v_${emotion}`, character_id: "sarah", emotion, name: "Sarah",
    category: "cloned", lang: "en", fidelity,
  });
  const character = (voices: Voice[]) => ({ voices } as Character);

  it("picks the worst flagged slot", () => {
    const w = weakestVoice(character([
      voice("baseline", { flags: ["noisy"] }),
      voice("angry", { flags: ["clipped"] }),
    ]));
    expect(w?.voice.emotion).toBe("angry");
  });

  it("finds no weakest voice when every measurement came back clean", () => {
    // Ranking clean takes against each other would send the user to re-record
    // something that is not broken.
    expect(weakestVoice(character([voice("baseline", { identity: 0.98, flags: [] })])))
      .toBeNull();
  });

  it("does not treat an unmeasured voice as a defect", () => {
    expect(weakestVoice(character([voice("baseline"), voice("sad")]))).toBeNull();
    expect(weaknessOf(character([voice("baseline")]))).toBe(0);
  });
});

// ── the chip ──────────────────────────────────────────────────────────────────
describe("SignalChip — absent is invisible", () => {
  it("renders literally nothing when there is no signal", () => {
    const { container } = render(<SignalChip signal={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("states the fact and explains it on hover, with an accessible name", () => {
    render(<SignalChip signal={signalOf({ flags: ["clipped"] })} note="Angry take" />);
    const chip = screen.getByText(/clipped/);
    expect(chip).toBeInTheDocument();
    expect(chip.getAttribute("title")).toMatch(/Angry take — /);
    expect(chip.getAttribute("aria-label")).toMatch(/^clipped\./);
  });
});

// ── the rack ──────────────────────────────────────────────────────────────────
function slot(emotion: string, label: string, fidelity?: Voice["fidelity"]): Slot {
  const voice: Voice = {
    voice_id: `v_${emotion}`, character_id: "sarah", emotion, name: "Sarah",
    category: "cloned", lang: "en", sample_seconds: 9, fidelity,
  };
  return { emotion, label, hue: 200, custom: false, voice, voices: [voice], demand: 0 };
}

function renderRack(slots: Slot[], onRecord = vi.fn()) {
  render(
    <EmotionRack name="Sarah" characterId="sarah" slots={slots}
      coverage={slots.length} total={slots.length} busySlot={null}
      addVoice={vi.fn()} removeVoice={vi.fn()} onRecord={onRecord}
      addCustomEmotion={vi.fn()} removeCustomEmotion={vi.fn()} />,
  );
  return onRecord;
}

beforeEach(() => { vi.stubGlobal("confirm", vi.fn(() => true)); invalidateRoster(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("EmotionRack — the rack reports what the studio heard", () => {
  it("shows the measured fact on a slot that has one", () => {
    renderRack([slot("angry", "Angry", { identity: 0.91, flags: [] })]);
    expect(screen.getByText("identity 0.91")).toBeInTheDocument();
  });

  it("shows NOTHING for a slot cloned before the ledger existed", () => {
    // No placeholder, no "not measured" — the row looks exactly as it did.
    renderRack([slot("angry", "Angry", undefined)]);
    expect(screen.queryByText(/identity/)).toBeNull();
    expect(screen.queryByText(/not measured/i)).toBeNull();
    expect(screen.getByText("recorded")).toBeInTheDocument();
  });

  it("offers re-record ONLY on a flagged slot, and opens the guided recorder", () => {
    const onRecord = renderRack([
      slot("angry", "Angry", { flags: ["clipped"] }),
      slot("sad", "Sad", { identity: 0.97, flags: [] }),
    ]);
    expect(screen.getAllByRole("button", { name: /Re-record the/i })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Re-record the Angry voice" }));
    expect(onRecord).toHaveBeenCalledWith("angry");
  });

  it("keeps remove available on a flagged slot — the flag is advisory", () => {
    renderRack([slot("angry", "Angry", { flags: ["noisy"] })]);
    expect(screen.getByRole("button", { name: "Remove the Angry voice" })).toBeEnabled();
  });
});

// ── the roster ────────────────────────────────────────────────────────────────
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}

function wireCharacter(id: string, voices: unknown[]) {
  return {
    character_id: id, name: id, category: "cloned", tags: [], lang: "en",
    voices, emotions: voices.map((v) => (v as { emotion: string }).emotion),
    coverage: voices.length, total: 8,
  };
}

function wireVoice(emotion: string, fidelity: unknown = null) {
  return { voice_id: `${emotion}-1`, character_id: "sarah", emotion,
           name: "Sarah", category: "cloned", lang: "en", fidelity };
}

describe("CharacterTable — the roster audits itself", () => {
  it("links the weakest slot straight at the guided recorder", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json([
      wireCharacter("sarah", [
        wireVoice("baseline", { version: 1, flags: [], identity: 0.98 }),
        wireVoice("angry", { version: 1, flags: ["clipped"], clip_ratio: 0.02 }),
      ]),
    ])));
    render(<CharacterTable />);

    const link = await screen.findByRole("link", { name: /Re-record the Angry voice/i });
    // `?record=` is the param the character page already opens the recorder on,
    // so the weakest voice is genuinely one click from a re-record.
    expect(link).toHaveAttribute("href", "/voices/sarah?record=angry");
  });

  it("adds no hint at all to a roster nothing has measured", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json([
      wireCharacter("sarah", [wireVoice("baseline"), wireVoice("angry")]),
    ])));
    render(<CharacterTable />);

    await screen.findByText("sarah");
    expect(screen.queryByRole("link", { name: /Re-record/i })).toBeNull();
  });

  it("offers the weakest sort beside demand", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json([])));
    render(<CharacterTable />);
    await screen.findByText(/No characters yet/i);
    expect(screen.getByRole("button", { name: /weakest/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /demand/i })).toBeInTheDocument();
  });
});
