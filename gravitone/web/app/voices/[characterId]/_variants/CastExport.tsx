"use client";

// Hand this Character's whole cast to the code that ships: every Voice's id and
// address, its emotion, and the metatag vocabulary — as JSON, downloaded or
// copied. Built entirely from the Character already on screen (see _data/cast.ts
// for why there is no API route behind this).

import { useMemo, useState } from "react";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { useCopyFeedback } from "@/lib/useCopyFeedback";
import type { Character } from "@/app/voices/_data/characters";
import { buildCastManifest, castFilename, castManifestJson } from "@/app/voices/_data/cast";

export default function CastExport({ character }: { character: Character }) {
  // `exported_at` is stamped when the panel mounts rather than per click, so the
  // preview, the copy and the download are the SAME document — a timestamp that
  // moved between "copy" and "download" would make two exports of one cast look
  // like two different casts.
  const json = useMemo(() => castManifestJson(character), [character]);
  const manifest = useMemo(() => buildCastManifest(character), [character]);
  const { copy, copied, failed } = useCopyFeedback();
  // A download can fail (blocked object URLs, no filesystem). It is a user
  // action, so it says so rather than doing nothing visible.
  const [downloadError, setDownloadError] = useState<string | null>(null);

  function download() {
    setDownloadError(null);
    let url: string | null = null;
    try {
      url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = castFilename(character);
      a.click();
    } catch (e) {
      setDownloadError(
        `${e instanceof Error ? e.message : "the download was blocked"} — the file was not `
        + "saved. Copy the JSON instead.",
      );
    } finally {
      // Revoked on the next frame: revoking synchronously can cancel the
      // download the click just started in some browsers.
      const made = url;
      if (made) setTimeout(() => URL.revokeObjectURL(made), 0);
    }
  }

  const n = manifest.voices.length;
  const missing = manifest.falls_back_to_baseline.length;

  return (
    <div className="glass-panel mt-8 rounded-2xl p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">
          export this cast
        </span>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={download}
            className="font-jetbrains cursor-pointer rounded-lg border border-cyan-400/30 bg-cyan-400/5 px-3 py-1.5 text-[12px] text-cyan-200 transition hover:bg-cyan-400/10"
          >
            ⇓ download {castFilename(character)}
          </button>
          <button
            onClick={() => copy(json)}
            className="font-jetbrains cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-[12px] text-white/85 transition hover:bg-white/5"
          >
            {failed ? "copy blocked" : copied ? "✓ copied" : "copy JSON"}
          </button>
        </div>
      </div>
      <p className="mt-2 text-[13px] text-white/60">
        {n === 0 ? (
          <>
            No voices to export yet — this Character has no cloned Voice, so there is no
            address to call. The manifest below is its identity only.
          </>
        ) : (
          <>
            {n} voice{n === 1 ? "" : "s"} with the ids, <span className="text-white/80">character:emotion</span>{" "}
            addresses and emotion vocabulary needed to call{" "}
            <span className="font-jetbrains text-white/80">POST /v1/text-to-speech/{"{voice_id}"}</span>.
            {missing > 0 && (
              <> {missing} slot{missing === 1 ? "" : "s"} on this Character&apos;s scale
              {missing === 1 ? " has" : " have"} no voice and {missing === 1 ? "is" : "are"} listed
              as falling back to baseline.</>
            )}{" "}
            No audio and no embeddings — for those, use the{" "}
            <span className="text-white/80">export pack</span> above.
          </>
        )}
      </p>
      {downloadError && <ErrorBanner className="mt-3">{downloadError}</ErrorBanner>}
      <pre className="font-jetbrains mt-3 max-h-72 overflow-auto rounded-xl border border-white/8 bg-black/40 p-4 text-[12px] leading-relaxed text-cyan-100/90">
        {json}
      </pre>
    </div>
  );
}
