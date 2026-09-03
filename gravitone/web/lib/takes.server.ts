// Reading a published take ONCE per request.
//
// The share route asks the backend for the same take twice on every single
// view: once in `generateMetadata` (for the title and the OG card) and once in
// the page body. Both reads are `cache: "no-store"` with a fresh
// `AbortSignal.timeout` per call, so neither Next's fetch cache nor React's
// fetch memoization can collapse them — a signal makes every request unique.
// Two backend round trips per visitor, for one take, plus the lineage read.
//
// `cache()` is the seam for exactly this: it memoizes for the lifetime of ONE
// server request, so metadata and body share a read and nothing is cached
// between visitors — a bounded take store evicts, and a share page must never
// serve one visitor's snapshot to the next.
//
// It lives in its own module because lib/takes is also in the CLIENT bundle
// (castOf, the payload types), and `cache` is a Server Component API.

import { cache } from "react";
import { loadLineage, loadTake } from "./takes";

/** One published take, read at most once per request. */
export const readTake = cache(loadTake);

/** One take's lineage, read at most once per request. */
export const readLineage = cache(loadLineage);
