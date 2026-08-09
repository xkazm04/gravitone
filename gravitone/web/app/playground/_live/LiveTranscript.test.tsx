// The transcript's two honesty properties: a guess is labelled as one, and a
// visitor who asked for less motion gets the WHOLE conversation, already in
// place — DESIGN.md's "gate the animation, never drop the element".

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import LiveTranscript from "./LiveTranscript";
import type { Row } from "./liveTurns";

const row = (over: Partial<Row> = {}): Row => ({
  id: "u1", role: "user", text: "Where were you?", rate: 16_000,
  interrupted: false, at: 1, ...over,
});

const ROWS: Row[] = [row(), row({ id: "a1", role: "agent", text: "Out." })];

function mount(props: Partial<React.ComponentProps<typeof LiveTranscript>> = {}) {
  return render(
    <LiveTranscript rows={ROWS} charId="nova" characterName="Nova" live={false}
      onHandOff={props.onHandOff ?? vi.fn()} onClear={props.onClear ?? vi.fn()} {...props} />,
  );
}

describe("LiveTranscript", () => {
  it("renders every turn, stilled — no row is animated out of existence", () => {
    const { container } = mount({ still: true });
    expect(screen.getByText("Where were you?")).toBeInTheDocument();
    expect(screen.getByText("Out.")).toBeInTheDocument();
    expect(container.querySelector('[data-motion="still"]')).not.toBeNull();
    // The stilled render is the END of the entrance: fully opaque, in position.
    const card = screen.getByText("Out.").parentElement!;
    expect(card.style.opacity === "" || card.style.opacity === "1").toBe(true);
    expect(card.style.transform ?? "").not.toContain("translateY(-8px)");
  });

  it("keeps the entrance when motion is allowed — the same rows, animated", () => {
    const { container } = mount({ still: false });
    expect(container.querySelector('[data-motion="entrance"]')).not.toBeNull();
    expect(screen.getByText("Out.")).toBeInTheDocument();
  });

  it("marks an unconfirmed transcript as a guess", () => {
    mount({ rows: [row({ text: "I think I sai", interim: true })], still: true });
    expect(screen.getByText("hearing…")).toBeInTheDocument();
  });

  it("refuses to clear a transcript while the call is still up", () => {
    mount({ live: true });
    expect(screen.getByRole("button", { name: /clear/i })).toBeDisabled();
  });
});
