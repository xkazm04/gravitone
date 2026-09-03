// The panel that turns "close, but..." into a link instead of an email.
//
// Two things must hold on a page whose whole audience is a client with no
// account: the new round's link is REACHABLE (a mint the reviewer cannot see is
// a mint that did not happen), and a failed request never leaves the button
// spinning on a request that is not coming back.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const { requestRevision } = vi.hoisted(() => ({ requestRevision: vi.fn() }));
vi.mock("./actions", () => ({ requestRevision }));

import ReviewRevisionRequest from "./ReviewRevisionRequest";

function panel(reviewer = "Dana") {
  const setReviewer = vi.fn();
  const view = render(
    <ReviewRevisionRequest reviewId="rev1" reviewer={reviewer} setReviewer={setReviewer} />,
  );
  return { ...view, setReviewer };
}

const ask = () => screen.getByRole("button", { name: /ask for a revision/ });
const noteBox = () => screen.getByPlaceholderText(/What should change/);

afterEach(() => { vi.clearAllMocks(); });

describe("ReviewRevisionRequest — opening the next round", () => {
  it("sends the note and direction, then shows the new link", async () => {
    requestRevision.mockResolvedValue({ ok: true, reviewId: "rev2", round: 2 });
    panel();

    fireEvent.change(noteBox(), { target: { value: "warmer on the last line" } });
    fireEvent.change(screen.getByPlaceholderText(/Direction/), { target: { value: "line 3: angry" } });
    fireEvent.click(ask());

    await waitFor(() => expect(screen.getByText(/round 2 opened/i)).toBeInTheDocument());
    expect(requestRevision).toHaveBeenCalledWith("rev1", {
      note: "warmer on the last line", reviewer: "Dana", direction: "line 3: angry",
    });
    // The link is the whole product of this action — it must be there to send on.
    expect(screen.getByRole("link", { name: /\/r\/rev2/ })).toHaveAttribute("href", "/r/rev2");
  });

  it("will not ask for a revision that says nothing", () => {
    panel();
    expect(ask()).toBeDisabled();
    fireEvent.click(ask());
    expect(requestRevision).not.toHaveBeenCalled();
  });

  it("gates a double-click to ONE round — a duplicate here mints a second link", async () => {
    let release: (v: unknown) => void = () => {};
    requestRevision.mockImplementation(() => new Promise((r) => { release = r; }));
    panel();
    fireEvent.change(noteBox(), { target: { value: "warmer" } });

    const btn = ask(); // same node; its label becomes "opening…"
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(btn).toBeDisabled();
    release({ ok: true, reviewId: "rev2", round: 2 });

    await waitFor(() => expect(screen.getByText(/round 2 opened/i)).toBeInTheDocument());
    expect(requestRevision).toHaveBeenCalledTimes(1);
  });
});

describe("ReviewRevisionRequest — when it does not open", () => {
  it("shows the backend's reason and offers the button again", async () => {
    requestRevision.mockResolvedValue({ ok: false, error: "this review has no decision to revise" });
    panel();
    fireEvent.change(noteBox(), { target: { value: "warmer" } });
    fireEvent.click(ask());

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("this review has no decision to revise");
    expect(banner.className).toMatch(/rose/);
    expect(ask()).toBeEnabled();
    // no link was minted, so none is offered
    expect(screen.queryByRole("link", { name: /\/r\// })).toBeNull();
    // ...and the note is still in the box, not silently discarded
    expect(noteBox()).toHaveValue("warmer");
  });

  it("says nothing was sent when the action itself never reached the server", async () => {
    requestRevision.mockRejectedValue(new Error("network"));
    panel();
    fireEvent.change(noteBox(), { target: { value: "warmer" } });
    fireEvent.click(ask());

    expect(await screen.findByRole("alert")).toHaveTextContent(/nothing was sent/i);
    expect(ask()).toBeEnabled();
  });
});
