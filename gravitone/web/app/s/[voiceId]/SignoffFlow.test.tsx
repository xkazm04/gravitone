// The /s route is reachable only with BOTH halves of the link. These tests pin
// the gate, because getting it wrong turns a consent page into a way to browse
// someone else's vault by guessing voice ids.

import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Firebase never initializes in a test run (no config) — getAuth throws on an
// absent API key, which would fail this file at import time. The vault's pure
// helpers and its firebaseReady short-circuits are what is under test here.
vi.mock("@/lib/firebase", () => ({
  db: {}, auth: {}, googleProvider: {}, firebaseReady: false,
}));

// vi.hoisted: the mock factories below are lifted above these declarations.
const { loadVaultEntry, grantSignoff, declineSignoff, signIn } = vi.hoisted(() => ({
  loadVaultEntry: vi.fn(), grantSignoff: vi.fn(), declineSignoff: vi.fn(), signIn: vi.fn(),
}));
const user = { uid: "spk", email: "s@example.com" } as { uid: string; email: string | null } | null;
const auth = vi.hoisted(() => ({ current: null as { uid: string; email: string | null } | null }));

vi.mock("@/lib/useAuth", () => ({
  useAuth: () => ({
    user: auth.current, profile: null, loading: false, ready: true, authResolved: true,
    signIn, signOut: vi.fn(), updateProfile: vi.fn(), error: null,
  }),
}));
vi.mock("@/app/voices/_variants/data", () => ({
  useVoicePreview: () => ({
    preview: vi.fn(), playingId: null, busyId: null, failedId: null, failedReason: null,
  }),
  relTime: () => "just now",
}));
vi.mock("@/lib/voiceVault", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/voiceVault")>()),
  loadVaultEntry, grantSignoff, declineSignoff,
}));

import SignoffFlow from "./SignoffFlow";
import type { VaultEntry } from "@/lib/voiceVault";

const entry = (token: string): VaultEntry => ({
  voice_id: "v1", character_id: "c1", character_name: "Nova", emotion: "calm",
  created: "2026-07-01T00:00:00.000Z", revoked: false,
  consent: {
    method: "uploaded", statement: "uploaded with consent",
    attestedBy: "owner", attestedEmail: "owner@example.com",
    signoff: { status: "pending", token, phrase: "My voice, my choice: amber willow 412." },
  },
});

beforeEach(() => {
  auth.current = user;
  loadVaultEntry.mockReset().mockResolvedValue(entry("goodtoken"));
});

describe("token-gated access", () => {
  it("opens the grant form when the voice id AND the token both check out", async () => {
    render(<SignoffFlow voiceId="v1" ownerUid="owner" token="goodtoken" />);
    expect(await screen.findByText(/Nova · calm/)).toBeInTheDocument();
    expect(screen.getByText(/My voice, my choice/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /this is my voice/i })).toBeInTheDocument();
  });

  it("reveals NOTHING when the token is wrong — the voice id alone is not a key", async () => {
    render(<SignoffFlow voiceId="v1" ownerUid="owner" token="guessed" />);
    expect(await screen.findByText(/link is not valid/i)).toBeInTheDocument();
    expect(screen.queryByText(/Nova · calm/)).toBeNull();
    expect(screen.queryByText(/owner@example.com/)).toBeNull();
    expect(screen.queryByText(/My voice, my choice/)).toBeNull();
  });

  it("refuses an incomplete link without ever touching the vault", async () => {
    render(<SignoffFlow voiceId="v1" ownerUid={null} token={null} />);
    expect(await screen.findByText(/link is incomplete/i)).toBeInTheDocument();
    expect(loadVaultEntry).not.toHaveBeenCalled();
  });

  it("asks a stranger to sign in first, and reads nothing until they do", async () => {
    auth.current = null;
    render(<SignoffFlow voiceId="v1" ownerUid="owner" token="goodtoken" />);
    expect(await screen.findByRole("button", { name: /sign in with google/i })).toBeInTheDocument();
    expect(loadVaultEntry).not.toHaveBeenCalled();
    expect(screen.queryByText(/Nova · calm/)).toBeNull();
  });

  it("says the request is unreadable rather than pretending the link is fake", async () => {
    loadVaultEntry.mockRejectedValue(new Error("permission-denied"));
    render(<SignoffFlow voiceId="v1" ownerUid="owner" token="goodtoken" />);
    expect(await screen.findByText(/could not be read/i)).toBeInTheDocument();
    expect(screen.queryByText(/link is not valid/i)).toBeNull();
  });

  it("does not offer to grant a consent that was already withdrawn", async () => {
    const e = entry("goodtoken");
    e.consent.signoff = { ...e.consent.signoff!, status: "signed", withdrawnAt: "2026-07-20T00:00:00.000Z" };
    loadVaultEntry.mockResolvedValue(e);
    render(<SignoffFlow voiceId="v1" ownerUid="owner" token="goodtoken" />);
    expect(await screen.findByText(/no longer open/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /this is my voice/i })).toBeNull();
  });
});

describe("granting", () => {
  it("cannot be submitted before the phrase is read (or the mic is declared broken)", async () => {
    render(<SignoffFlow voiceId="v1" ownerUid="owner" token="goodtoken" />);
    const sign = await screen.findByRole("button", { name: /this is my voice/i });
    expect(sign).toBeDisabled();
  });

  it("surfaces a failed write as NOT granted, never as a success", async () => {
    grantSignoff.mockRejectedValue(new Error("offline"));
    render(<SignoffFlow voiceId="v1" ownerUid="owner" token="goodtoken" />);
    await screen.findByRole("button", { name: /this is my voice/i });
    // declare the mic broken so the button unlocks without a MediaRecorder
    const box = await screen.findByRole("checkbox");
    await act(async () => { box.click(); });
    const sign = await screen.findByRole("button", { name: /this is my voice/i });
    await act(async () => { sign.click(); });
    await waitFor(() => expect(screen.getByText(/NOT recorded/)).toBeInTheDocument());
    expect(screen.queryByText(/^Signed\.$/)).toBeNull();
  });
});
