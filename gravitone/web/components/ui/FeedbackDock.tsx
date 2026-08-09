"use client";

// ── The studio listens back ──────────────────────────────────────────────────
//
// A collapsed hairline pill in the bottom-left corner of the signed-in studio.
// One click opens a glass panel with a textarea and a send button; the note
// goes to /api/feedback, which verifies the sender at Google and files it in
// Firestore. That is the entire feature.
//
// Three deliberate constraints:
//
//  1. SIGNED-IN ONLY. The pill does not render for a signed-out visitor, and
//     the route refuses a request without a vouched token. This is not
//     gatekeeping — it is the only shape that needs no new credential: the
//     write travels on the USER'S own Firebase token, so the deployed
//     Firestore rules govern it exactly as they govern every other write in
//     this app. An anonymous path would mean opening the collection to
//     unauthenticated creates, i.e. a spam surface, to serve visitors who are
//     on the landing page rather than in the studio.
//  2. NOTHING WITHOUT FIREBASE. A self-hoster running the studio against a
//     bare backend sees no pill at all, and nothing about the app changes.
//  3. IT NAMES ITS FAILURES. A refused or unreachable submission says what
//     happened through the app's one inline failure surface (ErrorBanner) and
//     keeps the text in the box, so a retry is a click and not a retype.
//
// Mounted from app/layout.tsx alongside NarrationDock (the other globally
// mounted, route-aware dock) and sits opposite it so the two never overlap.

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

// The counter warns before the round trip; the route is what enforces it. One
// constant, imported — not a mirrored literal that can drift out of agreement
// with the server that rejects it.
import { MAX_MESSAGE_CHARS as FEEDBACK_MAX_CHARS } from "@/app/api/feedback/limits";
import { readDetail } from "@/lib/apiFetch";
import { useAuth } from "@/lib/useAuth";
import { FeedbackDockPanel, type Phase } from "./FeedbackDockPanel";

/** Routes that are not the studio: an embedded player is someone else's page,
 *  and app chrome has no business appearing inside it. */
function suppressed(pathname: string | null): boolean {
  return Boolean(pathname && pathname.endsWith("/embed"));
}

export default function FeedbackDock() {
  const { user, ready } = useAuth();
  const pathname = usePathname();
  // Signed out, unconfigured, or embedded — render nothing at all. (Hooks are
  // all in the child, so this early return is stable across renders.)
  if (!ready || !user || suppressed(pathname)) return null;
  return <Dock />;
}

function Dock() {
  const { user } = useAuth();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const pillRef = useRef<HTMLButtonElement | null>(null);
  // Guards a setState after the component (or the panel) is gone — the send is
  // an await, and the user can close the panel mid-flight.
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const close = useCallback(() => {
    setOpen(false);
    setError(null);
    pillRef.current?.focus();
  }, []);

  // Escape closes, from anywhere inside the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  useEffect(() => { if (open) areaRef.current?.focus(); }, [open]);

  const trimmed = message.trim();
  const tooLong = trimmed.length > FEEDBACK_MAX_CHARS;
  const canSend = Boolean(trimmed) && !tooLong && phase !== "sending";

  const send = useCallback(async () => {
    if (!canSend || !user) return;
    setPhase("sending");
    setError(null);
    try {
      // The token, never a uid: the route derives identity from this at Google
      // and has nowhere to put a uid we might claim.
      const idToken = await user.getIdToken();
      const r = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken, message: trimmed, route: pathname ?? "" }),
      });
      if (!alive.current) return;
      if (!r.ok) {
        setError((await readDetail(r)) ?? "Feedback could not be sent.");
        setPhase("idle");
        return;
      }
      setPhase("sent");
      setMessage("");
    } catch (e) {
      if (!alive.current) return;
      setError(e instanceof Error ? e.message : "Feedback could not be sent.");
      setPhase("idle");
    }
  }, [canSend, user, trimmed, pathname]);

  return (
    // Bottom-LEFT, opposite NarrationDock. Lifted above the dock's line on
    // narrow screens, where the dock centres itself across the full width.
    <div className="pointer-events-none fixed bottom-20 left-0 z-50 px-4 sm:bottom-0 sm:px-6 sm:pb-4">
      {!open ? (
        <button
          ref={pillRef}
          type="button"
          onClick={() => { setOpen(true); setPhase("idle"); }}
          className="font-jetbrains pointer-events-auto flex cursor-pointer items-center gap-2 rounded-full border border-white/12 bg-black/55 px-3.5 py-2 text-[11px] uppercase tracking-[0.18em] text-white/60 backdrop-blur-[var(--gt-blur)] transition hover:border-cyan-300/40 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-cyan-300/70" />
          Feedback
        </button>
      ) : (
        <FeedbackDockPanel
          areaRef={areaRef}
          message={message}
          onMessage={setMessage}
          phase={phase}
          onCompose={() => setPhase("idle")}
          onClose={close}
          onSend={() => void send()}
          canSend={canSend}
          tooLong={tooLong}
          length={trimmed.length}
          error={error}
        />
      )}
    </div>
  );
}
