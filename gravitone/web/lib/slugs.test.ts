// The web half of the slug drift guard.
//
// lib/slugs.ts exists so the studio stops promising a slug the service will
// reject. That only holds while the two sides agree, and the previous three
// copies of these rules are exactly how they stopped agreeing. So: read the
// patterns out of the Python source and fail when either side moves — the same
// shape as lib/serviceHeaders.test.ts.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CHARACTER_SEPARATOR_PATTERN, EMOTION_PATTERN, EMOTION_RULE,
  EMOTION_SEPARATOR_PATTERN, characterSlug, checkEmotion, emotionSlug,
} from "./slugs";

/** vitest runs with the web app as its root; the service lives beside it. */
function servicePy(name: string): string {
  // A missing service checkout must NOT silently pass: the guard would be gone
  // exactly when it is most needed.
  return readFileSync(resolve(process.cwd(), `../service/${name}`), "utf8");
}

function capture(source: string, re: RegExp, what: string): string {
  const m = re.exec(source);
  expect(m, `${what} not found — the guard cannot see the rule it protects`).toBeTruthy();
  return m![1];
}

describe("slug drift between the service and the studio", () => {
  it("uses service/emotions.py::_EMOTION_RE verbatim", () => {
    const python = capture(
      servicePy("emotions.py"),
      /_EMOTION_RE\s*=\s*re\.compile\(r"([^"]+)"\)/,
      "_EMOTION_RE",
    );
    expect(python, "emotions.py changed the emotion grammar — update EMOTION_PATTERN")
      .toBe(EMOTION_PATTERN);
  });

  it("substitutes exactly what normalize_emotion substitutes", () => {
    const python = capture(
      servicePy("emotions.py"),
      /re\.sub\(r"([^"]+)",\s*"_"/,
      "normalize_emotion's re.sub",
    );
    // The TS constant is a JS regex source, so a backslash is doubled there.
    expect(python, "normalize_emotion changed its separator run — update EMOTION_SEPARATOR_PATTERN")
      .toBe(EMOTION_SEPARATOR_PATTERN.replace(/\\\\/g, "\\"));
  });

  it("shows the reason normalize_emotion itself would give", () => {
    const source = servicePy("emotions.py");
    const raise = /raise ValueError\(([\s\S]*?)\n\s*\)/.exec(source);
    expect(raise, "normalize_emotion's ValueError not found").toBeTruthy();
    const message = [...raise![1].matchAll(/"([^"]*)"/g)].map((m) => m[1]).join("");
    expect(message, "the service's rejection wording moved — update EMOTION_RULE")
      .toBe(EMOTION_RULE);
  });

  it("uses service/voices.py::_slug verbatim", () => {
    const python = capture(
      servicePy("voices.py"),
      /def _slug\(name: str\) -> str:\s*\n\s*s = re\.sub\(r"([^"]+)",\s*"-"/,
      "voices.py::_slug",
    );
    expect(python, "_slug changed its separator run — update CHARACTER_SEPARATOR_PATTERN")
      .toBe(CHARACTER_SEPARATOR_PATTERN);
  });
});

describe("checkEmotion", () => {
  it("refuses the names the panel used to advertise as addressable", () => {
    // The bug: the preview printed `battle_cry` for "battle_cry!" and the mint
    // then 400ed.
    const bad = checkEmotion("battle_cry!");
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.reason).toBe(EMOTION_RULE);
  });

  it("refuses what maxLength={24} never covered", () => {
    expect(checkEmotion("a").ok).toBe(false);            // 2-char minimum
    expect(checkEmotion("1st").ok).toBe(false);          // must start with a letter
    expect(checkEmotion("_hidden").ok).toBe(false);      // ditto
    expect(checkEmotion("Über").ok).toBe(false);         // outside the character class
    expect(checkEmotion("").ok).toBe(false);
    expect(checkEmotion("a".repeat(25)).ok).toBe(false); // the 24-char cap
  });

  it("accepts and canonicalises what the service accepts", () => {
    expect(checkEmotion("battle cry")).toEqual({ ok: true, slug: "battle_cry" });
    expect(checkEmotion("  Battle-Cry ")).toEqual({ ok: true, slug: "battle_cry" });
    expect(checkEmotion("asmr")).toEqual({ ok: true, slug: "asmr" });
    expect(checkEmotion("a".repeat(24)).ok).toBe(true);  // exactly at the cap
  });

  it("still exposes the raw substitution for callers that want it", () => {
    expect(emotionSlug("Battle Cry")).toBe("battle_cry");
  });
});

describe("characterSlug", () => {
  it("substitutes every non-alphanumeric run, as _slug does", () => {
    // The panel used to print `mary-o'brien:sarcastic` — a copy-pasteable API
    // address that 404s.
    expect(characterSlug("Mary O'Brien")).toBe("mary-o-brien");
    expect(characterSlug("Sarah  Chen")).toBe("sarah-chen");
    expect(characterSlug("  --Ada!!  ")).toBe("ada");
  });

  it("falls back to _slug's own default rather than an empty id", () => {
    expect(characterSlug("!!!")).toBe("character");
    expect(characterSlug("")).toBe("character");
  });
});
