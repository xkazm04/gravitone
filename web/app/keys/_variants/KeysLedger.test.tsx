// First tests for the keys surface. The backend's test_keys.py covers
// revoke-while-listed and unrotatable-after-revoke; none of that was visible in
// the studio, where the two kill actions differ only in which request they send
// and what they leave on screen.
//
// Harness shape follows PlaygroundConsole.test.tsx: the real component, the
// real hook, `fetch` stubbed at the /api boundary — the seam the ledger already
// has. Nothing was refactored to make it testable, and every assertion below is
// about what a user sees or what the service receives.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import KeysLedger from "./KeysLedger";
import type { ApiKey } from "./data";

function key(over: Partial<ApiKey> = {}): ApiKey {
  return {
    id: "k_1", name: "Mobile app", prefix: "gk_abc123", scopes: ["tts"],
    created: "2026-01-01T00:00:00Z", last_used: null, revoked: false, ...over,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}

type Route = { list?: () => Response; onCall?: (url: string, method: string) => Response | undefined };

/** Route by (url, method) exactly as the browser would. Calls are recorded so a
 *  test can assert which endpoint a button actually hit. */
function stubFetch(routes: Route) {
  const calls: { url: string; method: string }[] = [];
  const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method });
    const custom = routes.onCall?.(url, method);
    if (custom) return custom;
    if (url === "/api/keys" && method === "GET") return routes.list?.() ?? json([]);
    return json({});
  });
  vi.stubGlobal("fetch", f);
  return calls;
}

const clipboard = { writeText: vi.fn(async () => {}) };

beforeEach(() => {
  clipboard.writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Render and let the initial key load settle. */
async function mount(routes: Route) {
  const calls = stubFetch(routes);
  await act(async () => { render(<KeysLedger />); });
  return calls;
}

function row(name: string): HTMLElement {
  return screen.getByText((_t, el) => el?.tagName === "TR" && !!el.textContent?.includes(name))
    .closest("tr") as HTMLElement;
}

async function click(el: HTMLElement) {
  await act(async () => { fireEvent.click(el); });
}

// ── revoke vs destroy ────────────────────────────────────────────────────────
describe("KeysLedger — the two kill actions are not the same action", () => {
  it("revoke POSTs /revoke and leaves the key LISTED, struck through and marked", async () => {
    let revoked = false;
    const calls = await mount({
      list: () => json([key({ revoked })]),
      onCall: (url, method) => {
        if (url.endsWith("/revoke") && method === "POST") { revoked = true; return json({}); }
        return undefined;
      },
    });

    await click(screen.getByRole("button", { name: /^revoke$/ }));

    expect(calls.some((c) => c.url === "/api/keys/k_1/revoke" && c.method === "POST")).toBe(true);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    // Still on screen — keeping it auditable is the whole point of revoke.
    const tr = row("Mobile app");
    expect(within(tr).getByText("revoked")).toBeInTheDocument();
    expect(tr.querySelector("s")?.textContent).toBe("Mobile app");
  });

  it("destroy DELETEs and removes the row", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let gone = false;
    const calls = await mount({
      list: () => json(gone ? [] : [key()]),
      onCall: (url, method) => {
        if (method === "DELETE") { gone = true; return new Response(null, { status: 204 }); }
        return undefined;
      },
    });

    await click(screen.getByRole("button", { name: /^destroy$/ }));

    expect(calls.some((c) => c.url === "/api/keys/k_1" && c.method === "DELETE")).toBe(true);
    await waitFor(() => expect(screen.queryByText("Mobile app")).not.toBeInTheDocument());
  });

  it("destroy asks first, and a cancelled confirm sends nothing", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const calls = await mount({ list: () => json([key()]) });

    await click(screen.getByRole("button", { name: /^destroy$/ }));

    expect(confirm).toHaveBeenCalled();
    // and it names the alternative, so the destructive click is an informed one
    expect(String(confirm.mock.calls[0][0])).toMatch(/revoke/i);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(screen.getByText("Mobile app")).toBeInTheDocument();
  });

  it("hides revoke on an already-revoked key but keeps rotate reachable", async () => {
    // The backend answers 409 "cannot rotate a revoked key"; that answer is
    // only reachable if the studio still lets the click happen.
    await mount({ list: () => json([key({ revoked: true })]) });
    expect(screen.queryByRole("button", { name: /^revoke$/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^rotate$/ })).toBeEnabled();
  });

  it("disables EVERY rotate button while one rotation is in flight", async () => {
    // The handler already refused a concurrent rotation, silently: the other
    // row's button looked live and did nothing when clicked.
    let release!: () => void;
    const pending = new Promise<void>((r) => { release = r; });
    await mount({
      list: () => json([key(), key({ id: "k_2", name: "CI" })]),
      onCall: (url, method) => {
        if (url === "/api/keys/k_1" && method === "POST") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return pending.then(() => json({ ...key(), secret: "s" })) as any;
        }
        return undefined;
      },
    });

    const [first, second] = screen.getAllByRole("button", { name: /^rotat/ });
    await click(first);
    expect(second).toBeDisabled();
    await act(async () => { release(); });
  });

  it("surfaces the backend's 409 detail when rotating a revoked key", async () => {
    await mount({
      list: () => json([key({ revoked: true })]),
      onCall: (url, method) =>
        url === "/api/keys/k_1" && method === "POST"
          ? json({ detail: "cannot rotate a revoked key" }, 409)
          : undefined,
    });
    await click(screen.getByRole("button", { name: /^rotate$/ }));
    expect(await screen.findByText(/cannot rotate a revoked key/)).toBeInTheDocument();
  });
});

// ── rollback copy tells the true state ───────────────────────────────────────
describe("KeysLedger — a failed kill says what is still true", () => {
  it("restores the LIVE row and says the key is still active when revoke fails", async () => {
    await mount({
      list: () => json([key()]),
      onCall: (url) => (url.endsWith("/revoke") ? json({ detail: "nope" }, 500) : undefined),
    });

    await click(screen.getByRole("button", { name: /^revoke$/ }));

    expect(await screen.findByText(/the key is still active/)).toBeInTheDocument();
    const tr = row("Mobile app");
    expect(within(tr).queryByText("revoked")).not.toBeInTheDocument();
    expect(tr.querySelector("s")).toBeNull();
  });

  it("restores the row and says the key still exists when destroy fails", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await mount({
      list: () => json([key()]),
      onCall: (_url, method) => (method === "DELETE" ? json({ detail: "nope" }, 500) : undefined),
    });

    await click(screen.getByRole("button", { name: /^destroy$/ }));

    expect(await screen.findByText(/the key still exists/)).toBeInTheDocument();
    expect(screen.getByText("Mobile app")).toBeInTheDocument();
  });
});

// ── honest empty state ───────────────────────────────────────────────────────
describe("KeysLedger — an empty table is not a claim about the account", () => {
  it("never says 'No keys yet' when the load failed", async () => {
    await mount({ list: () => json({ detail: "Gravitone backend unreachable" }, 503) });
    expect(screen.getByRole("alert")).toHaveTextContent(/unreachable/i);
    expect(screen.queryByText(/No keys yet/)).not.toBeInTheDocument();
    expect(screen.getByText(/not because you have no keys/)).toBeInTheDocument();
  });

  it("does say 'No keys yet' when the account really has none", async () => {
    await mount({ list: () => json([]) });
    expect(screen.getByText(/No keys yet/)).toBeInTheDocument();
  });
});

// ── enforcement posture ──────────────────────────────────────────────────────
describe("KeysLedger — it never implies the deployment is secured", () => {
  it("admits it cannot tell when the list loads", async () => {
    await mount({ list: () => json([key()]) });
    expect(screen.getByText(/can't tell from here/i)).toBeInTheDocument();
    expect(screen.getByText(/enforce nothing/i)).toBeInTheDocument();
  });

  it("states enforcement is ON only when the backend actually rejected it (401)", async () => {
    await mount({ list: () => json({ detail: "invalid or missing API key" }, 401) });
    expect(screen.getByText(/Key enforcement is/)).toBeInTheDocument();
    expect(screen.getByText("ON")).toBeInTheDocument();
  });

  it("claims no posture at all for a backend that never answered", async () => {
    await mount({ list: () => json({ detail: "backend unreachable" }, 503) });
    expect(screen.queryByText(/Key enforcement/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/can't tell from here/i)).not.toBeInTheDocument();
  });
});

// ── the reveal modal ─────────────────────────────────────────────────────────
describe("SecretReveal — the one screen where losing the text is unrecoverable", () => {
  async function createAKey() {
    const routes: Route = {
      list: () => json([]),
      onCall: (url, method) =>
        url === "/api/keys" && method === "POST"
          ? json({ ...key({ id: "k_new", name: "CI" }), secret: "gk_live_TOPSECRET" })
          : undefined,
    };
    await mount(routes);
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(/Key name/), { target: { value: "CI" } });
    });
    await click(screen.getByRole("button", { name: /Create key/ }));
    return await screen.findByRole("dialog");
  }

  it("shows the full secret once the key is created", async () => {
    const dialog = await createAKey();
    expect(within(dialog).getByText("gk_live_TOPSECRET")).toBeInTheDocument();
  });

  it("says 'copied' only when the clipboard accepted it", async () => {
    const dialog = await createAKey();
    await click(within(dialog).getByRole("button", { name: /^copy$/ }));
    expect(clipboard.writeText).toHaveBeenCalledWith("gk_live_TOPSECRET");
    expect(await within(dialog).findByText(/copied/)).toBeInTheDocument();
  });

  it("says the copy was BLOCKED when the clipboard refuses — never 'copied'", async () => {
    clipboard.writeText = vi.fn(async () => { throw new Error("denied"); });
    const dialog = await createAKey();
    await click(within(dialog).getByRole("button", { name: /^copy$/ }));
    expect(await within(dialog).findByText(/copy blocked/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/✓ copied/)).not.toBeInTheDocument();
  });

  it("does NOT dismiss on a backdrop click — the secret is unrecoverable", async () => {
    const dialog = await createAKey();
    const backdrop = dialog.parentElement as HTMLElement;
    await click(backdrop);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("gk_live_TOPSECRET")).toBeInTheDocument();
  });

  it("names the path its compatibility check verified, and what that misses", async () => {
    const dialog = await createAKey();
    await click(within(dialog).getByRole("button", { name: /compatibility check/i }));
    expect(await within(dialog).findByText(/server-to-server/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/does not prove a/i)).toBeInTheDocument();
  });

  it("shows a FAILED check in rose, carrying the backend's own message", async () => {
    const dialog = await createAKey();
    // /api/tts answers the studio's proxy contract: {detail} + a real status.
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ detail: "voice 'alba' is not installed" }),
        { status: 404, headers: { "Content-Type": "application/json" } })));

    await click(within(dialog).getByRole("button", { name: /compatibility check/i }));

    const fail = await within(dialog).findByText(/voice 'alba' is not installed/);
    expect(fail.className).toContain("rose"); // amber is reserved for caveats
  });

  it("warns that the javascript snippet takes a path the check never tried", async () => {
    const dialog = await createAKey();
    await click(within(dialog).getByRole("button", { name: "javascript" }));
    const warning = within(dialog).getByText(/never exercised that path/i);
    expect(warning).toBeInTheDocument();
    expect(warning.className).toContain("amber"); // a caveat, not a failure
  });

  it("dismisses on the explicit button", async () => {
    const dialog = await createAKey();
    await click(within(dialog).getByRole("button", { name: /saved it/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("dismisses on Escape — leaving is deliberate, not accidental", async () => {
    await createAKey();
    await act(async () => { fireEvent.keyDown(window, { key: "Escape" }); });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
