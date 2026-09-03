// The derive path's in-flight gate.
//
// `removeVoice` grew `removingRef` specifically for the same-tick double-click,
// and derive — the mutation that MINTS a Voice — had nothing: `busySlot` is
// state, so `disabled` has not repainted when the second click of a double-click
// lands. The server prevents the double mint under its registry lock, which
// means the unsuppressed second request comes back as a raw 409 against a slot
// the user asked to fill once.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/useAuth", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/lib/voiceVault", () => ({ recordVoiceOwnership: async () => ({ saved: 0, failed: 0 }) }));

import { useCharacter } from "./characters";

afterEach(() => { vi.unstubAllGlobals(); });

const CHARACTER = {
  character_id: "sarah", name: "Sarah", category: "cloned", tags: [], lang: "en",
  voices: [], emotions: [], coverage: 0, total: 8,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}

/** A fetch that answers character reads immediately and holds every derive POST
 *  open until the test releases it — the window a double-click lives in. */
function harness() {
  const derives: string[] = [];
  let release: (() => void) | null = null;
  const f = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/derive")) {
      derives.push(u);
      await new Promise<void>((res) => { release = res; });
      return json({ voice_id: "v_new", character_id: "sarah", emotion: "angry",
                    name: "Sarah", category: "cloned", lang: "en", origin: "derived" });
    }
    return json(CHARACTER);
  });
  vi.stubGlobal("fetch", f);
  return { derives, finish: () => release?.() };
}

describe("useCharacter.deriveVoice — one click, one mint", () => {
  it("fires ONE request for two same-tick clicks", async () => {
    const { derives, finish } = harness();
    const { result } = renderHook(() => useCharacter("sarah"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      // Both calls before any re-render — exactly what a double-click is.
      void result.current.deriveVoice("angry", null);
      void result.current.deriveVoice("angry", null);
      await Promise.resolve();
    });
    expect(derives).toHaveLength(1);

    await act(async () => { finish(); });
    await waitFor(() => expect(result.current.busySlot).toBeNull());
  });

  it("suppresses the second click rather than failing it", async () => {
    // The gate must not manufacture an error the user has to read: the first
    // click is doing exactly what they asked for.
    const { finish } = harness();
    const { result } = renderHook(() => useCharacter("sarah"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let second: unknown = "unset";
    await act(async () => {
      void result.current.deriveVoice("angry", null);
      second = await result.current.deriveVoice("angry", null);
    });
    expect(second).toBeUndefined();
    await act(async () => { finish(); });
  });

  it("releases the gate so a later derive still works — including after a refusal", async () => {
    // The gate lives in a `finally`; a slot that refused once must not be
    // wedged for the rest of the session.
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
      const u = String(url);
      if (!u.includes("/derive")) return json(CHARACTER);
      calls.push(u);
      return json({ detail: "no emotion basis is available" }, 422);
    }));

    const { result } = renderHook(() => useCharacter("sarah"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    for (const _ of [0, 1]) {
      await act(async () => {
        await result.current.deriveVoice("angry", null).catch(() => {});
      });
    }
    // Two separate user actions, two requests — the refusal is still thrown to
    // the rack, which renders it against the row it belongs to.
    expect(calls).toHaveLength(2);
  });
});
