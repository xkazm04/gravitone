"use client";

// PUBLISH AND REVIEW — the take log's second life. A take becomes a /t/{id}
// page, and two or more of them become a no-login /r/{id} approval link. Both
// verbs go through ONE upload map, because a take that gets published twice is
// two pages for one recording.

import { useEffect, useRef, useState } from "react";
import { apiJson } from "@/lib/apiFetch";
import { useCopyFeedback } from "@/lib/useCopyFeedback";
import type { useMounted } from "@/lib/useMounted";
import { uploadTake } from "./engine";
import type { Take } from "./shared";

export function usePlaygroundSharing({ takes, mounted }: {
  takes: Take[];
  mounted: ReturnType<typeof useMounted>;
}) {
  // take id → shared state: publishing / share id / failed
  const [shares, setShares] = useState<Record<string, string | "pending" | "error">>({});
  // Clipboard truth for both copy affordances (per-take share link, keyed by
  // take id; the review link under the key "review"). Published is not the
  // same as copied and the labels must not claim otherwise.
  const { copy, copied, failed: copyFailed } = useCopyFeedback<string>(2500);
  // Publish-time consent for PUBLIC re-perform, applied to takes published
  // from here on. Default OFF — see the toggle in the takes-log header.
  const [allowReperform, setAllowReperform] = useState(false);
  // Why publishing a take failed. The button's "✗ failed" says THAT it failed;
  // the backend's own detail (request id included) says what to do about it,
  // and share()'s catch used to throw it away.
  const [shareErr, setShareErr] = useState<string | null>(null);
  // client-review link: selected take ids → /r/{id}
  const [reviewSel, setReviewSel] = useState<Set<string>>(new Set());
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewUrl, setReviewUrl] = useState<string | null>(null);
  const [reviewErr, setReviewErr] = useState<string | null>(null);

  // Coalesce concurrent uploads of the SAME take: share() and ensureShared()
  // share this map, so clicking "share" and then "client review link" before
  // the first upload settles reuses the one in-flight upload instead of minting
  // two /t/{id} pages for one take.
  const inflightUploads = useRef<Map<string, Promise<string>>>(new Map());
  function uploadOnce(t: Take): Promise<string> {
    const existing = inflightUploads.current.get(t.id);
    if (existing) return existing;
    const p = uploadTake(t, { allowReperform }).finally(() => { inflightUploads.current.delete(t.id); });
    inflightUploads.current.set(t.id, p);
    return p;
  }

  /** Copy a share link. useCopyFeedback owns the "did the clipboard accept it"
   *  question (and the timer cleanup) for every copy affordance in the app. */
  async function copyShareLink(takeId: string, shareId: string) {
    await copy(`${window.location.origin}/t/${shareId}`, takeId);
  }

  /** Persist a take server-side, mint its /t/{id} page, copy the link. */
  async function share(t: Take) {
    const existing = shares[t.id];
    if (existing && existing !== "pending" && existing !== "error") {
      // Already published — clicking again just re-copies the link.
      await copyShareLink(t.id, existing);
      return;
    }
    if (!t.url || existing === "pending") return;
    setShares((s) => ({ ...s, [t.id]: "pending" }));
    setShareErr(null);
    try {
      const id = await uploadOnce(t);
      if (!mounted.current) return;
      setShares((s) => ({ ...s, [t.id]: id }));
      await copyShareLink(t.id, id);
    } catch (e) {
      if (!mounted.current) return;
      setShares((s) => ({ ...s, [t.id]: "error" }));
      setShareErr(e instanceof Error && e.message
        ? `This take could not be published — ${e.message}`
        : "This take could not be published. The take itself is safe in your log.");
      // The "✗ failed" chip clears itself — see the effect below, which owns
      // the timer.
    }
  }

  // Let a failed share chip fade back to "↗ share" so the button is offerable
  // again. This used to be a bare setTimeout inside share()'s catch: no cleanup
  // and no `mounted.current` check, so navigating away left a timer holding a
  // setState on a dead component (every other async path in this file guards).
  // As an effect, React cancels it on unmount and on the next change for free.
  const erroredShares = Object.entries(shares)
    .filter(([, v]) => v === "error").map(([id]) => id).sort().join(" ");
  useEffect(() => {
    if (!erroredShares) return;
    const ids = erroredShares.split(" ");
    const timer = setTimeout(() => {
      setShares((s) => {
        const next = { ...s };
        // Only clear what is STILL failed — a retry that has since gone pending
        // or succeeded must not be reset by an older timer.
        for (const id of ids) if (next[id] === "error") delete next[id];
        return next;
      });
    }, 2000);
    return () => clearTimeout(timer);
  }, [erroredShares]);

  /** Publish a take if needed and return its share id (the review needs one). */
  async function ensureShared(t: Take): Promise<string> {
    const existing = shares[t.id];
    if (existing && existing !== "pending" && existing !== "error") return existing;
    // "pending" falls through to uploadOnce, which returns the in-flight
    // share() upload rather than starting a duplicate one.
    const id = await uploadOnce(t);
    setShares((s) => ({ ...s, [t.id]: id }));
    return id;
  }

  /** Bundle the selected takes into a no-login client approval link. */
  async function createReview() {
    if (reviewSel.size < 2 || reviewBusy) return;
    setReviewBusy(true); setReviewErr(null); setReviewUrl(null);
    try {
      const chosen = takes.filter((t) => reviewSel.has(t.id));
      const ids = await Promise.all(chosen.map(ensureShared));
      const j = await apiJson<{ review_id: string }>("/api/reviews", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: `${chosen[0].characterName} — pick a take`, take_ids: ids }),
      }, "could not create the review");
      if (!mounted.current) return;
      const url = `${window.location.origin}/r/${j.review_id}`;
      setReviewUrl(url);
      setReviewSel(new Set());
      // The banner reports the copy's TRUE outcome (see reviewUrl below) — it
      // used to claim "✓ review link copied" after a swallowed rejection.
      await copy(url, "review");
    } catch (e) {
      if (!mounted.current) return;
      setReviewErr(e instanceof Error ? e.message : "could not create the review");
    } finally { if (mounted.current) setReviewBusy(false); }
  }

  return {
    shares, setShares, copy, copied, copyFailed,
    allowReperform, setAllowReperform, shareErr, setShareErr,
    reviewSel, setReviewSel, reviewBusy, reviewUrl, reviewErr,
    share, createReview,
  };
}
