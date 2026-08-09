"use client";

// ── Audible Docs: the narration dock ─────────────────────────────────────────
//
// The site reads itself aloud. A compact glass pill sits in the corner of every
// route the registry (lib/narratable) can narrate; one click expands it into a
// transport and starts a sequential, sentence-by-sentence reading through the
// same /api/speak relay the studio uses — Character chosen per section role,
// each sentence wrapped in the section's [emotion] metatag, the block being
// spoken highlighted on the page.
//
// The four rules this component will not bend:
//
//  1. STRICTLY OPT-IN. Nothing here ever calls play() without a click or a key
//     press that means "play". `?narrate=1` ARMS the dock — it opens, it says it
//     is ready — and then waits. A site that starts talking at you is a site
//     people close, and a voice company auto-playing audio would be the loudest
//     possible statement that it does not understand its own product.
//  2. HONEST STATES. Busy engine, unreachable backend, refused relay, a browser
//     that blocked playback, a cache that cannot be written — each is NAMED in
//     the dock. Nothing is retried behind a spinner that says nothing.
//  3. KEYBOARD FIRST. Every control is a real button in tab order, plus
//     space / arrows / Escape while focus is inside the dock.
//  4. REDUCED MOTION means no scrolling. The highlight still moves (that is
//     information, not decoration) — the page does not.
//
// The playback element is registered with the AudioBus, so the whole frame —
// every --gt-level reader on the page — moves with the narrator's voice. That
// is the demo: the site is not describing the product, it is running it.
//
// The parts live alongside: ./narrationDockState (the reducer),
// ./narrationDockNarrator (who reads), ./narrationDockSynthesis (where the
// bytes come from), ./narrationDockHighlight (what the reading looks like on
// the page), ./narrationDockStatus (what it says about itself), and the use*
// hooks + ./NarrationDockPanel this file wires up.

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { usePathname } from "next/navigation";

import {
  narratableFor, narrationPlan,
  type NarratableRoute, type NarrationStep,
} from "@/lib/narratable";
import { useAudioBus } from "./AudioBus";
import { EqBars } from "./Equalizer";
import { NarrationDockPanel } from "./NarrationDockPanel";
import { HIGHLIGHT_CSS, ROLE_HUE } from "./narrationDockHighlight";
import { INITIAL_DOCK, reduceDock } from "./narrationDockState";
import { dockStatus } from "./narrationDockStatus";
import { useNarrationDockClips } from "./useNarrationDockClips";
import { useNarrationDockHighlight } from "./useNarrationDockHighlight";
import { useNarrationDockNarrators } from "./useNarrationDockNarrators";
import { EMPTY_ROUTE, useRemoteNarration } from "./useNarrationDockRemote";
import { useNarrationDockTransport } from "./useNarrationDockTransport";

// The public surface, unchanged: the reducer and the narrator picker are pure
// and are imported by name from all over the tests and the bake script.
export {
  INITIAL_DOCK, reduceDock,
  type DockEvent, type DockPhase, type DockState,
} from "./narrationDockState";
export { AUTO_NARRATOR, pickNarrator } from "./narrationDockNarrator";
export type { ClipSource } from "./narrationDockSynthesis";

// ── the dock ─────────────────────────────────────────────────────────────────

export default function NarrationDock() {
  const pathname = usePathname();
  const registry = useMemo(() => narratableFor(pathname), [pathname]);
  const remote = useRemoteNarration();

  // A requested narration WINS over the page's own registry entry: the link
  // said "listen to this", not "listen to the page you landed on".
  const route = remote.route ?? (remote.requested ? EMPTY_ROUTE : registry);
  if (!route) return null;
  if (remote.loading && !registry) return null;
  // Keyed on the route so switching pages — or resolving a remote plan —
  // rebuilds the transport from scratch rather than leaving a cursor pointing
  // into the previous plan.
  return <Dock key={route.route} route={route} notice={remote.notice} />;
}

function Dock({ route, notice }: { route: NarratableRoute; notice?: string | null }) {
  const plan = useMemo(() => narrationPlan(route), [route]);
  const total = plan.length;

  const bus = useAudioBus();
  const [state, dispatch] = useReducer(reduceDock, INITIAL_DOCK);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playRef = useRef<HTMLButtonElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const pillRef = useRef<HTMLButtonElement | null>(null);
  // Only move focus for an expand/collapse the USER did. Arming from
  // ?narrate=1 must not yank the caret out of whatever they were doing.
  const focusNext = useRef(false);

  const { roster, rosterError, chosen, chooseNarrator } = useNarrationDockNarrators(state.open);
  const { source, cached, manifest, clearCache } = useNarrationDockClips({
    open: state.open,
    plan,
    phase: state.phase,
    index: state.index,
    dispatch,
    roster,
    chosen,
    audioRef,
  });

  const step: NarrationStep | undefined = plan[state.index];
  const busy = state.phase === "loading";
  const live = state.phase === "playing" || state.phase === "loading" || state.phase === "paused";

  // ── ?narrate=1 ARMS the dock ───────────────────────────────────────────────
  // Read off window rather than useSearchParams: this component is mounted from
  // the root layout, and useSearchParams there opts every static page out of
  // prerendering. Arming is a client-side nicety, so it belongs on the client.
  useEffect(() => {
    try {
      const v = new URLSearchParams(window.location.search).get("narrate");
      if (v === "1" || v === "true") dispatch({ t: "arm" });
    } catch {
      /* exotic URL — the dock is one click away regardless */
    }
  }, []);

  // ── pause / resume drive the element, not the other way round ─────────────
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    if (state.phase === "paused") el.pause();
    else if (state.phase === "idle") {
      el.pause();
      try {
        el.currentTime = 0;
      } catch {
        /* no media loaded yet */
      }
    }
  }, [state.phase]);

  useNarrationDockHighlight({ live, step, bus });

  useEffect(() => {
    bus.setWorking(busy);
    return () => bus.setWorking(false);
  }, [bus, busy]);

  // ── focus follows the toggle ───────────────────────────────────────────────
  // Expanding replaces the pill with the transport; without this, focus lands
  // on <body> and the keyboard listener below (Escape, space, arrows) is
  // unreachable for exactly the users who need it most.
  useEffect(() => {
    if (!focusNext.current) return;
    focusNext.current = false;
    if (!state.open) {
      pillRef.current?.focus();
      return;
    }
    // The play button is disabled until a narrator is known; the panel itself
    // is the fallback landing spot, so the shortcuts are never unreachable.
    const play = playRef.current;
    (play && !play.disabled ? play : sectionRef.current)?.focus();
  }, [state.open]);

  const toggleOpen = useCallback((open: boolean) => {
    focusNext.current = true;
    dispatch({ t: open ? "expand" : "collapse" });
  }, []);

  const attach = useCallback(
    (el: HTMLAudioElement | null) => {
      audioRef.current = el;
      if (el) bus.register(el);
    },
    [bus],
  );
  useEffect(() => {
    const el = audioRef.current;
    return () => bus.unregister(el);
  }, [bus]);

  const { onPlayPause, onKeyDown } = useNarrationDockTransport({
    phase: state.phase,
    open: state.open,
    total,
    dispatch,
    audioRef,
    toggleOpen,
  });

  // ── copy the dock says out loud ────────────────────────────────────────────
  const canPlay = !!roster?.length && total > 0;
  const status = dockStatus({
    state, notice, rosterError, total, roster, source, manifest, cached,
  });

  const progress = total > 0 ? (state.index + (live ? 1 : 0)) / total : 0;
  const accent = `hsl(${step ? ROLE_HUE[step.block.role] ?? 190 : 190} 85% 62%)`;

  return (
    <>
      <style>{HIGHLIGHT_CSS}</style>
      <div
        className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-4 sm:justify-end sm:px-6"
        data-gt-narration-dock=""
      >
        <section
          ref={sectionRef}
          aria-label="Listen to this page"
          onKeyDown={onKeyDown}
          tabIndex={-1}
          className={`pointer-events-auto w-full outline-none ${state.open ? "max-w-sm" : "max-w-fit"}`}
        >
          {/* The element itself is never shown: the transport IS the chrome. */}
          <audio
            ref={attach}
            preload="none"
            onEnded={() => dispatch({ t: "ended", total })}
            onError={() =>
              state.phase !== "idle" &&
              dispatch({ t: "fail", message: "that clip would not play in this browser" })}
          />

          {!state.open ? (
            <button
              ref={pillRef}
              type="button"
              onClick={() => toggleOpen(true)}
              aria-expanded={false}
              className="group flex cursor-pointer items-center gap-3 rounded-full border border-white/12 bg-black/55 px-4 py-2.5 backdrop-blur-[var(--gt-blur)] transition hover:border-cyan-300/40 focus-visible:outline-2 focus-visible:outline-offset-2"
              style={{ outlineColor: accent, boxShadow: `0 10px 40px -18px ${accent}` }}
            >
              <span aria-hidden className="flex h-4 items-end gap-[3px]">
                <EqBars bars={4} height={16} />
              </span>
              <span className="font-jetbrains text-[11px] uppercase tracking-[0.18em] text-white/80 transition group-hover:text-white">
                {live ? "reading this page" : "listen to this page"}
              </span>
            </button>
          ) : (
            <NarrationDockPanel
              title={route.title}
              accent={accent}
              step={step}
              state={state}
              total={total}
              progress={progress}
              busy={busy}
              live={live}
              canPlay={canPlay}
              status={status}
              rosterError={rosterError}
              roster={roster}
              chosen={chosen}
              cached={cached}
              playRef={playRef}
              dispatch={dispatch}
              onPlayPause={onPlayPause}
              onCollapse={() => toggleOpen(false)}
              onChooseNarrator={chooseNarrator}
              onClearCache={clearCache}
            />
          )}
        </section>
      </div>
    </>
  );
}
