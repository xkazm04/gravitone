import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/useAuth", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/lib/voiceVault", () => ({
  CONSENT_PROMPT: "consent?",
  recordVoiceOwnership: async () => ({ saved: 0, failed: 0 }),
}));

import CharacterVoices from "./CharacterVoices";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("CharacterVoices — unavailable is not nonexistent", () => {
  it("reads a 503 as unavailable-and-retryable, not as a missing character", async () => {
    // Everything that was not a 404 used to fall through to the "No character"
    // dead-end, so a temporarily unreadable registry told the user their
    // character did not exist.
    vi.stubGlobal("fetch", vi.fn(async () =>
      json({ detail: "the voice registry is unreadable" }, 503)));
    render(<CharacterVoices characterId="sarah" />);

    await screen.findByText(/the voice registry is unreadable/i);
    expect(screen.queryByText(/No character/i)).toBeNull();
    expect(screen.getByText(/failed read, not a missing character/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^retry$/i })).toBeInTheDocument();
  });

  it("still says a 404 character does not exist", async () => {
    // The other half: a genuinely absent character must stay expressible.
    vi.stubGlobal("fetch", vi.fn(async () => json({ detail: "no such character" }, 404)));
    render(<CharacterVoices characterId="ghost" />);

    await screen.findByText(/No character “ghost”/);
    expect(screen.queryByRole("button", { name: /^retry$/i })).toBeNull();
  });

  it("loads the character once the retry succeeds", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json({ detail: "backend unreachable" }, 503))
      .mockResolvedValue(json({
        character_id: "sarah", name: "Sarah", category: "cloned", tags: [],
        lang: "en", voices: [], emotions: [], coverage: 0, total: 8,
      }));
    vi.stubGlobal("fetch", f);
    render(<CharacterVoices characterId="sarah" />);

    const retry = await screen.findByRole("button", { name: /^retry$/i });
    await act(async () => { retry.click(); });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Sarah" })).toBeInTheDocument());
  });
});
