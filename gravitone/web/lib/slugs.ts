// The web-side mirror of the service's TWO slug rules — the only copy the
// studio is allowed to keep.
//
// The rules had drifted into three spellings. `EmotionRack` previewed a custom
// emotion with the SUBSTITUTION half of `normalize_emotion` and none of its
// validation, so the panel promised "[battle_cry!] is addressable immediately"
// two lines under an input the server would 400; and it derived a character
// address by collapsing whitespace only, so "Mary O'Brien" was printed as the
// copy-pasteable, 404-ing `mary-o'brien:sarcastic`. `voices/new/page.tsx` kept
// a correct third copy of the character rule that nothing else could reach.
//
// Both rules now live here once, expressed as the PATTERN SOURCE STRINGS the
// service uses. `slugs.test.ts` reads service/emotions.py and service/voices.py
// and fails when either side moves — the same drift-guard shape as
// lib/serviceHeaders.test.ts. This is a user-facing optimization ONLY: the
// service stays the enforcement point and must keep rejecting.

/** Source of `service/emotions.py::_EMOTION_RE`. */
export const EMOTION_PATTERN = "^[a-z][a-z0-9_]{1,23}$";

/** What `normalize_emotion` collapses to "_" before matching. */
export const EMOTION_SEPARATOR_PATTERN = "[\\s-]+";

/** What `service/voices.py::_slug` collapses to "-". */
export const CHARACTER_SEPARATOR_PATTERN = "[^a-zA-Z0-9]+";

/** `normalize_emotion`'s ValueError text, verbatim — so the reason shown at the
 *  input is the reason the server would have given. */
export const EMOTION_RULE =
  "emotion must be 2-24 chars, start with a letter, and use only "
  + "lowercase letters, digits and underscores";

const EMOTION_RE = new RegExp(EMOTION_PATTERN);
const EMOTION_SEP_RE = new RegExp(EMOTION_SEPARATOR_PATTERN, "g");
const CHARACTER_SEP_RE = new RegExp(CHARACTER_SEPARATOR_PATTERN, "g");

/** The substitution half of `normalize_emotion` — NOT a promise of validity.
 *  Anything shown to a user goes through {@link checkEmotion} instead. */
export function emotionSlug(name: string): string {
  return (name ?? "").trim().toLowerCase().replace(EMOTION_SEP_RE, "_");
}

export type EmotionCheck =
  | { ok: true; slug: string }
  | { ok: false; slug: string; reason: string };

/**
 * The whole of `normalize_emotion`: substitute, then VALIDATE. Where the
 * service raises, this returns `ok: false` with the server's own wording, so a
 * name that cannot be minted is refused at the input rather than at the 400.
 */
export function checkEmotion(name: string): EmotionCheck {
  const slug = emotionSlug(name);
  return EMOTION_RE.test(slug)
    ? { ok: true, slug }
    : { ok: false, slug, reason: EMOTION_RULE };
}

/**
 * `service/voices.py::_slug` — the character_id the service will mint for a
 * name. Use the server's `character_id` when you HAVE one; this is for the
 * create flow, which must predict the id before the character exists.
 */
export function characterSlug(name: string): string {
  const s = (name ?? "").trim().toLowerCase()
    .replace(CHARACTER_SEP_RE, "-")
    .replace(/^-+|-+$/g, ""); // Python's .strip("-")
  return s || "character";
}
