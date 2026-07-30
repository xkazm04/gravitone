// What the Audition Room DECIDES — the part that changes which audio gets cloned.
//
// These pin user-visible promises: a comparison is blind and fair (the incumbent
// does not sit on the same side every round), a vote carries forward, and a
// commit only ever claims a take the backend actually offered.
import { describe, expect, it } from "vitest";
import {
  candidates, commitRecipes, defaultRecipe, recipeById, startLadder, vote,
} from "./audition";
import type { Recipe, Stem } from "./machine";

function recipe(id: string, over: Partial<Recipe> = {}): Recipe {
  return { id, label: id, how: `how ${id}`, seconds: 10, segments: 3, ...over };
}

function stem(over: Partial<Stem> = {}): Stem {
  return { emotion: "happy", seconds: 10, segments: 3, eligible: true, cues: [], ...over };
}

const FULL = recipe("full", { default: true });
const LONG = recipe("longest");
const TIGHT = recipe("tightest");

describe("candidates", () => {
  it("offers nothing when there is no real choice", () => {
    expect(candidates(stem())).toEqual([]);                       // absent
    expect(candidates(stem({ recipes: [FULL] }))).toEqual([]);    // one take
  });

  it("offers every take once there are two or more", () => {
    expect(candidates(stem({ recipes: [FULL, LONG] })).map((r) => r.id))
      .toEqual(["full", "longest"]);
  });

  it("knows the default take and can look one up by id", () => {
    const s = stem({ recipes: [FULL, LONG] });
    expect(defaultRecipe(s)?.id).toBe("full");
    expect(recipeById(s, "longest")?.id).toBe("longest");
    expect(recipeById(s, "nope")).toBeNull();
    expect(recipeById(s, undefined)).toBeNull();
  });
});

describe("the blind ladder", () => {
  it("pairs the default against the first challenger", () => {
    const l = startLadder([FULL, LONG]);
    expect(l.done).toBe(false);
    expect([l.x?.id, l.y?.id]).toEqual(["full", "longest"]);
  });

  it("ends immediately when there is nothing to compare", () => {
    expect(startLadder([FULL]).done).toBe(true);
    expect(startLadder([]).winner).toBeNull();
  });

  it("carries the winner forward and swaps sides so a side-clicker cannot win by habit", () => {
    const round1 = startLadder([FULL, LONG, TIGHT]);
    const round2 = vote(round1, "y");                  // the challenger wins
    expect(round2.done).toBe(false);
    expect(round2.lastPick?.id).toBe("longest");
    // Round 2 is odd, so the incumbent moves to Y and the challenger takes X.
    expect(round2.x?.id).toBe("tightest");
    expect(round2.y?.id).toBe("longest");
  });

  it("finishes with the take the ear kept choosing", () => {
    let l = startLadder([FULL, LONG, TIGHT]);
    l = vote(l, "y");            // longest beats full
    l = vote(l, "y");            // longest beats tightest (it is on Y now)
    expect(l.done).toBe(true);
    expect(l.winner?.id).toBe("longest");
    expect(l.queue).toEqual([]);
  });

  it("ignores a vote once it is over, and a vote on an empty side", () => {
    const done = vote(vote(startLadder([FULL, LONG]), "x"), "x");
    expect(done.winner?.id).toBe("full");
    expect(vote(done, "y")).toBe(done);
  });
});

describe("commitRecipes", () => {
  const stems = [
    stem({ emotion: "happy", recipes: [FULL, LONG] }),
    stem({ emotion: "sad", recipes: [FULL, TIGHT] }),
  ];

  it("sends nothing at all when nobody auditioned anything", () => {
    expect(commitRecipes({}, new Set(["happy", "sad"]), stems)).toBeUndefined();
  });

  it("sends only the emotions whose winner is not the default", () => {
    expect(commitRecipes({ happy: "longest", sad: "full" },
      new Set(["happy", "sad"]), stems)).toEqual({ happy: "longest" });
  });

  it("never claims a take for a descoped emotion", () => {
    expect(commitRecipes({ sad: "tightest" }, new Set(["happy"]), stems)).toBeUndefined();
  });

  it("drops a take the backend no longer offers rather than having it refused", () => {
    expect(commitRecipes({ happy: "tightest" }, new Set(["happy"]), stems)).toBeUndefined();
  });
});
