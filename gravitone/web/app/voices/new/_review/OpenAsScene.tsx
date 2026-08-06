"use client";

// "Open as scene" — the last step of one video → many characters.
//
// The cast just cloned the people in a recording. The recording also contains
// what they SAID, diarized, already on the box. This loads that dialogue into
// the composer in script mode, each line addressed to the Character of the
// person who spoke it, so the demo finishes where it should: re-perform the
// actual conversation in the cloned voices, then edit the lines.
//
// The hand-off is app/t/[id]/OpenInRack's, deliberately: one write through
// lib/composerStore and a push to /playground. No new storage contract, no new
// share type, and nothing in the playground has to know this screen exists —
// it restores a session on mount, as it always has.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { apiJson } from "@/lib/apiFetch";
import { saveComposer } from "@/lib/composerStore";
import { useMounted } from "@/lib/useMounted";
import { sceneCastSummary, sceneComposer, sceneNotes, type Scene } from "../_state/scene";

type Load =
  | { status: "loading" }
  | { status: "ready"; scene: Scene }
  | { status: "failed"; detail: string };

export default function OpenAsScene({ jobId }: { jobId: string }) {
  const router = useRouter();
  const mounted = useMounted();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void apiJson<Scene>(`/api/ingest/${jobId}/scene`, { cache: "no-store" },
      "the transcript of this recording could not be read")
      .then((scene) => { if (alive) setLoad({ status: "ready", scene }); })
      .catch((e: unknown) => {
        if (!alive) return;
        setLoad({
          status: "failed",
          detail: e instanceof Error ? e.message : "the transcript could not be read",
        });
      });
    return () => { alive = false; };
  }, [jobId]);

  async function open() {
    if (busy || load.status !== "ready") return;
    const state = sceneComposer(load.scene);
    if (!state) return;
    setBusy(true);
    setError(null);
    try {
      await saveComposer(state);
      router.push("/playground");
    } catch (e) {
      // saveComposer throws when the composer could NOT be stored. Navigating
      // anyway would drop the user into an untouched composer with no
      // explanation — the failure this branch exists to prevent.
      const why = e instanceof Error ? e.message : "storage unavailable";
      setError(`This scene could not be loaded into the composer (${why}). Your Characters are fine — open the playground and pick them by hand.`);
      if (mounted.current) setBusy(false);
    }
  }

  const scene = load.status === "ready" ? load.scene : null;
  const lines = scene?.lines ?? [];
  const notes = scene ? sceneNotes(scene) : [];

  return (
    <div className="mt-6 rounded-2xl border border-cyan-400/20 bg-cyan-400/[0.04] p-4">
      <div className="font-jetbrains text-[11px] uppercase tracking-widest text-cyan-300/80">
        the scene
      </div>

      {load.status === "loading" && (
        <p className="font-jetbrains mt-2 text-[12px] text-white/45">
          reading this recording&apos;s dialogue…
        </p>
      )}

      {/* We could not ASK. Different from a scan that has no transcript, so it
          is amber and it says what is unaffected. */}
      {load.status === "failed" && (
        <ErrorBanner severity="warning" className="mt-2">
          {load.detail} — the Characters above were still cast; you can open the
          playground and write their lines yourself.
        </ErrorBanner>
      )}

      {/* The affordance is UNAVAILABLE, and the service says why. Never a dead
          button: a sovereign scan transcribes nothing, and that is a property of
          the mode the user chose, not a failure. */}
      {scene && !scene.available && (
        <p className="mt-1 max-w-2xl text-sm text-white/55">
          This recording can&apos;t be opened as a scene — {scene.reason}. The Characters
          above are ready; write their lines in the playground.
        </p>
      )}

      {scene?.available && lines.length > 0 && (
        <>
          <p className="mt-1 max-w-2xl text-sm text-white/70">
            Re-perform the conversation in the voices you just cloned: {lines.length} line
            {lines.length === 1 ? "" : "s"} of this recording&apos;s own dialogue, each one
            addressed to the Character who said it.
          </p>
          <p className="font-jetbrains mt-2 text-[11px] text-white/50">
            {sceneCastSummary(scene)}
          </p>
          {/* What this hand-off is doing to their dialogue that they did not
              ask for — truncation and omitted speakers, both counted. */}
          {notes.map((n) => (
            <p key={n} className="font-jetbrains mt-1.5 max-w-2xl text-[11px] leading-relaxed text-amber-200/75">
              {n}
            </p>
          ))}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              onClick={() => void open()}
              disabled={busy}
              className="font-jetbrains cursor-pointer rounded-full border border-cyan-400/40 bg-cyan-400/10 px-4 py-2 text-[12px] text-cyan-200 transition hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "opening…" : "open as scene →"}
            </button>
            <span className="font-jetbrains text-[11px] text-white/40">
              this replaces whatever is currently in your composer
            </span>
          </div>
          {error && <p className="mt-2 text-sm text-rose-300">{error}</p>}
        </>
      )}
    </div>
  );
}
