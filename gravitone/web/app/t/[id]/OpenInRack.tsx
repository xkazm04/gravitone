"use client";

// "Open this take in the rack" — the share page's fork point.
//
// A shared take already carries the exact metatagged text and the Character
// that performed it, so re-performing it is not new UI: it is the composer the
// studio already has, pre-loaded. The handoff rides the SAME durable composer
// store the playground restores from on mount (lib/composerStore), so nothing
// in the playground has to know this page exists — it restores a session, as it
// always has, and the session happens to be this take.
//
// OWNER-ONLY, deliberately. Re-rendering costs real CPU seconds on the box that
// serves this page, so the affordance appears only for a browser that holds a
// studio API key (the same localStorage slot lib/mintKey writes at sign-in).
// Public re-perform is a separate, rate-limited surface and is NOT this.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DEFAULT_EXPRESSION } from "@/app/playground/_variants/playgroundHelpers";
import { saveComposer, setRemixParent } from "@/lib/composerStore";
import { useMounted } from "@/lib/useMounted";
import type { SharedTake } from "@/lib/takes";
import { ErrorBanner } from "@/components/ui/ErrorBanner";

/** The take id the next publish should be minted as a CHILD of. It lives in
 *  lib/composerStore beside the composer hand-off it travels with — this page
 *  and the playground's publish path used to name the same sessionStorage key
 *  as two separate string literals, which is how the slot came to be written
 *  here and never cleared there. Re-exported so nothing that imports it from
 *  this module has to move. */
export { REMIX_PARENT_KEY } from "@/lib/composerStore";

/** Does this browser hold a studio session? Any `gravitone.apiKey.*` slot means
 *  someone signed in here and minted a key — the same evidence lib/mintKey
 *  leaves. Storage unavailable answers NO: the conservative answer for an
 *  affordance that spends CPU. */
export function hasStudioSession(): boolean {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      if (localStorage.key(i)?.startsWith("gravitone.apiKey.")) return true;
    }
  } catch {
    /* storage unavailable — no session we can prove */
  }
  return false;
}

export default function OpenInRack({ take }: { take: SharedTake }) {
  const router = useRouter();
  // Never during SSR: the answer depends on this browser's storage, and
  // rendering the button on the server would hydrate into a mismatch.
  const [owner, setOwner] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The handoff ends in router.push, so the await it guards is one this
  // component is EXPECTED to be navigated away from.
  const mounted = useMounted();

  useEffect(() => { setOwner(hasStudioSession()); }, []);

  async function openInRack() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await saveComposer({
        text: take.text,
        script: [],
        expr: DEFAULT_EXPRESSION,
        mode: "solo",
        charId: take.character_id,
        activeLine: 0,
      });
      // NOT guarded: neither of these is component state. The stamp and the
      // navigation are the handoff the user asked for, and a user who moved on
      // mid-await still gets the composer they clicked for.
      // The fork still works when storage refuses; only its lineage stamp is
      // lost. Not worth refusing the edit over — but not worth claiming either.
      setRemixParent(take.id);
      router.push("/playground");
    } catch (e) {
      // saveComposer throws when the composer could NOT be stored. Navigating
      // anyway would drop the user into an untouched composer with no
      // explanation, which is the failure this branch exists to prevent.
      if (!mounted.current) return;
      const why = e instanceof Error ? e.message : "storage unavailable";
      setError(`This take could not be loaded into the rack (${why}). Your studio is fine — try opening the playground directly.`);
      setBusy(false);
    }
  }

  if (!owner) return null;

  return (
    <div className="glass-panel mt-4 rounded-2xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-jetbrains text-[11px] uppercase tracking-widest text-cyan-300/80">
            re-perform
          </div>
          <p className="mt-1 text-sm text-white/70">
            Load this take&apos;s script and Character into the composer — change one{" "}
            <span className="font-jetbrains text-cyan-300">[emotion]</span> tag and render a new
            version. The next take you publish is filed as this one&apos;s child.
          </p>
        </div>
        <button
          onClick={() => void openInRack()}
          disabled={busy}
          className="font-jetbrains cursor-pointer rounded-full border border-cyan-400/40 bg-cyan-400/10 px-4 py-2 text-[12px] text-cyan-200 transition hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "opening..." : "open in the rack →"}
        </button>
      </div>
      <p className="font-jetbrains mt-3 text-[11px] text-white/45">
        This replaces whatever is currently in your composer.
      </p>
      {error && <ErrorBanner className="mt-2">{error}</ErrorBanner>}
    </div>
  );
}
