"use client";

import { useEffect, useRef, useState, type Dispatch } from "react";
import { loadRoster } from "@/app/voices/_data/characters";
import { useMounted } from "@/lib/useMounted";
import type { Action, Character, Phase } from "./machine";

/**
 * Who this flow can extend, and the character it was opened FROM.
 *
 * The two are one hook because the second depends on the first: an `?extend=`
 * param is only real once the roster has answered, and "we could not read the
 * roster" and "that character is not yours" are different sentences.
 */
export function useCloneRoster(phase: Phase, dispatch: Dispatch<Action>) {
  const mounted = useMounted();
  const [characters, setCharacters] = useState<Character[]>([]);
  // An empty `characters` means "you have nothing to extend"; this means "we
  // could not find out". The two must not render the same.
  const [rosterFailed, setRosterFailed] = useState(false);

  // Cloneable characters change rarely; fetch on mount — plus once more when a
  // commit completes, so "scan another" offers the just-created character by
  // name in the extend dropdown instead of a stale list.
  //
  // This goes through loadRoster (the shared data layer) like every other
  // roster read. It used to be a third, private apiJson("/api/characters")
  // whose .catch set [] — so a failed read was rendered as "you have no
  // characters to extend", and the module comment claiming the duplicates were
  // consolidated was false. A failure now SAYS so, next to the control it
  // disables.
  const atUpload = phase === "upload";
  const atComplete = phase === "complete";
  const [rosterLoaded, setRosterLoaded] = useState(false);
  useEffect(() => {
    if (!atUpload && !atComplete) return;
    const ctrl = new AbortController();
    void loadRoster(ctrl.signal)
      .then((cs) => {
        if (!mounted.current) return;
        setCharacters(cs.filter((c) => c.category === "cloned"));
        setRosterFailed(false);
        setRosterLoaded(true);
      })
      .catch(() => {
        // An abort is this effect being replaced, not a failure.
        if (ctrl.signal.aborted || !mounted.current) return;
        setRosterFailed(true);
      });
    return () => ctrl.abort();
  }, [atUpload, atComplete, mounted]);

  // ── the clone loop's inbound leg ────────────────────────────────────────────
  // /voices/new?extend={character_id} — arrived from a character's own page.
  // The param only ARMS the flow; it is applied once the roster has actually
  // answered, because "extend" is only real for a character that exists and is
  // cloneable. A param naming something the roster does not have is SAID (the
  // flow silently falling back to "New character" would create a second
  // character with the same name), and a roster that could not be read says
  // that instead — the two are different facts and never share a message.
  const [fromCid, setFromCid] = useState<string | null>(null);
  const [fromUnknown, setFromUnknown] = useState<string | null>(null);
  const preselected = useRef(false);
  useEffect(() => {
    const want = new URLSearchParams(window.location.search).get("extend");
    if (want) setFromCid(want);
  }, []);
  useEffect(() => {
    if (preselected.current || !fromCid || !rosterLoaded) return;
    preselected.current = true;
    if (characters.some((c) => c.character_id === fromCid)) {
      dispatch({ type: "SET_MODE", mode: "extend" });
      dispatch({ type: "SET_EXTEND_CID", cid: fromCid });
    } else {
      setFromUnknown(fromCid);
    }
  }, [fromCid, rosterLoaded, characters, dispatch]);
  // The character this flow will return to, by name — only once it is genuinely
  // armed, so the completion screen never promises a destination it invented.
  const returningTo = fromCid && !fromUnknown
    ? characters.find((c) => c.character_id === fromCid)?.name ?? null
    : null;

  return { characters, rosterFailed, rosterLoaded, fromCid, fromUnknown, returningTo };
}
