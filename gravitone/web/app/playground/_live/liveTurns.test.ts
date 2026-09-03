// What the transcript does with the turns the conversation announces.
//
// Both properties here are invisible until partial decode is switched on at the
// service (CONVAI_PARTIAL_DECODE), and then they are the difference between a
// live caption and a transcript that repeats itself.

import { describe, expect, it } from "vitest";
import type { LiveTurn } from "./conversation";
import { floorLabel, toScriptLines, upsertRow, type Row } from "./liveTurns";

const turn = (over: Partial<LiveTurn> = {}): LiveTurn => ({
  id: "u1", role: "user", text: "hello", rate: 16_000, interrupted: false, at: 1, ...over,
});

describe("floorLabel", () => {
  const at = (over: Parameters<typeof floorLabel>[0]) => floorLabel(over);

  it("says the agent is SPEAKING rather than that we are listening", () => {
    // The bug this fixes: for the several seconds the agent is talking, the
    // stage said "listening" — the one thing the call is not doing.
    expect(at({ status: "live", speaking: true, muted: false, hasRows: true }))
      .toBe("agent speaking");
    expect(at({ status: "live", speaking: false, muted: false, hasRows: true }))
      .toBe("listening");
  });

  it("never drops MUTED just because the agent has the floor", () => {
    expect(at({ status: "live", speaking: true, muted: true, hasRows: true }))
      .toBe("muted · agent speaking");
    expect(at({ status: "live", speaking: false, muted: true, hasRows: false }))
      .toBe("muted");
  });

  it("keeps connecting, ended, and the empty stage as they were", () => {
    expect(at({ status: "connecting", speaking: false, muted: false, hasRows: false }))
      .toBe("connecting…");
    expect(at({ status: "ended", speaking: false, muted: false, hasRows: true }))
      .toBe("call ended");
    expect(at({ status: "idle", speaking: false, muted: false, hasRows: false })).toBe("");
  });
});

describe("upsertRow", () => {
  it("appends a turn it has never seen", () => {
    const rows = upsertRow([], turn());
    expect(rows.map((r) => r.id)).toEqual(["u1"]);
  });

  it("replaces the row in place, keeping its position among later turns", () => {
    let rows: Row[] = [];
    rows = upsertRow(rows, turn({ id: "u1", text: "so", interim: true }));
    rows = upsertRow(rows, turn({ id: "a1", role: "agent", text: "Go on." }));
    rows = upsertRow(rows, turn({ id: "u1", text: "so I said no", interim: false }));
    expect(rows.map((r) => r.text)).toEqual(["so I said no", "Go on."]);
    expect(rows).toHaveLength(2);
  });

  it("keeps the audio a banked turn already earned", () => {
    // `url`/`seconds` are written after the take is encoded. A turn re-announced
    // for any reason must not unhook the player the user can already press.
    const banked: Row = { ...turn({ id: "a1", role: "agent", text: "Hi." }), url: "blob:x", seconds: 2 };
    const rows = upsertRow([banked], turn({ id: "a1", role: "agent", text: "Hi." }));
    expect(rows[0]).toMatchObject({ url: "blob:x", seconds: 2 });
  });
});

describe("toScriptLines", () => {
  it("writes agent turns as the dialled Character and yours as the other", () => {
    const rows: Row[] = [
      turn({ id: "u1", text: "Where were you?" }),
      turn({ id: "a1", role: "agent", text: "Out." }),
    ];
    expect(toScriptLines(rows, "nova", "atlas").map((l) => [l.characterId, l.text])).toEqual([
      ["atlas", "Where were you?"],
      ["nova", "Out."],
    ]);
  });

  it("never writes a GUESS into the composer", () => {
    // An interim is what the service thinks it heard; it records none of them.
    // Handing one to the composer would put words in the script that nobody
    // confirmed were said.
    const rows: Row[] = [
      turn({ id: "u1", text: "I think I sai", interim: true }),
      turn({ id: "a1", role: "agent", text: "Sorry?" }),
    ];
    expect(toScriptLines(rows, "nova", "atlas").map((l) => l.text)).toEqual(["Sorry?"]);
  });
});
