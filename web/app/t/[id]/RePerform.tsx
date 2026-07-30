"use client";

// Public re-perform — the share page's fork point for a visitor with no
// account, no key and no studio.
//
// Distinct from OpenInRack (which hands the take to the OWNER's composer and
// is invisible without a studio session): this renders on the box that serves
// the page, for a stranger. Three things therefore have to be true and visible:
//
//   1. it only exists when the PUBLISHER opted in (take.allow_reperform) —
//      forking puts new words in someone's voice, so consent is theirs;
//   2. it is BOUNDED (a per-IP budget in service/ratelimit.py, a short text
//      cap) and every refusal is shown VERBATIM, including how long a
//      rate-limited visitor must wait;
//   3. the result is a CHILD take with its provenance on the page it lands on,
//      never a silent copy of the original.
//
// One field, one render, one link. No autoplay: the child opens on its own
// share page, where the visitor presses play like everyone else.

import { useState } from "react";
import Link from "next/link";
import type { SharedTake } from "@/lib/takes";
import { readDetail } from "@/lib/apiFetch";

/** The service's own cap (service/takes.py::MAX_REPERFORM_TEXT). Mirrored so
 *  the field can say so BEFORE a visitor spends a request finding out — the
 *  service is still the enforcer, and its "too-long" refusal is what shows if
 *  the two ever drift. */
export const MAX_REPERFORM_TEXT = 1000;

type Result = { take_id: string };

/** The banner a take rendered BY A VISITOR wears on its own share page.
 *
 *  Lineage already says which take this one came from; this says who did it and
 *  on whose machine, which is the part a listener needs to judge what they are
 *  hearing. Renders nothing for any other take, so the page can mount it
 *  unconditionally. Not a client component's job — it is pure text about a
 *  loaded take. It ships from this ("use client") module because it belongs
 *  with the flow that creates such takes; its props are plain JSON, so the
 *  server page can mount it directly. */
export function ReperformProvenance({ take }: { take: SharedTake }) {
  if ((take.derived_from as { kind?: string } | null)?.kind !== "public-reperform") return null;
  return (
    <p className="font-jetbrains mt-4 rounded-xl border border-amber-300/25 bg-amber-300/5 px-4 py-2 text-[11px] text-amber-200/85">
      Re-performed by a visitor: these words were written by someone other than the person who
      published the original take, and rendered by this machine on request.
    </p>
  );
}

export default function RePerform({ take }: { take: SharedTake }) {
  const [text, setText] = useState(take.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [child, setChild] = useState<string | null>(null);

  // The publisher's decision. Absent (every take published before the toggle
  // existed) reads as NO — an unanswered consent question is not a yes.
  if (!take.allow_reperform) return null;

  const tooLong = text.length > MAX_REPERFORM_TEXT;
  const empty = text.trim().length === 0;

  async function render() {
    if (busy || tooLong || empty) return;
    setBusy(true);
    setError(null);
    setChild(null);
    try {
      const r = await fetch(`/t/${encodeURIComponent(take.id)}/reperform`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) {
        // The service names every refusal (not-published-for-reperform,
        // too-long, engine-absent, rate-limited); show its sentence rather
        // than a house-style paraphrase that loses the reason.
        const detail = await readDetail(r);
        const retryAfter = r.headers.get("Retry-After");
        const wait = r.status === 429 && retryAfter
          ? ` Try again in ${retryAfter}s.`
          : "";
        setError((detail ?? (r.status === 503
          ? "Gravitone backend unreachable"
          : "this re-perform could not be rendered")) + wait);
        return;
      }
      const body = (await r.json()) as Result;
      setChild(body.take_id);
    } catch {
      setError("this re-perform could not be sent — the studio may be offline");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="glass-panel mt-4 rounded-2xl p-5">
      <div className="font-jetbrains text-[11px] uppercase tracking-widest text-cyan-300/80">
        re-perform this
      </div>
      <p className="mt-1 text-sm text-white/70">
        {take.character_name} was published open for re-performance. Change the words — or one{" "}
        <span className="font-jetbrains text-cyan-300">[emotion]</span> tag — and render a new
        version in the same voice. It becomes a take of its own, filed as this one&apos;s child.
      </p>

      <label htmlFor="reperform-text" className="sr-only">Text to re-perform</label>
      <textarea
        id="reperform-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        disabled={busy}
        className="font-jetbrains mt-3 w-full resize-y rounded-xl border border-white/15 bg-black/30 p-3 text-sm text-white/85 outline-none transition focus:border-cyan-400/40 disabled:opacity-60"
      />

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <span className={`font-jetbrains text-[11px] ${tooLong ? "text-rose-300" : "text-white/45"}`}>
          {text.length} / {MAX_REPERFORM_TEXT} characters
        </span>
        <button
          onClick={() => void render()}
          disabled={busy || tooLong || empty}
          title={tooLong
            ? `A public re-perform is capped at ${MAX_REPERFORM_TEXT} characters`
            : "Render these words in this voice on the machine serving this page"}
          className="font-jetbrains cursor-pointer rounded-full border border-cyan-400/40 bg-cyan-400/10 px-4 py-2 text-[12px] text-cyan-200 transition hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "rendering..." : "render this take →"}
        </button>
      </div>

      {/* The honest disclosure, always on screen: this is someone else's CPU
          and the fork is public. */}
      <p className="font-jetbrains mt-3 text-[11px] text-white/45">
        Rendered on the machine hosting this page — a few tries per visitor, then it asks you to
        wait. Your version is public and shows where it came from; it cannot be re-performed again.
      </p>

      {child && (
        <p className="mt-3 rounded-lg border border-emerald-400/25 bg-emerald-400/5 px-4 py-2 text-sm text-emerald-200/90">
          Rendered.{" "}
          <Link href={`/t/${child}`} className="underline underline-offset-2">
            open your version →
          </Link>
        </p>
      )}
      {error && <p role="alert" className="mt-3 text-sm text-rose-300">{error}</p>}
    </section>
  );
}
