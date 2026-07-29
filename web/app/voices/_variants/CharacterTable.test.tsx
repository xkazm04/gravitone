import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The data layer reaches Firebase auth through useAuth.
vi.mock("@/lib/useAuth", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/lib/voiceVault", () => ({
  CONSENT_PROMPT: "consent?",
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
