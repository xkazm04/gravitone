// Shared shape + limits for the feedback intake.
//
// A sibling module rather than exports on route.ts because Next's route-type
// checker allows ONLY the HTTP handlers and its own reserved config exports —
// a stray `export const` there fails `next build` outright. Same reason
// app/api/keys/deployment.ts sits beside its route.
//
// Living here also means the dock's character counter and the route's rejection
// read the SAME number: a mirrored constant is a constant that drifts.

/** Longest feedback we will store. Long enough for a real paragraph, short
 *  enough that a single caller cannot write a novel into the collection. */
export const MAX_MESSAGE_CHARS = 2000;

/** The route string is a breadcrumb ("/voices/ada"), never prose. */
export const MAX_ROUTE_CHARS = 200;

/** What a successful POST /api/feedback answers with. */
export type FeedbackAccepted = { ok: true; id: string };
