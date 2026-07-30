// The owner's side of sign-off. Two things must not break: a vault written
// before this feature existed renders exactly as it did, and a withdrawn
// consent lands as "action required" wired to the real delete + revoke path.

import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Firebase never initializes in a test run (no config) — getAuth throws on an
// absent API key, which would fail this file at import time. The vault's pure
// helpers and its firebaseReady short-circuits are what is under test here.
vi.mock("@/lib/firebase", () => ({
  db: {}, auth: {}, googleProvider: {}, firebaseReady: false,
}));

// vi.hoisted: the mock factories below are lifted above these declarations.
const { listVault, markRevoked, requestSignoff, preview } = vi.hoisted(() => ({
  listVault: vi.fn(), markRevoked: vi.fn(), requestSignoff: vi.fn(), preview: vi.fn(),
}));

vi.mock("@/app/voices/_variants/data", () => ({
  useVoicePreview: () => ({ preview, playingId: null, busyId: null }),
  relTime: () => "just now",
}));
vi.mock("@/lib/voiceVault", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/voiceVault")>()),
  listVault, markRevoked, requestSignoff,
}));

import MyVoices from "./MyVoices";
import type { Signoff, VaultEntry } from "@/lib/voiceVault";

const row = (over: Partial<VaultEntry> = {}, signoff?: Signoff): VaultEntry => ({
  voice_id: "v1", character_id: "c1", character_name: "Nova", emotion: "calm",
  created: "2026-07-01T00:00:00.000Z", revoked: false,
  consent: {
    method: "uploaded", statement: "uploaded with consent",
    attestedBy: "owner", attestedEmail: "owner@example.com",
    ...(signoff ? { signoff } : {}),
  },
  ...over,
});

beforeEach(() => {
  listVault.mockReset().mockResolvedValue([row()]);
  markRevoked.mockReset().mockResolvedValue(true);
  requestSignoff.mockReset().mockResolvedValue({ status: "pending", token: "t", phrase: "p" });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("legacy vault entries render unchanged", () => {
  it("shows no badge, stays playable, and offers the sign-off upgrade", async () => {
    render(<MyVoices uid="owner" />);
    expect(await screen.findByText(/Nova · calm/)).toBeInTheDocument();
    expect(screen.queryByText(/speaker-signed/)).toBeNull();
    expect(screen.queryByText(/pending/)).toBeNull();
    expect(screen.getByRole("button", { name: /Play Nova calm/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^revoke$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /request sign-off/i })).toBeInTheDocument();
  });
});

describe("sign-off badges", () => {
  it("earns the strong badge only when a speaker actually signed", async () => {
    listVault.mockResolvedValue([row({}, {
      status: "signed", token: "t", phrase: "p", speakerUid: "spk",
      speakerEmail: "s@example.com", signedAt: "2026-07-02T00:00:00.000Z",
      scope: { purpose: "narration", expiresAt: "2099-01-01" },
    })]);
    render(<MyVoices uid="owner" />);
    expect(await screen.findByText("speaker-signed")).toBeInTheDocument();
    expect(screen.getByText(/signed by s@example.com/)).toBeInTheDocument();
    expect(screen.getByText(/scope: narration/)).toBeInTheDocument();
    // an active grant is not an "ask again" state
    expect(screen.queryByRole("button", { name: /request sign-off/i })).toBeNull();
  });

  it("shows the phrase and a copyable invite while a request is pending", async () => {
    listVault.mockResolvedValue([row({}, {
      status: "pending", token: "tok123", phrase: "My voice, my choice: amber willow 412.",
    })]);
    render(<MyVoices uid="owner" />);
    expect(await screen.findByText("sign-off pending")).toBeInTheDocument();
    expect(screen.getByText(/My voice, my choice/)).toBeInTheDocument();
    expect(screen.getByText(/\/s\/v1\?o=owner&k=tok123/)).toBeInTheDocument();
    expect(screen.getByText(/No email is sent/)).toBeInTheDocument();
  });
});

describe("withdrawn consent → the existing revoke path", () => {
  const withdrawn = () => [row({}, {
    status: "signed", token: "t", phrase: "p", speakerUid: "spk", speakerEmail: "s@example.com",
    signedAt: "2026-07-02T00:00:00.000Z", withdrawnAt: "2026-07-20T00:00:00.000Z",
  })];

  it("renders exactly like a revoked row — struck through and unplayable", async () => {
    listVault.mockResolvedValue(withdrawn());
    render(<MyVoices uid="owner" />);
    const strike = await screen.findByText("Nova · calm");
    expect(strike.tagName).toBe("S");
    expect(screen.getByRole("button", { name: /Play Nova calm/i })).toBeDisabled();
    expect(screen.getByText("consent withdrawn — action required")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /delete voice/i })).toBeInTheDocument();
  });

  it("deletes the engine voice and marks the vault entry revoked", async () => {
    listVault.mockResolvedValue(withdrawn());
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", () => true);
    render(<MyVoices uid="owner" />);
    const del = await screen.findByRole("button", { name: /delete voice/i });
    await act(async () => { del.click(); });
    await waitFor(() => expect(markRevoked).toHaveBeenCalledWith("owner", "v1"));
    expect(fetchMock).toHaveBeenCalledWith("/api/voices/v1", { method: "DELETE" });
  });

  it("says the voice is still usable when the engine delete fails", async () => {
    listVault.mockResolvedValue(withdrawn());
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    vi.stubGlobal("confirm", () => true);
    render(<MyVoices uid="owner" />);
    const del = await screen.findByRole("button", { name: /delete voice/i });
    await act(async () => { del.click(); });
    await waitFor(() => expect(screen.getByText(/still usable/)).toBeInTheDocument());
    expect(markRevoked).not.toHaveBeenCalled();
  });
});
