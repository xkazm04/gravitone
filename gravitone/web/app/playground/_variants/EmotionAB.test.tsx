// The A/B is an argument, so these tests are about the ways it could quietly
// stop making it: rendering two different lines, presenting one recording as
// two, counting a browser-voice take as evidence, or turning backpressure into
// a verdict on a Voice.
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EngineBusyError } from "@/lib/engineSeam";
import type { Segment, Take } from "./shared";

const speak = vi.fn();
vi.mock("./engine", async () => {
  const seam = await import("@/lib/engineSeam");
  return {
    speak: (...args: unknown[]) => speak(...args),
    EngineBusyError: seam.EngineBusyError,
    isAbort: seam.isAbort,
  };
});

import EmotionAB, { sameVoiceWarning, spokenVoice, taggedFor } from "./EmotionAB";

afterEach(() => { speak.mockReset(); });

function seg(over: Partial<Segment> = {}): Segment {
  return { text: "hi", requested: "happy", used: "happy", fallback: false,
           voice_id: "v_happy", seconds: 1, ...over };
}

function result(segments: Segment[], over: Record<string, unknown> = {}) {
  return {
    mode: "gravitone", url: "blob:x", peaks: [1], seconds: 1.2, kb: 30, rtf: 1,
    synthSeconds: 1, queueSeconds: 0, ignoredSettings: [], segments,
    synthSegments: 1, format: "wav_24000", ...over,
  };
}

const PROPS = {
  characterId: "sarah", characterName: "Sarah",
  scale: ["baseline", "happy", "angry"],
  recorded: ["baseline", "happy"],
  text: "We open at dawn.",
  expr: { temperature: 0.7, stability: 0, quality: 1 },
  format: "wav_24000" as const,
  playingId: null, paused: false,
  toggle: () => {}, stop: () => {},
};

describe("taggedFor", () => {
  it("wraps the line in the emotion's metatag", () => {
    expect(taggedFor("Hello.", "angry")).toBe("[angry]Hello.[/angry]");
  });

  it("sends baseline UNTAGGED — untagged text already resolves there", () => {
    expect(taggedFor("Hello.", "baseline")).toBe("Hello.");
  });

  it("strips any tags the composer already carried, so one emotion applies", () => {
    expect(taggedFor("[sad]Hello.[/sad]", "angry")).toBe("[angry]Hello.[/angry]");
  });
});

describe("sameVoiceWarning", () => {
  const take = (voice_id: string, used: string) =>
    ({ segments: [seg({ voice_id, used })] } as Take);

  it("says nothing when the two sides really are different recordings", () => {
    expect(sameVoiceWarning(take("v_happy", "happy"), take("v_sad", "sad"))).toBeNull();
  });

  it("refuses to let one recording be presented as a comparison", () => {
    const w = sameVoiceWarning(take("v_base", "baseline"), take("v_base", "baseline"));
    expect(w).toContain("one recording twice");
  });

  it("says nothing when it cannot tell — absence is not a verdict", () => {
    expect(sameVoiceWarning(null, take("v_base", "baseline"))).toBeNull();
    expect(spokenVoice({ segments: [] } as unknown as Take)).toBeNull();
  });
});

describe("EmotionAB", () => {
  it("renders the SAME line under both emotions, one after the other", async () => {
    speak.mockImplementation(async () => result([seg()]));
    render(<EmotionAB {...PROPS} />);
    await act(async () => {
      screen.getByRole("button", { name: /render both/i }).click();
    });
    await waitFor(() => expect(speak).toHaveBeenCalledTimes(2));

    const texts = speak.mock.calls.map((c) => c[0] as string);
    // Different tags, identical line inside them — the experiment.
    expect(texts[0]).toBe("We open at dawn.");                 // baseline, untagged
    expect(texts[1]).toBe("[happy]We open at dawn.[/happy]");
  });

  it("warns when both sides turned out to be the same recording", async () => {
    // The Character has no `angry`, so the backend substitutes and both sides
    // are spoken by the baseline Voice.
    speak.mockImplementation(async () =>
      result([seg({ voice_id: "v_base", used: "baseline" })]));
    render(<EmotionAB {...PROPS} recorded={["baseline"]} />);
    await act(async () => {
      screen.getByRole("button", { name: /render both/i }).click();
    });
    await screen.findByText(/one recording twice, not a comparison/i);
  });

  it("names the substitution on the side that suffered it", async () => {
    speak.mockImplementation(async (text: string) =>
      result([text.includes("[happy]")
        ? seg({ requested: "happy", used: "baseline", voice_id: "v_base", fallback: true })
        : seg({ requested: "baseline", used: "baseline", voice_id: "v_base" })]));
    render(<EmotionAB {...PROPS} />);
    await act(async () => {
      screen.getByRole("button", { name: /render both/i }).click();
    });
    await screen.findByText(/spoken by Baseline — Sarah has no Happy recording/i);
  });

  it("refuses to count a browser-voice take as evidence about the Voice", async () => {
    speak.mockImplementation(async () =>
      result([], { mode: "browser", url: undefined, fallbackReason: "unreachable" }));
    render(<EmotionAB {...PROPS} />);
    await act(async () => {
      screen.getByRole("button", { name: /render both/i }).click();
    });
    const warnings = await screen.findAllByText(/says nothing about the Voice/i);
    expect(warnings).toHaveLength(2);
  });

  it("treats backpressure as a wait, keeping whatever already rendered", async () => {
    speak
      .mockImplementationOnce(async () => result([seg({ used: "baseline", voice_id: "v_base" })]))
      .mockImplementationOnce(async () => { throw new EngineBusyError(7); });
    render(<EmotionAB {...PROPS} />);
    await act(async () => {
      screen.getByRole("button", { name: /render both/i }).click();
    });
    await screen.findByText(/engine is at capacity — side B was not rendered/i);
    // Side A survived: its play button is live, not reset.
    expect(screen.getByRole("button", { name: /play side A/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /play side B/i })).toBeDisabled();
  });

  it("puts a failure on the side that earned it, in the backend's words", async () => {
    speak
      .mockImplementationOnce(async () => result([seg({ used: "baseline", voice_id: "v_base" })]))
      .mockImplementationOnce(async () => { throw new Error("synthesis failed (request 4f2a)"); });
    render(<EmotionAB {...PROPS} />);
    await act(async () => {
      screen.getByRole("button", { name: /render both/i }).click();
    });
    await screen.findByText(/synthesis failed \(request 4f2a\)/i);
    expect(screen.getByRole("button", { name: /play side A/i })).toBeEnabled();
  });

  it("gates a double click — one pair, not two", async () => {
    speak.mockImplementation(async () => result([seg()]));
    render(<EmotionAB {...PROPS} />);
    const btn = screen.getByRole("button", { name: /render both/i });
    await act(async () => { btn.click(); btn.click(); });
    await waitFor(() => expect(speak).toHaveBeenCalledTimes(2));
  });

  it("drops a side's take when its emotion changes — no relabelled audio", async () => {
    speak.mockImplementation(async () => result([seg()]));
    const { container } = render(<EmotionAB {...PROPS} />);
    await act(async () => {
      screen.getByRole("button", { name: /render both/i }).click();
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /play side A/i })).toBeEnabled());

    const select = screen.getByRole("combobox", { name: /emotion for side A/i });
    await act(async () => {
      (select as HTMLSelectElement).value = "angry";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(screen.getByRole("button", { name: /play side A/i })).toBeDisabled();
    expect(container).toBeTruthy();
  });
});
