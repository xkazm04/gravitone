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
import { type SharedTake } from "@/lib/takes";
import { readDetail } from "@/lib/apiFetch";
import { useMounted } from "@/lib/useMounted";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import {
  castLines, MAX_REPERFORM_LINES, MAX_REPERFORM_TEXT, type CastLine,
} from "./reperformLines";

export { castLines, MAX_REPERFORM_LINES, MAX_REPERFORM_TEXT } from "./reperformLines";
export type { CastLine } from "./reperformLines";

type Result = { take_id: string; single_voice?: boolean; notice?: string | null };

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
  // The take's cast, decided once from what it actually recorded. A take with
  // two or more named speakers is re-performed LINE BY LINE, each in its own
  // voice; anything else is one voice and says so.
  const [lines, setLines] = useState<CastLine[]>(() => castLines(take));
  const [text, setText] = useState(take.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [child, setChild] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A render is up to three minutes long — the longest await on this page by an
  // order of magnitude, and the one most likely to outlive the visitor's
  // interest in it. The sibling useTakeTransport has always guarded its own.
  const mounted = useMounted();

  // The publisher's decision. Absent (every take published before the toggle
  // existed) reads as NO — an unanswered consent question is not a yes.
  if (!take.allow_reperform) return null;

  const cast = lines.length > 0;
  const used = cast ? lines.reduce((n, l) => n + l.text.length, 0) : text.length;
  const overLines = cast && lines.length > MAX_REPERFORM_LINES;
  const tooLong = used > MAX_REPERFORM_TEXT;
  const empty = cast
    ? lines.every((l) => l.text.trim().length === 0)
    : text.trim().length === 0;
  const voices = cast ? new Set(lines.map((l) => l.characterId)).size : 1;

  async function render() {
    if (busy || tooLong || empty || overLines) return;
    setBusy(true);
    setError(null);
    setChild(null);
    setNotice(null);
    try {
      const r = await fetch(`/t/${encodeURIComponent(take.id)}/reperform`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Exactly one of the two forms — the service refuses both at once by
        // name, and sending an unused empty field would be that request.
        body: JSON.stringify(cast
          ? { lines: lines
              .filter((l) => l.text.trim())
              .map((l) => ({ character_id: l.characterId, text: l.text.trim() })) }
          : { text }),
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
        if (!mounted.current) return;
        setError((detail ?? (r.status === 503
          ? "Gravitone backend unreachable"
          : "this re-perform could not be rendered")) + wait);
        return;
      }
      const body = (await r.json()) as Result;
      if (!mounted.current) return;
      setChild(body.take_id);
      // The service says whether the result really is one voice, and why. A
      // legacy take flattened into its one named Character is exactly the
      // event this sentence exists for.
      setNotice(body.notice ?? null);
    } catch {
      if (mounted.current) setError("this re-perform could not be sent — the studio may be offline");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <section className="glass-panel mt-4 rounded-2xl p-5">
      <div className="font-jetbrains text-[11px] uppercase tracking-widest text-cyan-300/80">
        re-perform this
      </div>
      {/* WHAT will actually happen, before anything is typed. The old sentence
          promised "the same voice" for every take — including a published
          ensemble, whose entire cast the render then collapsed into its first
          speaker with no notice anywhere. */}
      {cast ? (
        <p className="mt-1 text-sm text-white/70">
          This take was published open for re-performance, with a cast of {voices} voices.
          Change any line — or one <span className="font-jetbrains text-cyan-300">[emotion]</span>{" "}
          tag — and each line is rendered in its OWN Character&apos;s voice, in this order. It
          becomes a take of its own, filed as this one&apos;s child.
        </p>
      ) : (
        <p className="mt-1 text-sm text-white/70">
          {take.character_name} was published open for re-performance. Change the words — or one{" "}
          <span className="font-jetbrains text-cyan-300">[emotion]</span> tag — and render a new
          version. It becomes a take of its own, filed as this one&apos;s child.
        </p>
      )}

      {!cast && (
        // The honest sentence for every non-cast take, legacy ensembles
        // included: this take records ONE Character, so one voice is all this
        // page can perform with — and it cannot tell whether the original had
        // more.
        <ErrorBanner severity="warning" className="mt-3">
          This renders as ONE voice — {take.character_name}. This take carries no per-line cast,
          so if the original had more than one speaker, that is not preserved here.
        </ErrorBanner>
      )}

      {cast ? (
        <div className="mt-3 space-y-2">
          {lines.map((l, i) => (
            <div key={i}>
              <label htmlFor={`reperform-line-${i}`}
                className="font-jetbrains mb-1 block text-[11px] text-cyan-200/80">
                {l.name}
              </label>
              <textarea
                id={`reperform-line-${i}`}
                value={l.text}
                onChange={(e) => setLines((cur) =>
                  cur.map((c, j) => (j === i ? { ...c, text: e.target.value } : c)))}
                rows={2}
                disabled={busy}
                className="font-jetbrains w-full resize-y rounded-xl border border-white/15 bg-black/30 p-3 text-sm text-white/85 outline-none transition focus:border-cyan-400/40 disabled:opacity-60"
              />
            </div>
          ))}
        </div>
      ) : (
        <>
          <label htmlFor="reperform-text" className="sr-only">Text to re-perform</label>
          <textarea
            id="reperform-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            disabled={busy}
            className="font-jetbrains mt-3 w-full resize-y rounded-xl border border-white/15 bg-black/30 p-3 text-sm text-white/85 outline-none transition focus:border-cyan-400/40 disabled:opacity-60"
          />
        </>
      )}

      {overLines && (
        <ErrorBanner severity="error" className="mt-3">
          This take has {lines.length} speaker turns; a public re-perform is capped at{" "}
          {MAX_REPERFORM_LINES}. Open it in the studio to re-perform the whole scene.
        </ErrorBanner>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <span className={`font-jetbrains text-[11px] ${tooLong ? "text-rose-300" : "text-white/45"}`}>
          {used} / {MAX_REPERFORM_TEXT} characters
          {cast && ` · ${lines.length} line${lines.length === 1 ? "" : "s"}`}
        </span>
        <button
          onClick={() => void render()}
          disabled={busy || tooLong || empty || overLines}
          title={tooLong
            ? `A public re-perform is capped at ${MAX_REPERFORM_TEXT} characters`
            : cast
              ? "Render each line in its own Character's voice on the machine serving this page"
              : "Render these words in this voice on the machine serving this page"}
          className="font-jetbrains cursor-pointer rounded-full border border-cyan-400/40 bg-cyan-400/10 px-4 py-2 text-[12px] text-cyan-200 transition hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "rendering..." : "render this take →"}
        </button>
      </div>

      {/* The honest disclosure, always on screen: this is someone else's CPU
          and the fork is public.
          "per visitor" was the lie: the budget is per ADDRESS, and on a
          default deploy every visitor arrives through this studio's own
          server, so one address is all of us (service/ratelimit.py honours
          X-Forwarded-For only under TTS_TRUST_PROXY — see the sibling
          reperform/route.ts). Saying "shared" costs nothing and is true in
          both deployments; promising "a few tries per visitor" is a promise
          this page cannot keep. */}
      <p className="font-jetbrains mt-3 text-[11px] text-white/45">
        Rendered on the machine hosting this page, out of a small budget shared with everyone else
        here — it can ask you to wait even on a first try. Your version is public and shows where it
        came from; it cannot be re-performed again.
      </p>

      {child && (
        <p className="mt-3 rounded-lg border border-emerald-400/25 bg-emerald-400/5 px-4 py-2 text-sm text-emerald-200/90">
          Rendered.{" "}
          <Link href={`/t/${child}`} className="underline underline-offset-2">
            open your version →
          </Link>
        </p>
      )}
      {notice && <ErrorBanner severity="warning" className="mt-3">{notice}</ErrorBanner>}
      {error && <p role="alert" className="mt-3 text-sm text-rose-300">{error}</p>}
    </section>
  );
}
