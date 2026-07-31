import { describe, expect, it } from "vitest";
import { deleteTake, getRecentTakes, putTake } from "./takeStore";
import { DEFAULT_EXPRESSION, type Take } from "@/app/playground/_variants/shared";

const take: Take = {
  id: "take-1", text: "hi", characterId: "sarah", characterName: "Sarah",
  mode: "gravitone", peaks: [], seconds: 1, kb: 1, rtf: 1,
  synthSeconds: 0, queueSeconds: 0, ignoredSettings: [], segments: [],
  expr: DEFAULT_EXPRESSION, createdAt: 1,
};

// jsdom has no IndexedDB, which is exactly the shape of a browser with storage
// blocked (private mode, quota exhausted, storage disabled).
describe("takeStore with storage unavailable", () => {
  it("tells the caller the take was NOT saved", async () => {
    // This used to be swallowed, which made the console's "this take could not
    // be saved for after a refresh" banner unreachable — the log promises
    // durability, so a broken promise has to be sayable.
    await expect(putTake(take, null)).rejects.toThrow(/IndexedDB unavailable/);
  });

  it("distinguishes 'could not be read' from 'no takes yet'", async () => {
    // Returning [] here rendered a false empty state: a whole restored session
    // looked like a brand-new one.
    await expect(getRecentTakes()).rejects.toThrow(/IndexedDB unavailable/);
  });

  it("keeps deletion best-effort — the take is already gone from the log", async () => {
    await expect(deleteTake("take-1")).resolves.toBeUndefined();
  });
});
