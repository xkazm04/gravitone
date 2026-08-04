// The audition matrix on screen: does a user actually SEE what happened?
//
// The runner's promises are pinned in ./audition.test.ts. This file is about
// the surface — that a failure lands on the tile that earned it, that a
// backpressure wait reads as a wait rather than as breakage, and that a second
// click cannot double-queue the whole scale.
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import EmotionAudition from "./EmotionAudition";
import { clearAuditionCache } from "./audition";
import type { Slot, Voice } from "@/app/voices/_data/characters";

afterEach(() => { vi.unstubAllGlobals(); clearAuditionCache(); });

function voice(emotion: string): Voice {
  return {
    voice_id: `v_${emotion}`, character_id: "sarah", emotion, name: "Sarah",
    category: "cloned", lang: "en", origin: "recorded",
  };
}

function slot(emotion: string, label: string, filled = true): Slot {
  const v = filled ? voice(emotion) : null;
  return { emotion, label, hue: 200, custom: false, voice: v, voices: v ? [v] : [], demand: 0 };
}

const SLOTS = [slot("baseline", "Baseline"), slot("happy", "Happy")];

function wav(): Response {
  return new Response(new Blob(["riff"]), {
    status: 200, headers: { "Content-Type": "audio/wav" },
  });
}

describe("EmotionAudition", () => {
  it("auditions every recorded Voice on one line and marks each ready", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init: RequestInit) => {
      bodies.push(String(init.body));
      return wav();
    }));

    render(<EmotionAudition name="Sarah" slots={SLOTS} />);
    await act(async () => {
      screen.getByRole("button", { name: /audition all 2/i }).click();
    });

    await waitFor(() => expect(screen.getByText("2/2 rendered")).toBeInTheDocument());
    // Same text, different voices — the experiment, asserted.
    const texts = bodies.map((b) => JSON.parse(b).text);
    expect(new Set(texts).size).toBe(1);
    expect(bodies.map((b) => JSON.parse(b).voiceId).sort()).toEqual(["v_baseline", "v_happy"]);
  });

  it("shows a failure against its own emotion, in the backend's words", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init: RequestInit) =>
      JSON.parse(String(init.body)).voiceId === "v_happy"
        ? new Response(JSON.stringify({ detail: "the voice registry is unreadable" }),
                       { status: 503, headers: { "Content-Type": "application/json" } })
        : wav()));

    render(<EmotionAudition name="Sarah" slots={SLOTS} />);
    await act(async () => {
      screen.getByRole("button", { name: /audition all 2/i }).click();
    });

    await screen.findByText(/the voice registry is unreadable/i);
    // The other tile still succeeded — one failure is not a failed run.
    expect(screen.getByText("1/2 rendered")).toBeInTheDocument();
    // And the failed tile is NOT left offering a play button over nothing.
    expect(screen.getByRole("button", { name: /^Play Happy$/ })).toBeDisabled();
  });

  it("reads a 429 as a wait with the backend's own Retry-After", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn(async () =>
        new Response(JSON.stringify({ detail: "queue full" }),
                     { status: 429, headers: { "Retry-After": "3" } })));

      render(<EmotionAudition name="Sarah" slots={[slot("happy", "Happy")]} />);
      await act(async () => {
        screen.getByRole("button", { name: /audition all 1/i }).click();
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });

      expect(screen.getByText(/engine full — retrying in 3s/i)).toBeInTheDocument();
      expect(screen.getByText(/1 waiting on the queue/i)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the slots it deliberately left out rather than faking a full scale", () => {
    render(<EmotionAudition name="Sarah"
      slots={[slot("baseline", "Baseline"), slot("angry", "Angry", false)]} />);
    expect(screen.getByText(/1 slot not recorded — Angry/i)).toBeInTheDocument();
  });

  it("says so when there is nothing to audition", () => {
    render(<EmotionAudition name="Sarah" slots={[slot("angry", "Angry", false)]} />);
    expect(screen.getByText(/no recorded Voices yet/i)).toBeInTheDocument();
  });

  it("gates a double click — one run, not two", async () => {
    const f = vi.fn(async () => wav());
    vi.stubGlobal("fetch", f);
    render(<EmotionAudition name="Sarah" slots={SLOTS} />);
    const btn = screen.getByRole("button", { name: /audition all 2/i });
    await act(async () => { btn.click(); btn.click(); });
    await waitFor(() => expect(screen.getByText("2/2 rendered")).toBeInTheDocument());
    expect(f).toHaveBeenCalledTimes(2); // two voices, not four
  });
});
