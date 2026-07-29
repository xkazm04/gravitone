import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The rack pulls in the data layer, whose hooks reach Firebase auth — it
// refuses to initialize without real keys. Rendering is what's under test.
vi.mock("@/lib/useAuth", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/lib/voiceVault", () => ({ recordVoiceOwnership: async () => ({ saved: 0, failed: 0 }) }));

import EmotionRack from "./EmotionRack";
import { EMOTION_RULE } from "@/lib/slugs";
import type { Slot, Voice } from "@/app/voices/_data/characters";

// Two harnesses, because the two behaviours under test want opposite fixtures:
// the slug panel needs a character whose NAME slugs non-trivially and no slots
// at all, while the shadowed-voice rows need slots and do not care about the
// name. Merged from two builders that landed in this file in the same wave.

function renderSlugPanel(addCustomEmotion = vi.fn(async () => {})) {
  render(
    <EmotionRack
      name="Mary O'Brien"
      characterId="mary-o-brien"
      slots={[]}
      coverage={0}
      total={0}
      busySlot={null}
      addVoice={() => {}}
      removeVoice={() => {}}
      onRecord={() => {}}
      addCustomEmotion={addCustomEmotion}
      removeCustomEmotion={async () => {}}
    />,
  );
  return { addCustomEmotion, input: screen.getByPlaceholderText(/sarcastic, battle cry/i) };
}

describe("EmotionRack — the slug preview tells the truth", () => {
  it("prints the address the API actually answers on, not one derived from the name", () => {
    // "Mary O'Brien" used to render as `mary-o'brien:sarcastic`: copy-pasteable
    // and 404ing, because only whitespace was substituted.
    renderSlugPanel();
    expect(screen.getByText(/mary-o-brien:sarcastic/)).toBeInTheDocument();
    expect(screen.queryByText(/mary-o'brien/)).toBeNull();
  });

  it("previews the canonical slug for a name the service will accept", () => {
    const { input } = renderSlugPanel();
    fireEvent.change(input, { target: { value: "battle cry" } });
    expect(screen.getByText(/mary-o-brien:battle_cry/)).toBeInTheDocument();
  });

  it("refuses an invalid name at the input, with the reason, before any round trip", () => {
    // The contradiction this fixes: the panel said "[battle_cry] is addressable
    // immediately" two lines under an input the server would 400.
    const { addCustomEmotion, input } = renderSlugPanel();
    fireEvent.change(input, { target: { value: "battle_cry!" } });

    expect(screen.getByText(new RegExp(EMOTION_RULE.slice(0, 40)))).toBeInTheDocument();
    expect(screen.queryByText(/addressable immediately/)).toBeNull();

    const button = screen.getByRole("button", { name: /custom emotion/i });
    expect(button).toBeDisabled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(addCustomEmotion).not.toHaveBeenCalled();
  });

  it("refuses the lengths and shapes maxLength={24} never covered", () => {
    const { addCustomEmotion, input } = renderSlugPanel();
    for (const bad of ["a", "1st", "_x"]) {
      fireEvent.change(input, { target: { value: bad } });
      fireEvent.keyDown(input, { key: "Enter" });
    }
    expect(addCustomEmotion).not.toHaveBeenCalled();
  });

  it("submits the canonical slug, so what was previewed is what is minted", async () => {
    const { addCustomEmotion, input } = renderSlugPanel();
    fireEvent.change(input, { target: { value: "  Battle-Cry " } });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    expect(addCustomEmotion).toHaveBeenCalledWith("battle_cry");
  });
});

// Removing a Voice now asks first (jsdom's own `confirm` is unimplemented and
// answers falsy, which would read as "the user said no"), so the suites below
// answer YES by default and override per test.
beforeEach(() => { vi.stubGlobal("confirm", vi.fn(() => true)); });
afterEach(() => { vi.unstubAllGlobals(); });

function voice(id: string, emotion: string): Voice {
  return {
    voice_id: id, character_id: "sarah", emotion, name: "Sarah",
    category: "cloned", lang: "en", created: null, sample_seconds: 4,
  };
}

function slot(emotion: string, label: string, voices: Voice[]): Slot {
  return { emotion, label, hue: 200, custom: false, voice: voices[0] ?? null, voices, demand: 0 };
}

function renderSlots(slots: Slot[], removeVoice = vi.fn()) {
  const coverage = slots.filter((s) => s.voice).length;
  render(
    <EmotionRack
      // `characterId` became a required prop in the same wave (the slug panel
      // now takes the server's id instead of deriving one from the name).
      name="Sarah" characterId="sarah" slots={slots} coverage={coverage}
      total={slots.length} busySlot={null}
      addVoice={vi.fn()} removeVoice={removeVoice} onRecord={vi.fn()}
      addCustomEmotion={vi.fn()} removeCustomEmotion={vi.fn()}
    />,
  );
  return removeVoice;
}

describe("EmotionRack — the shadowed voice gets a row of its own", () => {
  it("leaves an ordinary one-voice slot with exactly one row and one remove", () => {
    renderSlots([slot("baseline", "Baseline", [voice("v_base", "baseline")])]);

    expect(screen.getAllByRole("button", { name: "Remove the Baseline voice" })).toHaveLength(1);
    expect(screen.queryByText(/shadowed/)).not.toBeInTheDocument();
    expect(screen.getByText("v_base")).toBeInTheDocument();
  });

  it("shows BOTH voices of a doubled slot and marks which one speaks", () => {
    renderSlots([
      slot("baseline", "Baseline", [voice("v_base", "baseline")]),
      slot("angry", "Angry", [voice("v_first", "angry"), voice("v_second", "angry")]),
    ]);

    // Before this, the second voice had no row, no id and no remove button.
    expect(screen.getByText("v_first")).toBeInTheDocument();
    expect(screen.getByText("v_second")).toBeInTheDocument();
    expect(screen.getByText("speaks this slot")).toBeInTheDocument();
    expect(screen.getByText(/shadowed · never spoken/)).toBeInTheDocument();
    // …and the header says the duplicate exists at all (coverage counts
    // distinct emotions, so the numbers alone would hide it).
    expect(screen.getByText(/1 shadowed/)).toBeInTheDocument();
  });

  it("removes each voice of a doubled slot individually", () => {
    const removeVoice = renderSlots([
      slot("angry", "Angry", [voice("v_first", "angry"), voice("v_second", "angry")]),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Remove the shadowed Angry voice" }));
    expect(removeVoice).toHaveBeenCalledWith("v_second");

    fireEvent.click(screen.getByRole("button", { name: "Remove the Angry voice" }));
    expect(removeVoice).toHaveBeenCalledWith("v_first");
  });
});

describe("EmotionRack — a cloned embedding is never destroyed on one click", () => {
  it("destroys nothing when the confirmation is declined", () => {
    // The consent gate and the import rename both stop and ask on this surface;
    // remove was the one action that just did it.
    const confirm = vi.fn((_message?: string) => false);
    vi.stubGlobal("confirm", confirm);
    const removeVoice = renderSlots([slot("baseline", "Baseline", [voice("v_base", "baseline")])]);

    fireEvent.click(screen.getByRole("button", { name: "Remove the Baseline voice" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(removeVoice).not.toHaveBeenCalled();
  });

  it("names the character, the slot, the id and the irreversibility", () => {
    const confirm = vi.fn((_message?: string) => true);
    vi.stubGlobal("confirm", confirm);
    renderSlots([slot("angry", "Angry", [voice("v_first", "angry")])]);

    fireEvent.click(screen.getByRole("button", { name: "Remove the Angry voice" }));
    const asked = String(confirm.mock.calls[0][0]);
    expect(asked).toContain("Sarah");
    expect(asked).toContain("Angry");
    expect(asked).toContain("v_first");
    expect(asked).toMatch(/cannot be undone/i);
  });

  it("promises the surviving voice when the SHADOWED one is the target", () => {
    // Deleting the shadow must not read as "delete this slot": the voice that
    // actually speaks is kept, and that is the whole reason to press it.
    const confirm = vi.fn((_message?: string) => true);
    vi.stubGlobal("confirm", confirm);
    renderSlots([slot("angry", "Angry", [voice("v_first", "angry"), voice("v_second", "angry")])]);

    fireEvent.click(screen.getByRole("button", { name: "Remove the shadowed Angry voice" }));
    const asked = String(confirm.mock.calls[0][0]);
    expect(asked).toContain("v_second");
    expect(asked).toMatch(/speaks this slot is kept/i);
  });
});

describe("EmotionRack — a failed preview says WHY", () => {
  it("carries the backend's own detail instead of a bare 'preview failed'", async () => {
    // useVoicePreview used to swallow the cause entirely, so an unreachable
    // backend, a 429 and a missing embedding all read the same.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ detail: "no embedding for v_base — re-clone this voice" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )));
    renderSlots([slot("baseline", "Baseline", [voice("v_base", "baseline")])]);

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Play Baseline" })); });
    expect(await screen.findByText(/preview failed — no embedding for v_base/)).toBeInTheDocument();
  });
});
