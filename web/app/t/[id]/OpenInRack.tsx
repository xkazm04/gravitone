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
import { DEFAULT_EXPRESSION } from "@/app/playground/_variants/shared";
import { saveComposer } from "@/lib/composerStore";
import type { SharedTake } from "@/lib/takes";

/** The take id the next publish should be minted as a CHILD of. Read by the
 *  playground's publish path; a session-scoped key, so closing the tab ends the
 *  fork rather than silently attributing a later, unrelated take to a parent. */
export const REMIX_PARENT_KEY = "gravitone.remix.parent";

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
      try {
        sessionStorage.setItem(REMIX_PARENT_KEY, take.id);
      } catch {
        // The fork still works; only its lineage stamp is lost. Not worth
        // refusing the edit over — but not worth claiming either.
      }
      router.push("/playground");
    } catch (e) {
      // saveComposer throws when the composer could NOT be stored. Navigating
      // anyway would drop the user into an untouched composer with no
      // explanation, which is the failure this branch exists to prevent.
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
      {error && <p className="mt-2 text-sm text-rose-300">{error}</p>}
    </div>
  );
}
