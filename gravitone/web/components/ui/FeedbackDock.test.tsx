// The dock's contract has two halves. It must be INVISIBLE wherever it would be
// dishonest — signed out, no Firebase, inside someone else's embedded player —
// and when it does send, it must send the token and never a uid, and it must
// SAY when the send failed rather than pretending it landed.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Firebase never initializes in a test run (no config); getAuth would throw at
// import time. Same shim as the other component tests here.
vi.mock("@/lib/firebase", () => ({
  db: {}, auth: {}, googleProvider: {}, firebaseReady: false,
}));

const { authState, pathname } = vi.hoisted(() => ({
  authState: { current: {} as Record<string, unknown> },
  pathname: { current: "/voices" },
}));

vi.mock("@/lib/useAuth", () => ({ useAuth: () => authState.current }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.current }));

import FeedbackDock from "./FeedbackDock";

const signedIn = (getIdToken = vi.fn().mockResolvedValue("tok")) => ({
  ready: true,
  user: { uid: "u1", getIdToken },
});

beforeEach(() => {
  pathname.current = "/voices";
  authState.current = signedIn();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("when it must not appear", () => {
  it("renders nothing for a signed-out visitor", () => {
    authState.current = { ready: true, user: null };
    const { container } = render(<FeedbackDock />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing on a deployment without Firebase", () => {
    authState.current = { ready: false, user: null };
    const { container } = render(<FeedbackDock />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing inside an embedded player", () => {
    pathname.current = "/t/abc/embed";
    const { container } = render(<FeedbackDock />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("sending", () => {
  it("posts the token and the route — and no uid", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, id: "d1" }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<FeedbackDock />);
    fireEvent.click(screen.getByRole("button", { name: /feedback/i }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  the picker lags  " } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send" })); });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body).toEqual({ idToken: "tok", message: "the picker lags", route: "/voices" });
    expect(body).not.toHaveProperty("uid");
    await screen.findByText(/filed/i);
  });

  it("will not send an empty note", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<FeedbackDock />);
    fireEvent.click(screen.getByRole("button", { name: /feedback/i }));
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names a refusal and KEEPS the text, so a retry is one click", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: "this deployment is not accepting feedback" }), { status: 503 }),
    ));
    render(<FeedbackDock />);
    fireEvent.click(screen.getByRole("button", { name: /feedback/i }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "hello" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send" })); });

    expect(await screen.findByRole("alert")).toHaveTextContent(/not accepting feedback/i);
    expect(screen.getByRole("textbox")).toHaveValue("hello");
  });
});
