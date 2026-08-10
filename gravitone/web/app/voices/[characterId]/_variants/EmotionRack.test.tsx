import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The rack pulls in the data layer, whose hooks reach Firebase auth — it
// refuses to initialize without real keys. Rendering is what's under test.
vi.mock("@/lib/useAuth", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/lib/voiceVault", () => ({ recordVoiceOwnership: async () => ({ saved: 0, failed: 0 }) }));

import EmotionRack from "./EmotionRack";
import { EMOTION_RULE } from "@/lib/slugs";
import type { DerivedFrom, Slot, Voice } from "@/app/voices/_data/characters";

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

// ── Emotion Algebra ──────────────────────────────────────────────────────────
// The trust contract, in tests: a computed slot may never render as a recording,
// a refusal must arrive as the service's own sentence, and the third action must
// not exist at all where the page cannot perform it.

function derived(id: string, emotion: string, donorName = "Mary"): Voice {
  return {
    ...voice(id, emotion),
    origin: "derived",
    derived_from: { source: "donor", donor: "mary", donor_name: donorName,
                    emotion, basis_version: 1, alpha: 0.9 },
  };
}

/** The rack's own table. The audition matrix below it renders the derived chip
 *  as well (deliberately — see EmotionAudition.test.tsx), so every assertion
 *  about a ROW scopes itself here rather than to the whole document. */
function rack(): HTMLElement {
  return screen.getByRole("table");
}

function renderDerivable(slots: Slot[], deriveVoice = vi.fn(async () => {})) {
  render(
    <EmotionRack
      name="Sarah" characterId="sarah" slots={slots}
      coverage={slots.filter((s) => s.voice).length} total={slots.length}
      busySlot={null} addVoice={vi.fn()} removeVoice={vi.fn()} onRecord={vi.fn()}
      addCustomEmotion={vi.fn()} removeCustomEmotion={vi.fn()}
      deriveVoice={deriveVoice}
    />,
  );
  return deriveVoice;
}

function rosterFetch(characters: unknown[]) {
  return vi.fn(async () => new Response(JSON.stringify(characters), {
    status: 200, headers: { "Content-Type": "application/json" },
  }));
}

describe("EmotionRack — a derived slot is never a recording", () => {
  it("badges the donor instead of 'recorded'", () => {
    renderDerivable([
      slot("baseline", "Baseline", [voice("v_base", "baseline")]),
      slot("angry", "Angry", [derived("v_derived", "angry")]),
    ]);

    // Scoped to the RACK: the audition matrix underneath now marks its derived
    // tiles too, so an unscoped query would be asserting over both surfaces.
    expect(within(rack()).getByText(/derived · from Mary/)).toBeInTheDocument();
    // Exactly one "recorded" chip in the rack: the baseline's.
    expect(within(rack()).getAllByText("recorded")).toHaveLength(1);
    // …and the header counts it separately from the recordings.
    expect(screen.getByText(/1\/2 recorded/)).toBeInTheDocument();
    expect(screen.getByText(/1 derived/)).toBeInTheDocument();
  });

  it("keeps the demand counter alive for a derived slot", () => {
    // Computing a stand-in did not answer the appetite for a real performance,
    // and the service keeps counting it — so the rack keeps showing it.
    const s = slot("angry", "Angry", [derived("v_derived", "angry")]);
    renderDerivable([{ ...s, demand: 4 }]);
    expect(screen.getByText(/still requested 4x/)).toBeInTheDocument();
  });

  it("offers one click from computed to performed", () => {
    const onRecord = vi.fn();
    render(
      <EmotionRack
        name="Sarah" characterId="sarah"
        slots={[slot("angry", "Angry", [derived("v_derived", "angry")])]}
        coverage={1} total={1} busySlot={null}
        addVoice={vi.fn()} removeVoice={vi.fn()} onRecord={onRecord}
        addCustomEmotion={vi.fn()} removeCustomEmotion={vi.fn()}
        deriveVoice={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", {
      name: "Promote the derived Angry voice to a recording",
    }));
    expect(onRecord).toHaveBeenCalledWith("angry");
  });

  it("names the basis when no single donor supplied the direction", () => {
    const v: Voice = {
      ...voice("v_derived", "angry"), origin: "derived",
      derived_from: { source: "basis", donor: null, contributors: ["a", "b", "c"] },
    };
    renderDerivable([slot("angry", "Angry", [v])]);
    expect(within(rack()).getByText(/derived · from 3 voices/)).toBeInTheDocument();
  });
});

// ── did anybody ever MEASURE that this emotion travels? ──────────────────────
// The service emits one shape for it (emotion_basis.transfer_payload) with three
// named states. The rack must tell them apart — and must keep rendering a row
// that predates the block exactly as it did before, since that is every derived
// row written by an older service.

function withTransfer(v: Voice, transfer: NonNullable<DerivedFrom["transfer"]> | undefined): Voice {
  return { ...v, derived_from: { ...(v.derived_from as DerivedFrom), transfer } };
}

const MEASURED = {
  state: "measured", quality: 0.72, speakers: 3, in_sample: 2,
  min_quality: 0.5, measured: "2026-08-01", version: 1,
} as const;

describe("EmotionRack — the transfer measurement, or its plain absence", () => {
  it("states a measured transfer with the number that was measured", () => {
    renderDerivable([
      slot("angry", "Angry", [withTransfer(derived("v_d", "angry"), { ...MEASURED })]),
    ]);
    expect(within(rack()).getByText(/transfer measured · 0\.72/)).toBeInTheDocument();
    // The donor chip is untouched — the two facts are separate.
    expect(within(rack()).getByText(/derived · from Mary/)).toBeInTheDocument();
    expect(screen.getByTitle(/across 3 speakers, measured 2026-08-01/)).toBeInTheDocument();
  });

  it("marks a below-the-bar transfer against its bar, as an advisory", () => {
    renderDerivable([
      slot("angry", "Angry", [withTransfer(derived("v_d", "angry"),
        { ...MEASURED, state: "below-bar", quality: 0.31 })]),
    ]);
    expect(within(rack()).getByText(/transfer below the bar · 0\.31/)).toBeInTheDocument();
    expect(screen.getByTitle(/against a bar of 0\.50/)).toBeInTheDocument();
  });

  it("says nobody measured it — as a fact, not as a fault", () => {
    // The normal state on every install today: derive_ab has never run.
    renderDerivable([
      slot("angry", "Angry", [withTransfer(derived("v_d", "angry"),
        { state: "unmeasured", quality: null, speakers: 0, in_sample: 0,
          min_quality: 0.5, measured: null, version: 1 })]),
    ]);
    const chip = within(rack()).getByText("transfer unmeasured");
    expect(chip).toBeInTheDocument();
    // Neutral, not amber/rose: an unrun harness is not a defect in this voice.
    expect(chip.className).toContain("text-white/55");
    expect(chip.className).not.toMatch(/amber|rose/);
    expect(screen.getByTitle(/not evidence against this voice/)).toBeInTheDocument();
    // …and no number is invented for a measurement that never happened.
    expect(screen.queryByText(/0\.00/)).toBeNull();
  });

  it("renders a row that predates the block exactly as it always did", () => {
    renderDerivable([slot("angry", "Angry", [withTransfer(derived("v_d", "angry"), undefined)])]);
    expect(within(rack()).getByText(/derived · from Mary/)).toBeInTheDocument();
    expect(within(rack()).queryByText(/transfer/i)).toBeNull();
  });

  it("says nothing about transfer on a recording", () => {
    renderDerivable([slot("baseline", "Baseline", [voice("v_base", "baseline")])]);
    expect(within(rack()).getByText("recorded")).toBeInTheDocument();
    expect(within(rack()).queryByText(/transfer/i)).toBeNull();
  });
});

describe("EmotionRack — derive from…", () => {
  it("does not exist where the page cannot derive", () => {
    // Absent = invisible, the same rule the Signal chip follows.
    renderSlots([slot("angry", "Angry", [])]);
    expect(screen.queryByText(/derive from/)).toBeNull();
  });

  it("opens a donor picker over the roster's recorded takes", async () => {
    vi.stubGlobal("fetch", rosterFetch([
      { character_id: "sarah", name: "Sarah", voices: [{ emotion: "baseline" }] },
      { character_id: "mary", name: "Mary",
        voices: [{ emotion: "baseline" }, { emotion: "angry" }] },
      { character_id: "paul", name: "Paul",
        voices: [{ emotion: "angry", origin: "derived" }] },
    ]));
    renderDerivable([slot("angry", "Angry", [])]);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", {
        name: "Derive the Angry voice from another recording",
      }));
    });

    expect(screen.getByRole("button", { name: "shared basis" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mary" })).toBeInTheDocument();
    // Paul only has a DERIVED angry — deriving from a derived take compounds the
    // approximation, and the service refuses it, so it is never offered.
    expect(screen.queryByRole("button", { name: "Paul" })).toBeNull();
    // …and the character itself is not its own donor.
    expect(screen.queryByRole("button", { name: "Sarah" })).toBeNull();
  });

  it("says so when nobody else has recorded this emotion", async () => {
    vi.stubGlobal("fetch", rosterFetch([
      { character_id: "mary", name: "Mary", voices: [{ emotion: "baseline" }] },
    ]));
    renderDerivable([slot("angry", "Angry", [])]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", {
        name: "Derive the Angry voice from another recording",
      }));
    });
    expect(screen.getByText(/no other character has recorded Angry yet/)).toBeInTheDocument();
  });

  it("derives from the shared basis with a null donor", async () => {
    vi.stubGlobal("fetch", rosterFetch([]));
    const deriveVoice = renderDerivable([slot("angry", "Angry", [])]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", {
        name: "Derive the Angry voice from another recording",
      }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "shared basis" }));
    });
    expect(deriveVoice).toHaveBeenCalledWith("angry", null);
  });

  it("derives from a named donor", async () => {
    vi.stubGlobal("fetch", rosterFetch([
      { character_id: "mary", name: "Mary", voices: [{ emotion: "angry" }] },
    ]));
    const deriveVoice = renderDerivable([slot("angry", "Angry", [])]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", {
        name: "Derive the Angry voice from another recording",
      }));
    });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Mary" })); });
    expect(deriveVoice).toHaveBeenCalledWith("angry", "mary");
  });

  it("renders the service's refusal verbatim, against the slot it refused", async () => {
    // This box answers 501 ("safetensors is not installed"), which is the honest
    // answer and the one worth reading — "derive failed" would hide it.
    vi.stubGlobal("fetch", rosterFetch([]));
    const reason = "deriving emotions is not available here: safetensors is not installed";
    const deriveVoice = vi.fn(async () => { throw new Error(reason); });
    renderDerivable([slot("angry", "Angry", [])], deriveVoice);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", {
        name: "Derive the Angry voice from another recording",
      }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "shared basis" }));
    });

    expect(await screen.findByText(new RegExp(reason))).toBeInTheDocument();
    // The slot is still empty and still offers both real routes.
    expect(screen.getByText(/● record this/)).toBeInTheDocument();
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
