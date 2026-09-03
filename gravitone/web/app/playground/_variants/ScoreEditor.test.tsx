import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import ScoreEditor from "./ScoreEditor";
import { DEFAULT_TEXT, parseTags } from "./playgroundHelpers";

// The score is a VIEW of a string the engine already understands, so every test
// here asserts on the string that comes back out. If the editor's picture and
// its string ever disagree, the user renders something they did not direct.

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  // jsdom ships no object-URL support. Patch the two methods onto the real URL
  // rather than replacing the global — next/image constructs URLs.
  const url = URL as unknown as { createObjectURL?: unknown; revokeObjectURL?: unknown };
  url.createObjectURL ??= () => "blob:region-1";
  url.revokeObjectURL ??= () => {};
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:region-1");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The console owns the text; the editor is controlled. Mirror that here so a
 *  test sees exactly the string the composer would end up holding. */
function Host({ initial, ...rest }: { initial: string } & Partial<React.ComponentProps<typeof ScoreEditor>>) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <ScoreEditor
        value={value}
        onChange={setValue}
        characterId="sarah"
        available={["baseline", "excited", "whisper"]}
        scale={["excited", "whisper", "sad"]}
        {...rest}
      />
      <output data-testid="wire">{value}</output>
    </>
  );
}

const mount = (initial: string, rest: Partial<React.ComponentProps<typeof ScoreEditor>> = {}) =>
  render(<Host initial={initial} {...rest} />);

const wire = () => screen.getByTestId("wire").textContent;
const area = () => screen.getByRole("textbox", { name: "Score text" }) as HTMLTextAreaElement;
// Scoped to the score SECTION, not to the textarea's immediate parent: the text
// surface is now a wrapper (mirror + textarea, ScoreText) rather than a bare
// element, so `parentElement` stopped being the section that holds the notice.
// The director's answer is a live region too, so this is scoped past it — the
// two say different things and a test that reads whichever came first would be
// asserting on the DOM order rather than on the message.
const notice = () => screen.getByRole("textbox", { name: "Score text" }).closest("section")
  ?.querySelector("[aria-live]:not([data-testid])")?.textContent ?? "";

/** Select characters [a, b) in the score's text area. */
function select(a: number, b: number) {
  const el = area();
  el.setSelectionRange(a, b);
  fireEvent.select(el);
}

const TEXT = "one two three";

describe("ScoreEditor — the tagged string, seen and edited", () => {
  it("shows the text without its tags and one region per directed span", () => {
    mount("one [excited]two[/excited] three");
    expect(area().value).toBe(TEXT);
    expect(screen.getByRole("button", { name: /Region 1 of 1/ })).toHaveAccessibleName(/text: two/);
  });

  it("says plainly when nothing is directed yet", () => {
    mount(TEXT);
    expect(screen.getByText(/No direction yet/)).toBeInTheDocument();
    expect(screen.getByText(/score · 0 regions/)).toBeInTheDocument();
  });

  it("directs the selected words and writes them back as tags", () => {
    mount(TEXT);
    select(4, 7);
    fireEvent.click(screen.getByRole("button", { name: "+ add region" }));
    expect(wire()).toBe("one [excited]two[/excited] three");
  });

  it("refuses an empty selection with a sentence instead of an empty tag pair", () => {
    mount(TEXT);
    select(5, 5);
    fireEvent.click(screen.getByRole("button", { name: "+ add region" }));
    expect(notice()).toMatch(/at least one character/);
    expect(wire()).toBe(TEXT);
  });

  it("refuses an overlapping region and names what it would collide with", () => {
    mount("one [excited]two[/excited] three");
    select(5, 9);
    fireEvent.click(screen.getByRole("button", { name: "+ add region" }));
    expect(notice()).toMatch(/overlaps the excited region/);
  });

  it("nudges an edge from the keyboard and re-writes the string", () => {
    mount("one [excited]two[/excited] three");
    fireEvent.keyDown(screen.getByRole("slider", { name: /region end/i }), { key: "ArrowRight" });
    expect(wire()).toBe("one [excited]two [/excited]three");
  });

  it("keeps an edge from crossing its own opposite edge", () => {
    mount("one [excited]two[/excited] three");
    const handle = () => screen.getByRole("slider", { name: /region start/i });
    for (let i = 0; i < 6; i += 1) fireEvent.keyDown(handle(), { key: "ArrowRight" });
    // start may reach end-1 and no further: the region is never inverted.
    expect(wire()).toBe("one tw[excited]o[/excited] three");
  });

  it("keeps focus on the handle it is dragging, press after press", () => {
    // The region used to be keyed by its own offsets, so every nudge remounted
    // it and dropped focus — one arrow press was all a keyboard user got.
    mount("one [excited]two[/excited] three");
    const handle = screen.getByRole("slider", { name: /region end/i });
    handle.focus();
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("slider", { name: /region end/i }));
    expect(wire()).toBe("one [excited]two t[/excited]hree");
  });

  it("moves an edge from the numeric field — the path that needs no pointer at all", () => {
    mount("one [excited]two[/excited] three");
    fireEvent.click(screen.getByRole("button", { name: /Region 1 of 1/ }));
    fireEvent.change(screen.getByLabelText("Region end, character offset"), { target: { value: "9" } });
    expect(wire()).toBe("one [excited]two t[/excited]hree");
  });

  it("retags a region without moving it", () => {
    mount("one [excited]two[/excited] three");
    fireEvent.click(screen.getByRole("button", { name: /Region 1 of 1/ }));
    fireEvent.change(screen.getByLabelText("Region emotion"), { target: { value: "whisper" } });
    expect(wire()).toBe("one [whisper]two[/whisper] three");
  });

  it("deletes a region back to baseline and says so", () => {
    mount("one [excited]two[/excited] three");
    fireEvent.click(screen.getByRole("button", { name: /Region 1 of 1/ }));
    fireEvent.click(screen.getByRole("button", { name: "delete" }));
    expect(wire()).toBe(TEXT);
    expect(notice()).toMatch(/return to baseline/);
  });
});

describe("ScoreEditor — edits never drift the direction onto other words", () => {
  it("carries a region across an insertion before it", () => {
    mount("one [excited]two[/excited] three");
    fireEvent.change(area(), { target: { value: "zero one two three" } });
    expect(wire()).toBe("zero one [excited]two[/excited] three");
  });

  it("carries a region across a deletion before it", () => {
    mount("one [excited]two[/excited] three");
    fireEvent.change(area(), { target: { value: "two three" } });
    expect(wire()).toBe("[excited]two[/excited] three");
  });

  it("CLEARS a region whose own words were rewritten, and names it", () => {
    mount("one [excited]two[/excited] three");
    fireEvent.change(area(), { target: { value: "one six three" } });
    expect(wire()).toBe("one six three");
    expect(notice()).toMatch(/Cleared 1 region \(Excited\)/);
    expect(notice()).toMatch(/rather than moved onto different words/);
  });

  it("clears only what was touched", () => {
    mount("[calm]one[/calm] [excited]two[/excited] three");
    fireEvent.change(area(), { target: { value: "one six three" } });
    expect(wire()).toBe("[calm]one[/calm] six three");
    expect(notice()).toMatch(/Cleared 1 region/);
  });
});

describe("ScoreEditor — hearing one region on its own", () => {
  function speakOk() {
    const fetchMock = vi.fn(async () =>
      new Response(new Blob(["RIFF"]), { status: 200, headers: { "Content-Type": "audio/wav" } }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("asks the engine for the SPAN, tagged, and nothing else", async () => {
    const fetchMock = speakOk();
    mount("one [excited]two[/excited] three");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Region 1 of 1/ }));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/speak");
    expect(JSON.parse(String(init.body))).toMatchObject({
      character_id: "sarah",
      text: "[excited]two[/excited]",
    });
  });

  it("reports a refusal in the engine's own words and changes nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ detail: "that Character no longer exists (req 42)" }),
        { status: 404, headers: { "Content-Type": "application/json" } })));
    mount("one [excited]two[/excited] three");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Region 1 of 1/ }));
    });
    await waitFor(() => expect(notice()).toMatch(/req 42/));
    expect(wire()).toBe("one [excited]two[/excited] three");
  });

  it("reports an unreachable engine rather than a silent dead button", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network"); }));
    mount("one [excited]two[/excited] three");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Region 1 of 1/ }));
    });
    await waitFor(() => expect(notice()).toMatch(/Could not reach the engine/));
  });

  it("asks for a Character before pretending it can preview", async () => {
    speakOk();
    mount("one [excited]two[/excited] three", { characterId: undefined });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Region 1 of 1/ }));
    });
    expect(notice()).toMatch(/Pick a Character/);
  });
});

describe("ScoreEditor — honest about what the Character can actually do", () => {
  it("marks an emotion the Character has not recorded", () => {
    mount(TEXT);
    const option = screen.getByRole("option", { name: /Sad \(not recorded\)/ });
    expect(option).toBeInTheDocument();
  });

  it("offers a custom emotion already on the text even though it is off the scale", () => {
    mount("[battle_cry]charge[/battle_cry]");
    expect(screen.getByRole("option", { name: /^Battle Cry/ })).toBeInTheDocument();
  });

  it("never renders an empty placement control", () => {
    mount(TEXT, { available: [], scale: [] });
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
  });
});

/** The "that worked" region — deliberately NOT the amber notice, which is
 *  advisory copy and the wrong voice for a success. */
const applied = () => screen.getByTestId("score-applied").textContent ?? "";

describe("ScoreEditor — applying an emotion is not a visual-only event", () => {
  it("announces what was wrapped, in words", () => {
    // The refusals were all announced; the case that WORKS said nothing at all,
    // so a screen-reader user pressed a chip and was told precisely nothing.
    mount(TEXT);
    select(4, 13);
    fireEvent.click(screen.getByRole("button", { name: "+ add region" }));
    expect(applied()).toBe("Wrapped 2 words in Excited.");
  });

  it("counts one word as one word", () => {
    mount(TEXT);
    select(4, 7);
    fireEvent.click(screen.getByRole("button", { name: "+ add region" }));
    expect(applied()).toBe("Wrapped 1 word in Excited.");
  });

  it("stays silent about success when the edit was REFUSED", () => {
    mount(TEXT);
    select(5, 5);
    fireEvent.click(screen.getByRole("button", { name: "+ add region" }));
    expect(applied()).toBe("");
    expect(notice()).toMatch(/at least one character/);
  });

  it("does not repeat a clearance that the notice already names", () => {
    mount("one [excited]two[/excited] three");
    fireEvent.click(screen.getByRole("button", { name: /Region 1 of 1/ }));
    fireEvent.click(screen.getByRole("button", { name: "delete" }));
    expect(notice()).toMatch(/return to baseline/);
    expect(applied()).toBe("");
  });
});

describe("ScoreEditor — the markup is available, not imposed", () => {
  it("hides the tagged string until asked, then shows it read-only", () => {
    const raw = "one [excited]two[/excited] three";
    mount(raw);
    expect(screen.queryByText(raw, { selector: "pre" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "markup" }));
    // A <pre>, not an input: the caret must never sit inside markup again.
    expect(screen.getByText(raw, { selector: "pre" })).toBeInTheDocument();
  });
});

// The scale the Host offers is ["excited","whisper","sad"] plus the recorded
// ones, so `confused` is NOT addressable — which is exactly the constraint the
// director has to respect.
const DIRECTABLE = "Hello there. This part is amazing! It ended quietly (or so they said)...";

const ghosts = () => [...screen.getByTestId("score-mirror").querySelectorAll("[data-suggested]")];
const rows = () => screen.getAllByRole("listitem");

describe("ScoreEditor — the director proposes, it never applies", () => {
  it("changes NOTHING about the string when it proposes", () => {
    mount(DIRECTABLE);
    fireEvent.click(screen.getByRole("button", { name: /direct this text/ }));
    expect(wire()).toBe(DIRECTABLE);
    expect(rows().length).toBeGreaterThan(0);
  });

  it("draws suggestions as ghosts, visibly distinct from a placed region", () => {
    mount(DIRECTABLE);
    fireEvent.click(screen.getByRole("button", { name: /direct this text/ }));
    const ghost = ghosts()[0] as HTMLElement;
    expect(ghost).toBeTruthy();
    // Dashed underline, not the solid inset rule a real region carries — a
    // difference of SHAPE, so it survives a reader who cannot compare tints.
    expect(ghost.style.textDecorationStyle).toBe("dashed");
    expect(ghost.style.boxShadow).toBe("");
    expect(screen.getByTestId("score-mirror").querySelectorAll("[data-emotion]")).toHaveLength(0);
  });

  it("states the method rather than implying it understood the words", () => {
    mount(DIRECTABLE);
    fireEvent.click(screen.getByRole("button", { name: /direct this text/ }));
    expect(screen.getByText(/from punctuation and phrasing/)).toBeInTheDocument();
    expect(screen.getByText(/not a reading/)).toBeInTheDocument();
  });

  it("shows the RULE behind each suggestion", () => {
    mount(DIRECTABLE);
    fireEvent.click(screen.getByRole("button", { name: /direct this text/ }));
    expect(screen.getByText("ends in an exclamation")).toBeInTheDocument();
    expect(screen.getByText("a bracketed aside")).toBeInTheDocument();
  });

  it("accepts ONE suggestion into the string and drops its row", () => {
    mount(DIRECTABLE);
    fireEvent.click(screen.getByRole("button", { name: /direct this text/ }));
    const before = rows().length;
    fireEvent.click(screen.getAllByRole("button", { name: /^Accept / })[0]);
    expect(wire()).toContain("[excited]This part is amazing![/excited]");
    expect(rows()).toHaveLength(before - 1);
  });

  it("rejects one without touching the string", () => {
    mount(DIRECTABLE);
    fireEvent.click(screen.getByRole("button", { name: /direct this text/ }));
    const before = rows().length;
    fireEvent.click(screen.getAllByRole("button", { name: /^Reject / })[0]);
    expect(wire()).toBe(DIRECTABLE);
    expect(rows()).toHaveLength(before - 1);
  });

  it("re-aims a suggestion and applies the emotion the USER chose", () => {
    mount(DIRECTABLE);
    fireEvent.click(screen.getByRole("button", { name: /direct this text/ }));
    fireEvent.change(screen.getAllByRole("combobox", { name: /Emotion for the suggestion/ })[0], {
      target: { value: "sad" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: /^Accept / })[0]);
    expect(wire()).toContain("[sad]This part is amazing![/sad]");
  });

  it("accepts all of them at once, and announces how many landed", () => {
    mount(DIRECTABLE);
    fireEvent.click(screen.getByRole("button", { name: /direct this text/ }));
    const n = rows().length;
    fireEvent.click(screen.getByRole("button", { name: "accept all" }));
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(applied()).toBe(`Accepted ${n} suggestions.`);
    expect(parseTags(wire() ?? "").text).toBe(DIRECTABLE);
  });

  it("dismisses all of them and says nothing was changed", () => {
    mount(DIRECTABLE);
    fireEvent.click(screen.getByRole("button", { name: /direct this text/ }));
    fireEvent.click(screen.getByRole("button", { name: "dismiss all" }));
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(wire()).toBe(DIRECTABLE);
    expect(screen.getByText(/nothing was changed/)).toBeInTheDocument();
  });

  it("DROPS the proposal when the words under it change, and says why", () => {
    mount(DIRECTABLE);
    fireEvent.click(screen.getByRole("button", { name: /direct this text/ }));
    fireEvent.change(area(), { target: { value: `${DIRECTABLE} More.` } });
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.getByText(/you changed the words they were made for/)).toBeInTheDocument();
  });

  it("withdraws a suggestion the user has just directed themselves", () => {
    mount(DIRECTABLE);
    fireEvent.click(screen.getByRole("button", { name: /direct this text/ }));
    const before = rows().length;
    select(13, 34); // "This part is amazing!" — the same words one suggestion covers
    fireEvent.click(screen.getByRole("button", { name: "+ add region" }));
    expect(rows()).toHaveLength(before - 1);
  });

  it("marks the fallback consequence for an emotion this Character has not recorded", () => {
    // `sad` is on the scale offered but is not in `available`, so it renders
    // through the fallback chain — said in composerWarnings' own words.
    mount(DIRECTABLE);
    fireEvent.click(screen.getByRole("button", { name: /direct this text/ }));
    fireEvent.change(screen.getAllByRole("combobox", { name: /Emotion for the suggestion/ })[0], {
      target: { value: "sad" },
    });
    expect(screen.getByText(/Sad is not recorded for this Character/)).toBeInTheDocument();
  });

  it("says plainly when the rules found nothing, rather than pretending to think", () => {
    mount("The report landed on Tuesday. It was thorough and dull.");
    fireEvent.click(screen.getByRole("button", { name: /direct this text/ }));
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.getByText(/punctuation, capitals and brackets, and found none/)).toBeInTheDocument();
  });

  it("offers nothing to direct when there is nothing written", () => {
    mount("");
    expect(screen.getByRole("button", { name: /direct this text/ })).toBeDisabled();
  });
});

// The composer's vertical stack used to be seven blocks with three headings
// that all began with the word "direct". These assert the order and the
// grouping, because that IS the fix — every behaviour below was already true.
describe("ScoreEditor — one panel, in the order the composer is read", () => {
  const panel = () => document.querySelector("[data-direction-panel]") as HTMLElement;
  const track = () => screen.getByRole("group", { name: /Emotion regions over/ });
  const before = (a: Element, b: Element) =>
    !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  it("reads text, then the lane strip, then ONE direction panel", () => {
    mount("one [excited]two[/excited] three");
    expect(before(area(), track())).toBe(true);
    expect(before(track(), panel())).toBe(true);
    expect(document.querySelectorAll("[data-direction-panel]")).toHaveLength(1);
  });

  it("holds the selection actions and the whole-text action in that one panel", () => {
    mount(TEXT, { chips: <button type="button">Excited</button> });
    for (const name of ["Excited", "+ add region", /direct this text/]) {
      expect(panel()).toContainElement(screen.getByRole("button", { name }));
    }
    // …and the chips come FIRST, because they are the fast path for the thing
    // the row beneath them does explicitly.
    expect(before(screen.getByRole("button", { name: "Excited" }),
                  screen.getByRole("button", { name: "+ add region" }))).toBe(true);
  });

  it("keeps the region inspector in the panel rather than in a box of its own", () => {
    mount("one [excited]two[/excited] three");
    fireEvent.click(screen.getByRole("button", { name: /Region 1 of 1/ }));
    const numeric = screen.getByLabelText("Region start, character offset");
    expect(panel()).toContainElement(numeric);
    expect(numeric.closest("[data-direction-panel] > .rounded-xl")).toBeNull();
  });

  it("still says what an undirected line will sound like", () => {
    mount(TEXT);
    expect(screen.getByText(/No direction yet/)).toBeInTheDocument();
  });
});

// "always does not do anything" — the report that produced this block.
//
// It was true, and it was not one bug. On the text the composer SHIPS WITH, the
// rules find exactly one span and then drop it (the default line is already
// directed), so the honest answer was "nothing to add" — and that answer was
// rendered as a 10px `text-white/50` fragment inside the button's own flex row,
// which on this panel is indistinguishable from having pressed nothing. Then it
// named the wrong reason on top of that. Every case here is about the click
// having a VISIBLE answer.
describe("ScoreEditor — the director always answers, out loud", () => {
  const answer = () => screen.queryByTestId("director-note")?.textContent ?? "";
  const press = () => fireEvent.click(screen.getByRole("button", { name: /direct this text/ }));

  it("says something visible for the DEFAULT text, whose one cue is already directed", () => {
    mount(DEFAULT_TEXT);
    expect(screen.queryByTestId("director-note")).not.toBeInTheDocument();
    press();
    // The regression this whole item is about: the click must produce a node.
    expect(screen.getByTestId("director-note")).toBeVisible();
    expect(answer()).toMatch(/already directed/);
    // …and must NOT blame the writing for a filter the user's own direction set.
    expect(answer()).not.toMatch(/found none of them here/);
    expect(wire()).toBe(DEFAULT_TEXT); // still nothing applied
  });

  it("shows real rows for a line with obvious cues", () => {
    mount("Wait! (be quiet) What is that?", { scale: ["excited", "whisper", "confused", "sad"] });
    press();
    expect(rows().length).toBeGreaterThan(0);
    expect(screen.getByText(/from punctuation and phrasing/)).toBeInTheDocument();
    // "Wait!" is five characters — under the old floor of eight, which declined
    // the shortest lines dialogue is actually made of.
    expect(ghosts().length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /^Accept .* "Wait!"/ })).toBeInTheDocument();
  });

  it("names the scale as the reason when the scale is the reason", () => {
    // A Character that can only be calm cannot be handed an excited span, and
    // the message says THAT rather than claiming the text held no cues.
    mount("This part is amazing!", { scale: ["calm"], available: ["baseline", "calm"] });
    press();
    expect(answer()).toMatch(/cannot address/);
    expect(answer()).toMatch(/Excited/);
  });

  it("keeps the empty answer on screen for the honest empty case too", () => {
    mount("The report landed on Tuesday. It was thorough and dull.");
    press();
    expect(screen.getByTestId("director-note")).toBeVisible();
    expect(answer()).toMatch(/punctuation, capitals and brackets/);
  });

  it("announces the answer rather than only drawing it", () => {
    mount(DEFAULT_TEXT);
    press();
    expect(screen.getByTestId("director-note")).toHaveAttribute("aria-live", "polite");
  });
});
