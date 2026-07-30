// The fork point on a public share page. Two properties are load-bearing:
// it is INVISIBLE without a studio session (re-rendering costs CPU on the box
// serving the page), and a handoff that could not be stored must not navigate
// as though it had.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { push, saveComposer } = vi.hoisted(() => ({ push: vi.fn(), saveComposer: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/composerStore", () => ({ saveComposer }));

import OpenInRack, { REMIX_PARENT_KEY } from "./OpenInRack";
import type { SharedTake } from "@/lib/takes";

const TAKE: SharedTake = {
  id: "take123abc", character_id: "sarah", character_name: "Sarah",
  text: "[angry] You said you would call.", seconds: 2, rtf: 0.2,
  segments: [], created: "2026-07-30T10:00:00+00:00",
};

const button = () => screen.queryByRole("button", { name: /open in the rack/i });

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  saveComposer.mockResolvedValue(undefined);
});

describe("OpenInRack — owner-only", () => {
  it("renders nothing for a visitor with no studio session", async () => {
    render(<OpenInRack take={TAKE} />);
    await waitFor(() => expect(button()).toBeNull());
  });

  it("appears once this browser holds a studio key", async () => {
    localStorage.setItem("gravitone.apiKey.uid1", JSON.stringify({ secret: "s", prefix: "p" }));
    render(<OpenInRack take={TAKE} />);
    await waitFor(() => expect(button()).not.toBeNull());
  });
});

describe("OpenInRack — the handoff", () => {
  beforeEach(() => {
    localStorage.setItem("gravitone.apiKey.uid1", JSON.stringify({ secret: "s", prefix: "p" }));
  });

  it("loads the take's script and Character, stamps the parent, then navigates", async () => {
    render(<OpenInRack take={TAKE} />);
    await waitFor(() => expect(button()).not.toBeNull());
    fireEvent.click(button()!);

    await waitFor(() => expect(push).toHaveBeenCalledWith("/playground"));
    expect(saveComposer).toHaveBeenCalledWith(expect.objectContaining({
      text: TAKE.text, charId: "sarah", mode: "solo", script: [], activeLine: 0,
    }));
    // The next published take is filed as this one's child.
    expect(sessionStorage.getItem(REMIX_PARENT_KEY)).toBe("take123abc");
  });

  it("says so instead of navigating when the composer could not be stored", async () => {
    saveComposer.mockRejectedValueOnce(new Error("quota exceeded"));
    render(<OpenInRack take={TAKE} />);
    await waitFor(() => expect(button()).not.toBeNull());
    fireEvent.click(button()!);

    expect(await screen.findByText(/quota exceeded/)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
    // ...and the button is offerable again rather than stuck on "opening"
    expect(button()).toBeEnabled();
  });
});
