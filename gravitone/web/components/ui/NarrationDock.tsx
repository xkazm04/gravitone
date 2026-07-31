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

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { usePathname } from "next/navigation";

import { readDetail } from "@/lib/apiFetch";
import {
  BAKED_MANIFEST, bakedUrl, clipKey, narratableFor, narrationPlan, parseManifest,
  routeFromPlan, taggedSentence,
  type BakeManifest, type CharacterHint, type NarratableRoute, type NarrationStep,
} from "@/lib/narratable";
import { cacheAvailable, clearClips, countClips, getClip, putClip } from "@/lib/narrationCache";
import { useAudioBus } from "./AudioBus";
import { EqBars } from "./Equalizer";

// ── the state machine ────────────────────────────────────────────────────────
//
// Exported and pure, because the interesting bugs in a transport are all
// transition bugs: ending the last sentence must return to a resettable idle,
// collapsing must NOT stop the voice mid-word, a failure must keep its place so
// "play" retries the sentence that failed rather than restarting the page.

export type DockPhase = "idle" | "loading" | "playing" | "paused" | "error";

export type DockState = {
  /** Expanded transport (true) vs collapsed pill (false). */
  open: boolean;
  phase: DockPhase;
  /** Cursor into the flattened sentence plan. */
  index: number;
  /** The named reason for `phase === "error"`. */
  error: string | null;
};

export const INITIAL_DOCK: DockState = { open: false, phase: "idle", index: 0, error: null };

export type DockEvent =
  | { t: "arm" }                     // ?narrate=1 — open, do NOT play
  | { t: "expand" }
  | { t: "collapse" }                // collapse only: audio keeps playing
  | { t: "play" }                    // start / retry at the current index
  | { t: "pause" }
  | { t: "resume" }
  | { t: "started" }                 // the element is actually producing audio
  | { t: "ended"; total: number }
  | { t: "next"; total: number }
  | { t: "prev" }
  | { t: "jump"; index: number }
  | { t: "stop" }
  | { t: "fail"; message: string };

export function reduceDock(s: DockState, e: DockEvent): DockState {
  switch (e.t) {
    case "arm":
      // Armed is OPEN, never PLAYING. The whole deep link is one click short of
      // audio on purpose.
      return s.open ? s : { ...s, open: true };
    case "expand":
      return { ...s, open: true };
    case "collapse":
      return { ...s, open: false };
    case "play":
      return { ...s, phase: "loading", error: null };
    case "pause":
      return s.phase === "playing" || s.phase === "loading" ? { ...s, phase: "paused" } : s;
    case "resume":
      return s.phase === "paused" ? { ...s, phase: "playing", error: null } : s;
    case "started":
      return s.phase === "loading" || s.phase === "playing" ? { ...s, phase: "playing" } : s;
    case "ended":
      return s.index + 1 < e.total
        ? { ...s, phase: "loading", index: s.index + 1, error: null }
        : { ...s, phase: "idle", index: 0, error: null };
    case "next":
      return s.index + 1 < e.total
        ? { ...s, phase: "loading", index: s.index + 1, error: null }
        : { ...s, phase: "idle", index: 0, error: null };
    case "prev":
      return { ...s, phase: "loading", index: Math.max(0, s.index - 1), error: null };
    case "jump":
      return { ...s, phase: "loading", index: Math.max(0, e.index), error: null };
    case "stop":
      return { ...s, phase: "idle", index: 0, error: null };
    case "fail":
      // The index is KEPT: pressing play retries the sentence that failed.
      return { ...s, phase: "error", error: e.message };
    default:
      return s;
  }
}

// ── narrator selection ───────────────────────────────────────────────────────

/** The slice of /api/characters this dock needs. Typed locally rather than
 *  imported from app/voices/_data — that module is the studio's data layer and
 *  drags Firebase auth in with it, which a public landing page must not load. */
type Narrator = {
  character_id: string;
  name: string;
  category?: "cloned" | "premade";
  tags?: string[];
  lang?: string;
};

const NARRATOR_KEY = "gravitone.narrator";
export const AUTO_NARRATOR = "auto";

const HINT_MATCH: Record<CharacterHint, RegExp> = {
  warm: /warm|bright|friendly|happy|soft/i,
  measured: /narration|calm|neutral|deep|documentary|measured/i,
};

/**
 * Who reads this block.
 *
 * An explicit choice wins everywhere — a listener who picked a narrator gets
 * that narrator, not a per-section surprise. On "auto" the section's
 * characterHint picks from the roster's own tags (hero = warm, benchmarks =
 * measured), and when nothing matches the first roster entry reads it. Never
 * invents an id: an empty roster returns null and the dock refuses to play with
 * a named reason instead of posting a guess at the relay.
 */
export function pickNarrator(
  roster: Narrator[],
  chosen: string,
  hint: CharacterHint,
): Narrator | null {
  if (!roster.length) return null;
  if (chosen !== AUTO_NARRATOR) {
    const exact = roster.find((c) => c.character_id === chosen);
    if (exact) return exact;
  }
  const re = HINT_MATCH[hint];
  const tagged = roster.find((c) => (c.tags ?? []).some((t) => re.test(t)) || re.test(c.name));
  return tagged ?? roster.find((c) => c.category === "premade") ?? roster[0];
}

// ── synthesis ────────────────────────────────────────────────────────────────

/** A failure the dock can NAME. `retryAfter` is set only for backpressure. */
class NarrationError extends Error {
  constructor(message: string, readonly kind: "busy" | "unreachable" | "refused" | "blocked" | "failed") {
    super(message);
    this.name = "NarrationError";
  }
}

/**
 * Turn one non-OK /api/speak response into a sentence a visitor can act on.
 *
 * /api/speak is the studio's PUBLIC relay: the server attaches its own
 * GRAVITONE_API_KEY (lib/backend#backendFetch), so listening needs no account
 * and no key of the visitor's own. That is exactly why a 401/403 here has to be
 * reported as a DEPLOYMENT fact ("this deployment's relay key is missing or
 * rejected") rather than as something the listener did wrong or could fix by
 * signing in.
 */
async function speakFailure(res: Response): Promise<NarrationError> {
  const detail = await readDetail(res);
  if (res.status === 429) {
    const wait = Math.max(1, Math.ceil(Number(res.headers.get("Retry-After")) || 1));
    return new NarrationError(
      `the speech engine is busy — it will take this again in about ${wait}s`, "busy");
  }
  if (res.status === 401 || res.status === 403) {
    return new NarrationError(
      "the speech relay was refused — this deployment's server key is missing or rejected", "refused");
  }
  if (res.status === 503 && detail?.includes("unreachable")) {
    return new NarrationError("the speech engine is unreachable from here", "unreachable");
  }
  if (res.status === 503) {
    return new NarrationError("the speech engine is restarting — try again in a moment", "unreachable");
  }
  if (res.status === 404) {
    return new NarrationError(
      detail ?? "that narrator no longer exists on this deployment", "failed");
  }
  return new NarrationError(detail ?? `synthesis failed (${res.status})`, "failed");
}

/**
 * A clip that was rendered at BUILD time (web/scripts/bake-narration.ts).
 *
 * Preferred over synthesis whenever the key is in the manifest, because it is
 * the same audio: the bake computes `clipKey` from this very module, with the
 * same emotion tag and the same narrator, so a hit is not an approximation of
 * the live reading — it IS the live reading, rendered once.
 *
 * A miss returns null and the caller synthesizes. A manifest that promises a
 * clip the server does not serve is treated as a miss too, rather than as an
 * error: a stale manifest should cost a round trip, not the reading.
 */
async function fetchBaked(
  manifest: BakeManifest | null, key: string, signal: AbortSignal,
): Promise<Blob | null> {
  const url = bakedUrl(manifest, key);
  if (!url) return null;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const blob = await res.blob();
    return blob.size > 0 ? blob : null;
  } catch (e) {
    if ((e as { name?: string } | null)?.name === "AbortError") throw e;
    return null;
  }
}

/** Synthesize one tagged sentence. Throws a NarrationError on every failure —
 *  there is no browser-voice fallback here on purpose: a robot voice reading
 *  the marketing copy of a voice company is worse than an honest apology. */
async function synthesize(characterId: string, tagged: string, signal: AbortSignal): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ character_id: characterId, text: tagged }),
      signal,
    });
  } catch (e) {
    if ((e as { name?: string } | null)?.name === "AbortError") throw e;
    throw new NarrationError("could not reach the speech relay from this browser", "unreachable");
  }
  if (!res.ok) throw await speakFailure(res);
  return res.blob();
}

// ── the dock ─────────────────────────────────────────────────────────────────

/** Hue per section role, so the frame tints as the reading moves through the
 *  page. Values are the emotion hues from lib/emotions, restated as a narration
 *  concern rather than imported — this is "how the dock feels", not the scale. */
const ROLE_HUE: Record<string, number> = {
  hero: 20, stat: 48, voice: 48, feature: 200, switch: 200, cta: 20,
  benchmark: 170, methodology: 170,
};

const HIGHLIGHT_ATTR = "data-gt-narrating";

/** Where the bytes now playing came from. Stated rather than hidden: "cached"
 *  and "baked" and "rendered just now" are three different claims about what
 *  this listen cost, and a voice company that blurs them is describing its own
 *  product inaccurately. */
export type ClipSource = "cache" | "baked" | "live";

const SOURCE_COPY: Record<ClipSource, string> = {
  cache: "playing — cached",
  baked: "playing — baked at build time",
  live: "playing — rendered just now",
};

/** The one global rule this component owns: what a narrated block looks like.
 *  Scoped entirely to an attribute nothing else writes. */
const HIGHLIGHT_CSS = `
[${HIGHLIGHT_ATTR}] {
  border-radius: 22px;
  outline: 1px solid hsl(var(--gt-narr-hue, 190) 90% 65% / calc(0.25 + var(--gt-level, 0) * 0.45));
  outline-offset: 10px;
  box-shadow: 0 0 60px -20px hsl(var(--gt-narr-hue, 190) 90% 60% / 0.5);
  transition: outline-color 400ms var(--gt-ease), box-shadow 400ms var(--gt-ease);
}`;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

// ── the /v1/narrate consumer ─────────────────────────────────────────────────
//
// The registry above narrates THIS site. `?narration=<id>` narrates anything
// else: a plan minted by POST /v1/narrate — a customer's docs page, a pasted
// README, a blog post — played by the same transport, with the same cache, the
// same keyboard rules and the same refusals. That is the whole point of the
// plan being data: one player, two sources.
//
// The id travels in the URL rather than in a prop because the interesting use
// is a LINK ("here, listen to this"), and a link cannot pass a prop.

const NARRATION_PARAM = "narration";
const NARRATION_ID = /^[a-z0-9]{1,32}$/i;

type RemoteNarration = {
  route: NarratableRoute | null;
  notice: string | null;
  loading: boolean;
  requested: boolean;
};

function useRemoteNarration(): RemoteNarration {
  const [state, setState] = useState<RemoteNarration>(
    { route: null, notice: null, loading: false, requested: false });

  useEffect(() => {
    let id = "";
    try {
      id = new URLSearchParams(window.location.search).get(NARRATION_PARAM) ?? "";
    } catch {
      return; // exotic URL — the registry dock is unaffected
    }
    if (!id) return;
    if (!NARRATION_ID.test(id)) {
      setState({ route: null, loading: false, requested: true,
                 notice: "that narration id is not a valid id" });
      return;
    }
    const ctrl = new AbortController();
    setState({ route: null, notice: null, loading: true, requested: true });
    (async () => {
      try {
        const res = await fetch(`/api/narrate/${id}`, { signal: ctrl.signal, cache: "no-store" });
        if (res.status === 404) {
          // Two different 404s, and the difference matters to whoever is
          // debugging: no relay route deployed vs. a plan that has aged out.
          const detail = await readDetail(res);
          throw new Error(detail
            ?? "that narration is not on this deployment — plans are evicted oldest-first");
        }
        if (!res.ok) throw new Error(await readDetail(res) ?? "that narration could not be loaded");
        const built = routeFromPlan(await res.json());
        if (ctrl.signal.aborted) return;
        if (!built) throw new Error("that narration plan contains nothing readable");
        setState({ route: built, notice: null, loading: false, requested: true });
      } catch (e) {
        if ((e as { name?: string }).name === "AbortError") return;
        setState({
          route: null, loading: false, requested: true,
          notice: (e as Error).message || "that narration could not be loaded",
        });
      }
    })();
    return () => ctrl.abort();
  }, []);

  return state;
}

/** The stand-in reading for a narration that could not be loaded. The dock
 *  still appears, because the visitor followed a link that promised audio and
 *  silence is not an answer — it appears saying exactly what went wrong. */
const EMPTY_ROUTE: NarratableRoute = {
  route: "narration:unavailable",
  title: "This narration could not be loaded",
  blocks: [],
};

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
  const [roster, setRoster] = useState<Narrator[] | null>(null);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string>(AUTO_NARRATOR);
  const [source, setSource] = useState<ClipSource>("live");
  const [cached, setCached] = useState(0);
  const [manifest, setManifest] = useState<BakeManifest | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const playRef = useRef<HTMLButtonElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const pillRef = useRef<HTMLButtonElement | null>(null);
  // Only move focus for an expand/collapse the USER did. Arming from
  // ?narrate=1 must not yank the caret out of whatever they were doing.
  const focusNext = useRef(false);

  const step: NarrationStep | undefined = plan[state.index];
  const busy = state.phase === "loading";
  const live = state.phase === "playing" || state.phase === "loading" || state.phase === "paused";

  // ── narrator persistence (client-only; never read during render) ───────────
  useEffect(() => {
    try {
      const saved = localStorage.getItem(NARRATOR_KEY);
      if (saved) setChosen(saved);
    } catch {
      /* storage blocked — the picker still works, it just will not be remembered */
    }
  }, []);
  const chooseNarrator = useCallback((id: string) => {
    setChosen(id);
    try {
      localStorage.setItem(NARRATOR_KEY, id);
    } catch {
      /* not remembered; nothing else changes */
    }
  }, []);

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

  // ── the roster, fetched on first expand (never on page load) ───────────────
  useEffect(() => {
    if (!state.open || roster || rosterError) return;
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/characters", { cache: "no-store", signal: ctrl.signal });
        if (!res.ok) {
          const detail = await readDetail(res);
          throw new Error(detail ?? "could not load the narrators");
        }
        const list = (await res.json()) as Narrator[];
        const usable = Array.isArray(list) ? list.filter((c) => c?.character_id) : [];
        if (ctrl.signal.aborted) return;
        if (!usable.length) {
          setRosterError("this deployment has no Characters to read with yet");
          return;
        }
        setRoster(usable);
      } catch (e) {
        if ((e as { name?: string }).name === "AbortError") return;
        setRosterError((e as Error).message || "could not load the narrators");
      }
    })();
    return () => ctrl.abort();
  }, [state.open, roster, rosterError]);

  useEffect(() => {
    if (!state.open) return;
    void countClips().then(setCached).catch(() => {});
  }, [state.open, state.index]);

  // ── the build-time bake, if this deployment has one ────────────────────────
  // Fetched once on first expand, alongside the roster. A 404 is the ordinary
  // case (no bake ran) and must cost nothing: no retry, no error state, no
  // mention in the UI beyond the status line not saying "baked".
  useEffect(() => {
    if (!state.open || manifest) return;
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch(BAKED_MANIFEST, { signal: ctrl.signal });
        if (!res.ok) return;
        const parsed = parseManifest(await res.json());
        if (parsed && !ctrl.signal.aborted) setManifest(parsed);
      } catch {
        /* no bake here — live synthesis is the normal path, not a degradation */
      }
    })();
    return () => ctrl.abort();
  }, [state.open, manifest]);

  // ── audio for one step: cache, then bake, then synth ───────────────────────
  //
  // Ordered by cost, cheapest first. The IndexedDB cache is free and local; a
  // baked file is a static asset off the CDN and costs no engine; synthesis
  // costs a synth slot on the box. Every layer is keyed identically, so moving
  // between them can never play the wrong audio — only reach the same audio
  // more or less cheaply.
  const ensureClip = useCallback(
    async (target: NarrationStep, signal: AbortSignal): Promise<{ blob: Blob; from: ClipSource }> => {
      const narrator = pickNarrator(roster ?? [], chosen, target.block.characterHint);
      if (!narrator) throw new NarrationError("no narrator is available on this deployment", "failed");
      const key = clipKey(narrator.character_id, target.block, target.sentence);
      const hit = await getClip(key);
      if (hit) return { blob: hit.blob, from: "cache" };
      const baked = await fetchBaked(manifest, key, signal);
      if (baked) {
        await putClip(key, baked);
        return { blob: baked, from: "baked" };
      }
      const blob = await synthesize(narrator.character_id, taggedSentence(target.block, target.sentence), signal);
      await putClip(key, blob);
      return { blob, from: "live" };
    },
    [roster, chosen, manifest],
  );

  // ── the loader: the only place that starts audio ───────────────────────────
  useEffect(() => {
    if (state.phase !== "loading") return;
    const target = plan[state.index];
    if (!target) {
      dispatch({ t: "stop" });
      return;
    }
    const ctrl = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ctrl;
    let cancelled = false;

    (async () => {
      try {
        const { blob, from } = await ensureClip(target, ctrl.signal);
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = url;
        setSource(from);
        const el = audioRef.current;
        if (!el) throw new NarrationError("the player element is gone", "failed");
        el.src = url;
        try {
          await Promise.resolve(el.play?.());
        } catch {
          throw new NarrationError(
            "the browser blocked playback — press play once more", "blocked");
        }
        if (!cancelled) dispatch({ t: "started" });
      } catch (e) {
        if (cancelled || (e as { name?: string }).name === "AbortError") return;
        dispatch({ t: "fail", message: (e as Error).message || "narration failed" });
      }
    })();

    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [state.phase, state.index, plan, ensureClip]);

  // ── one-sentence lookahead ────────────────────────────────────────────────
  // Renders the NEXT sentence into the cache while this one plays, so the gap
  // between sentences is a beat and not a round-trip. Skipped when the cache is
  // unavailable, where it would spend a synth slot on audio nothing can keep.
  useEffect(() => {
    if (state.phase !== "playing" || !cacheAvailable()) return;
    const next = plan[state.index + 1];
    if (!next) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      void ensureClip(next, ctrl.signal).catch(() => {});
    }, 400);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [state.phase, state.index, plan, ensureClip]);

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

  // ── the highlight: information, so it survives reduced motion ─────────────
  useEffect(() => {
    if (!live || !step?.block.anchor) return;
    let el: Element | null = null;
    try {
      el = document.querySelector(step.block.anchor);
    } catch {
      el = null; // a selector this browser cannot parse costs the highlight only
    }
    if (!el) return;
    el.setAttribute(HIGHLIGHT_ATTR, "");
    (el as HTMLElement).style.setProperty(
      "--gt-narr-hue", String(ROLE_HUE[step.block.role] ?? 190));
    if (!prefersReducedMotion()) {
      try {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      } catch {
        /* older browsers: no smooth scroll, no problem */
      }
    }
    return () => {
      el?.removeAttribute(HIGHLIGHT_ATTR);
      (el as HTMLElement | null)?.style.removeProperty("--gt-narr-hue");
    };
  }, [live, step?.block.anchor, step?.block.role, step?.blockIndex]);

  // The frame tints with the section being read (contract C4's --gt-hue).
  useEffect(() => {
    if (!live || !step) return;
    bus.setHue(ROLE_HUE[step.block.role] ?? 190);
    return () => bus.setHue(null);
  }, [bus, live, step?.block.role, step]);

  useEffect(() => {
    bus.setWorking(busy);
    return () => bus.setWorking(false);
  }, [bus, busy]);

  // Object URLs outlive React state unless someone revokes them.
  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    },
    [],
  );

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

  // ── controls ───────────────────────────────────────────────────────────────
  const onPlayPause = useCallback(() => {
    if (state.phase === "playing") {
      dispatch({ t: "pause" });
      return;
    }
    if (state.phase === "paused") {
      const el = audioRef.current;
      dispatch({ t: "resume" });
      void Promise.resolve(el?.play?.()).catch(() =>
        dispatch({ t: "fail", message: "the browser blocked playback — press play once more" }));
      return;
    }
    dispatch({ t: "play" });
  }, [state.phase]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Never steal a key from the narrator picker or a link inside the dock.
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "SELECT" || tag === "INPUT" || tag === "A") return;
      switch (e.key) {
        case " ":
          // Space on a focused button MUST activate that button — hijacking it
          // for play/pause would make "next sentence" silently do something
          // else for anyone driving the transport from the keyboard.
          if (tag === "BUTTON") return;
          onPlayPause();
          break;
        case "k":
          onPlayPause();
          break;
        case "ArrowRight":
          dispatch({ t: "next", total });
          break;
        case "ArrowLeft":
          dispatch({ t: "prev" });
          break;
        case "Escape":
          if (state.open) toggleOpen(false);
          break;
        default:
          return;
      }
      e.preventDefault();
    },
    [onPlayPause, state.open, toggleOpen, total],
  );

  const clearCache = useCallback(() => {
    void clearClips().then(() => setCached(0));
  }, []);

  // ── copy the dock says out loud ────────────────────────────────────────────
  const canPlay = !!roster?.length && total > 0;
  const status = (() => {
    if (state.phase === "error") return state.error ?? "narration failed";
    // A remote plan that failed to load is the FIRST thing to say: the visitor
    // followed a link that promised this specific reading.
    if (notice) return notice;
    if (rosterError) return rosterError;
    if (!total) return "there is nothing to read here";
    if (!roster && state.open) return "loading narrators…";
    // While LOADING, `source` still describes the sentence that just finished —
    // so it says nothing about this one. Claiming "cued" off a stale flag would
    // be the dock's one small lie.
    if (state.phase === "loading") return "cueing this sentence…";
    if (state.phase === "playing") return SOURCE_COPY[source];
    if (state.phase === "paused") return "paused";
    // Stated BEFORE the cache warning, and instead of it: "every listen
    // re-renders" is simply false on a baked page, and a warning that is false
    // is worse than no warning.
    if (manifest) {
      return `ready — this page was baked with ${manifest.character_name}, so it costs no engine`;
    }
    if (!cacheAvailable()) return "ready — this browser cannot cache audio, every listen re-renders";
    return cached > 0 ? `ready — ${cached} sentence${cached === 1 ? "" : "s"} cached` : "ready when you are";
  })();

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
            <div
              className="glass-panel rounded-3xl p-4"
              style={{ boxShadow: `0 24px 70px -30px ${accent}, inset 0 0 0 1px hsl(0 0% 100% / 0.04)` }}
            >
              {/* header */}
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-jetbrains text-[10px] uppercase tracking-[0.2em] text-cyan-300/80">
                    audible docs
                  </div>
                  <h2 className="font-instrument mt-0.5 truncate text-lg leading-tight text-white">
                    {route.title}
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => toggleOpen(false)}
                  aria-label="Collapse the narration dock"
                  aria-expanded
                  className="shrink-0 cursor-pointer rounded-full border border-white/12 px-2 py-1 text-[12px] leading-none text-white/60 transition hover:bg-white/5 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2"
                  style={{ outlineColor: accent }}
                >
                  ▾
                </button>
              </div>

              {/* what is being said, right now */}
              <div className="mt-3 min-h-[3.5rem] rounded-2xl border border-white/8 bg-black/30 px-3 py-2.5">
                <div className="font-jetbrains flex items-center justify-between text-[10px] uppercase tracking-[0.16em] text-white/45">
                  <span className="truncate">{step?.block.label ?? "—"}</span>
                  <span className="shrink-0 tabular-nums">
                    {total ? `${Math.min(state.index + 1, total)}/${total}` : "0/0"}
                  </span>
                </div>
                <p className="mt-1.5 line-clamp-2 text-[13px] leading-snug text-white/85">
                  {step?.sentence ?? "Nothing to read on this page."}
                </p>
              </div>

              {/* progress — transform-only, so it costs no layout */}
              <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/10" aria-hidden>
                <span
                  className="block h-full origin-left rounded-full"
                  style={{
                    background: `linear-gradient(90deg, ${accent}88, ${accent})`,
                    transform: `scaleX(${progress})`,
                    transition: "transform 300ms var(--gt-ease)",
                  }}
                />
              </div>

              {/* transport */}
              <div className="mt-3 flex items-center gap-2">
                <button
                  ref={playRef}
                  type="button"
                  onClick={onPlayPause}
                  disabled={!canPlay}
                  aria-label={state.phase === "playing" ? "Pause the narration" : "Play the narration"}
                  aria-pressed={state.phase === "playing"}
                  className="grid h-10 w-10 shrink-0 cursor-pointer place-items-center rounded-full text-[13px] text-slate-950 transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
                  style={{ background: accent, outlineColor: accent }}
                >
                  {state.phase === "playing" ? "❙❙" : busy ? "…" : "▶"}
                </button>
                <TransportButton label="Previous sentence" onClick={() => dispatch({ t: "prev" })} disabled={!canPlay || state.index === 0}>
                  ⏮
                </TransportButton>
                <TransportButton label="Next sentence" onClick={() => dispatch({ t: "next", total })} disabled={!canPlay}>
                  ⏭
                </TransportButton>
                <TransportButton label="Stop the narration" onClick={() => dispatch({ t: "stop" })} disabled={!live}>
                  ■
                </TransportButton>
                <span aria-hidden className="ml-auto flex h-5 items-end gap-[3px] opacity-70">
                  <EqBars bars={6} height={20} />
                </span>
              </div>

              {/* narrator */}
              <label className="mt-3 block">
                <span className="font-jetbrains text-[10px] uppercase tracking-[0.16em] text-white/45">
                  narrator
                </span>
                <select
                  value={chosen}
                  onChange={(e) => chooseNarrator(e.target.value)}
                  disabled={!roster?.length}
                  className="font-jetbrains mt-1 w-full cursor-pointer rounded-xl border border-white/12 bg-black/40 px-3 py-2 text-[12px] text-white/85 focus:border-cyan-400/40 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <option value={AUTO_NARRATOR}>auto — one voice per section</option>
                  {(roster ?? []).map((c) => (
                    <option key={c.character_id} value={c.character_id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>

              {/* honest status — never a bare spinner */}
              <div className="mt-2.5 flex items-start justify-between gap-3">
                <p
                  role="status"
                  aria-live="polite"
                  className={`font-jetbrains text-[11px] leading-relaxed ${
                    state.phase === "error" || rosterError ? "text-amber-300/90" : "text-white/50"
                  }`}
                >
                  {status}
                </p>
                {cached > 0 && (
                  <button
                    type="button"
                    onClick={clearCache}
                    className="font-jetbrains shrink-0 cursor-pointer text-[10px] uppercase tracking-[0.14em] text-white/35 transition hover:text-white/70 focus-visible:outline-2 focus-visible:outline-offset-2"
                    style={{ outlineColor: accent }}
                  >
                    clear
                  </button>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function TransportButton({
  label, onClick, disabled, children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-full border border-white/12 text-[11px] text-white/70 transition hover:bg-white/5 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-30"
    >
      {children}
    </button>
  );
}
