import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The data layer this component imports reaches Firebase auth through useAuth.
vi.mock("@/lib/useAuth", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/lib/voiceVault", () => ({ recordVoiceOwnership: async () => ({ saved: 0, failed: 0 }) }));

import EmotionRack from "./EmotionRack";
import { EMOTION_RULE } from "@/lib/slugs";

function renderRack(addCustomEmotion = vi.fn(async () => {})) {
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
    renderRack();
    expect(screen.getByText(/mary-o-brien:sarcastic/)).toBeInTheDocument();
    expect(screen.queryByText(/mary-o'brien/)).toBeNull();
  });

  it("previews the canonical slug for a name the service will accept", () => {
    const { input } = renderRack();
    fireEvent.change(input, { target: { value: "battle cry" } });
    expect(screen.getByText(/mary-o-brien:battle_cry/)).toBeInTheDocument();
  });

  it("refuses an invalid name at the input, with the reason, before any round trip", () => {
    // The contradiction this fixes: the panel said "[battle_cry] is addressable
    // immediately" two lines under an input the server would 400.
    const { addCustomEmotion, input } = renderRack();
    fireEvent.change(input, { target: { value: "battle_cry!" } });

    expect(screen.getByText(new RegExp(EMOTION_RULE.slice(0, 40)))).toBeInTheDocument();
    expect(screen.queryByText(/addressable immediately/)).toBeNull();

    const button = screen.getByRole("button", { name: /custom emotion/i });
    expect(button).toBeDisabled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(addCustomEmotion).not.toHaveBeenCalled();
  });

  it("refuses the lengths and shapes maxLength={24} never covered", () => {
    const { addCustomEmotion, input } = renderRack();
    for (const bad of ["a", "1st", "_x"]) {
      fireEvent.change(input, { target: { value: bad } });
      fireEvent.keyDown(input, { key: "Enter" });
    }
    expect(addCustomEmotion).not.toHaveBeenCalled();
  });

  it("submits the canonical slug, so what was previewed is what is minted", async () => {
    const { addCustomEmotion, input } = renderRack();
    fireEvent.change(input, { target: { value: "  Battle-Cry " } });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    expect(addCustomEmotion).toHaveBeenCalledWith("battle_cry");
  });
});
