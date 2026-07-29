import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The table reaches the data layer, whose hooks touch Firebase auth.
vi.mock("@/lib/useAuth", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/lib/voiceVault", () => ({
  CONSENT_PROMPT: "I attest…",
  recordVoiceOwnership: async () => ({ saved: 0, failed: 0 }),
}));

import CharacterTable from "./CharacterTable";
import { invalidateRoster } from "../_data/characters";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => { invalidateRoster(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("CharacterTable — a failed roster read is never an empty roster", () => {
  it("does not print an empty state when the read FAILED", async () => {
    // A corrupt registry 503s service-wide; the table used to render
    // "No characters match." directly underneath its own error banner.
    vi.stubGlobal("fetch", vi.fn(async () =>
      json({ detail: "the voice registry is unreadable" }, 503)));
    render(<CharacterTable />);

    await screen.findByText(/could not be loaded/i);
    expect(screen.queryByText(/No characters match/i)).toBeNull();
    expect(screen.queryByText(/No characters yet/i)).toBeNull();
    // The service's own detail still reaches the user.
    expect(screen.getByText(/the voice registry is unreadable/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^retry$/i })).toBeInTheDocument();
  });

  it("still expresses a genuinely empty roster as empty", async () => {
    // The other half: a new install must NOT be dressed up as a failure.
    vi.stubGlobal("fetch", vi.fn(async () => json([])));
    render(<CharacterTable />);

    await screen.findByText(/No characters yet/i);
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /^retry$/i })).toBeNull();
  });

  it("says 'no match' — not 'no characters' — when a filter empties the table", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json([
      { character_id: "sarah", name: "Sarah", category: "cloned", tags: ["hero"],
        lang: "en", voices: [], emotions: [], coverage: 0, total: 8 },
    ])));
    render(<CharacterTable />);
    await screen.findByText("Sarah");

    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(screen.getByPlaceholderText(/Search characters/i), { target: { value: "zzz" } });
    await screen.findByText(/No characters match/i);
    expect(screen.queryByText(/No characters yet/i)).toBeNull();
  });

  it("recovers to the roster when the retry succeeds", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json({ detail: "backend is down" }, 503))
      .mockResolvedValue(json([
        { character_id: "sarah", name: "Sarah", category: "cloned", tags: [],
          lang: "en", voices: [], emotions: [], coverage: 0, total: 8 },
      ]));
    vi.stubGlobal("fetch", f);
    render(<CharacterTable />);

    const retry = await screen.findByRole("button", { name: /^retry$/i });
    await act(async () => { retry.click(); });
    await waitFor(() => expect(screen.getByText("Sarah")).toBeInTheDocument());
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
  });
});

// ── the collision suites ─────────────────────────────────────────────────────

const ROSTER = [
  {
    character_id: "sarah", name: "Sarah", category: "cloned", tags: ["warm"], lang: "en",
    emotions: ["baseline"], coverage: 1, total: 8, created: null,
    voices: [{ voice_id: "v_sarah_base", character_id: "sarah", emotion: "baseline",
               name: "Sarah", category: "cloned", lang: "en" }],
  },
  {
    character_id: "mary", name: "Mary", category: "premade", tags: ["built-in"], lang: "en",
    emotions: ["baseline"], coverage: 1, total: 8, created: null,
    voices: [{ voice_id: "mary", character_id: "mary", emotion: "baseline",
               name: "Mary", category: "premade", lang: "en" }],
  },
];

const BUILTIN_409 = "'Mary' collides with the built-in character 'mary' — pick a different name";
const SLOT_409 = "'sarah' already has a 'baseline' voice (v_sarah_base) — delete or re-slot that voice first";

/** Roster reads always succeed; POSTs answer from `posts` in order. */
function stubFetch(posts: Response[]) {
  const calls: Array<{ url: string; body: FormData | null }> = [];
  const f = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body instanceof FormData ? init.body : null });
    if (init?.method === "POST") return posts.shift() ?? json({ detail: "unexpected" }, 500);
    return json(ROSTER);
  });
  vi.stubGlobal("fetch", f);
  return calls;
}

function pickAudioFile(name = "mary.wav") {
  const input = document.querySelector<HTMLInputElement>('input[accept="audio/*,video/mp4"]')!;
  fireEvent.change(input, { target: { files: [new File(["…"], name, { type: "audio/wav" })] } });
}

beforeEach(() => { vi.stubGlobal("confirm", vi.fn(() => true)); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("CharacterTable — a collision gets an answer, not a banner", () => {
  it("keeps the file and asks for another name when the quick clone 409s", async () => {
    // The name comes from the FILENAME and the built-in ids are ordinary first
    // names, so dropping mary.wav is a guaranteed 409. It used to be a generic
    // banner with the chosen file discarded.
    const calls = stubFetch([json({ detail: BUILTIN_409 }, 409),
                             json({ voice_id: "v_new", character_id: "mary-2", emotion: "baseline" })]);
    render(<CharacterTable />);
    await screen.findByText("Sarah");

    pickAudioFile();
    expect(await screen.findByText(BUILTIN_409)).toBeInTheDocument();
    expect(screen.getByText(/mary\.wav.*is still here/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Character name"), { target: { value: "Mary Two" } });
    fireEvent.click(screen.getByRole("button", { name: /clone under this name/ }));

    await waitFor(() => expect(calls.filter((c) => c.url === "/api/voices")).toHaveLength(2));
    // The retained file is re-sent under the new name — and the user is not
    // asked to re-attest consent for a file they already attested to.
    expect(calls.filter((c) => c.url === "/api/voices")[1].body!.get("character")).toBe("Mary Two");
    expect(window.confirm).toHaveBeenCalledTimes(1);
  });

  it("links the voice a slot collision names instead of printing a bare id", async () => {
    stubFetch([json({ detail: SLOT_409 }, 409)]);
    render(<CharacterTable />);
    await screen.findByText("Sarah");

    pickAudioFile("sarah.wav");
    await screen.findByText(SLOT_409, { exact: false });
    expect(await screen.findByRole("link", { name: /open Sarah/ })).toHaveAttribute("href", "/voices/sarah");
  });

  it("asks the import question with the backend's own words", async () => {
    // The old prompt asserted "a character with this id already exists", which
    // is false for a built-in collision, and threw the real detail away.
    const prompt = vi.fn((_message?: string): string | null => null);
    vi.stubGlobal("prompt", prompt);
    stubFetch([json({ detail: BUILTIN_409 }, 409)]);
    render(<CharacterTable />);
    await screen.findByText("Sarah");

    const input = document.querySelector<HTMLInputElement>('input[accept=".gravichar,application/zip"]')!;
    fireEvent.change(input, { target: { files: [new File(["…"], "mary.gravichar")] } });

    await waitFor(() => expect(prompt).toHaveBeenCalled());
    expect(prompt.mock.calls[0][0]).toContain(BUILTIN_409);
    expect(await screen.findByText(BUILTIN_409)).toBeInTheDocument();
  });
});

describe("CharacterTable — what the backend will refuse is not offered", () => {
  it("does not offer rename or tag editing on a built-in", async () => {
    stubFetch([]);
    render(<CharacterTable />);
    await screen.findByText("Sarah");

    // Cloned row: still renameable and taggable.
    fireEvent.doubleClick(screen.getByTitle("Double-click to rename"));
    expect(screen.getByDisplayValue("Sarah")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "+ tag" })).toHaveLength(1);

    // Built-in row: PATCH would 409, so there is nothing to optimistically
    // paint and snap back.
    expect(screen.getByTitle(/Built-in characters ship with the service and cannot be renamed/))
      .toHaveTextContent("Mary");
    expect(screen.queryByRole("button", { name: "Remove tag built-in" })).not.toBeInTheDocument();
  });

  it("skips built-ins in a bulk tag and says it did", async () => {
    stubFetch([]);
    render(<CharacterTable />);
    await screen.findByText("Sarah");

    fireEvent.click(screen.getByLabelText("Select Mary"));
    fireEvent.change(screen.getByPlaceholderText("add tag to all…"), { target: { value: "cast" } });
    fireEvent.click(screen.getByRole("button", { name: "apply tag" }));

    expect(await screen.findByText(/1 built-in character was skipped/)).toBeInTheDocument();
    // …and no PATCH was attempted for it.
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
      .some(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")).toBe(false);
  });
});
