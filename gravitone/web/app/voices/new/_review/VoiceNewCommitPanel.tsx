"use client";

import type { Dispatch } from "react";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Button } from "@/components/ui/Primitives";
import { CONSENT_STATEMENT, EXTERNAL_CONSENT_STATEMENT } from "@/lib/consent";
import type { Action, Character } from "../_state/machine";
import type { Pending } from "../_state/useIngestActions";

/** Who this ledger becomes, and everything the user attests to on the way. */
export default function VoiceNewCommitPanel({
  mode, dispatch, characters, rosterFailed, charName, extendCid, selected,
  consented, setConsented, keepCorpus, setKeepCorpus, externalSource,
  pending, commit, startOver,
}: {
  mode: "new" | "extend";
  dispatch: Dispatch<Action>;
  characters: Character[];
  rosterFailed: boolean;
  charName: string;
  extendCid: string;
  selected: Set<string>;
  consented: boolean;
  setConsented: (v: boolean) => void;
  keepCorpus: boolean;
  setKeepCorpus: (v: boolean) => void;
  externalSource: boolean;
  pending: Pending;
  commit: () => void;
  startOver: () => void;
}) {
  return (
    <div className="glass-panel mt-8 rounded-2xl p-5">
      <div className="flex gap-2">
        <button onClick={() => dispatch({ type: "SET_MODE", mode: "new" })} className={`font-jetbrains cursor-pointer rounded-full border px-3 py-1.5 text-[12px] ${mode === "new" ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-white/12 text-white/60"}`}>New character</button>
        <button onClick={() => dispatch({ type: "SET_MODE", mode: "extend" })} disabled={characters.length === 0}
          title={rosterFailed ? "Your existing characters could not be loaded" : undefined}
          className={`font-jetbrains cursor-pointer rounded-full border px-3 py-1.5 text-[12px] disabled:opacity-40 ${mode === "extend" ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-white/12 text-white/60"}`}>Extend existing</button>
      </div>
      {/* Not "you have no characters to extend" — we do not know that. */}
      {rosterFailed && (
        <ErrorBanner className="mt-3">
          Your existing characters could not be loaded, so “Extend existing” is unavailable —
          reload to retry. Creating a new character still works.
        </ErrorBanner>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {mode === "new" ? (
          <input value={charName} onChange={(e) => dispatch({ type: "SET_CHAR_NAME", name: e.target.value })} placeholder="Character name"
            className="font-hanken w-56 rounded-xl border border-white/12 bg-white/[0.03] px-4 py-2.5 text-base text-white placeholder:text-white/40 focus:border-cyan-400/40 focus:outline-none" />
        ) : (
          <select value={extendCid} onChange={(e) => dispatch({ type: "SET_EXTEND_CID", cid: e.target.value })}
            className="font-jetbrains rounded-xl border border-white/12 bg-[#0d1017] px-3 py-2.5 text-[13px] text-white/85 focus:outline-none">
            <option value="">choose character…</option>
            {characters.map((c) => <option key={c.character_id} value={c.character_id}>{c.name}</option>)}
          </select>
        )}
        <Button onClick={commit} disabled={selected.size === 0 || !consented || pending !== null} className="ml-auto cursor-pointer">
          {pending === "commit"
            ? "Starting…"
            : `${mode === "new" ? "Create character" : "Add to character"} (${selected.size})`}
        </Button>
      </div>
      {/* The way out. Review is where a user spends the most time and
          it was the one phase with no exit at all: a commit that failed
          landed back HERE, and the only escape from a ledger the user
          had given up on was reloading the page by hand. */}
      <button onClick={startOver}
        className="font-jetbrains mt-3 cursor-pointer text-[11px] text-white/45 underline decoration-dotted underline-offset-4 transition hover:text-white">
        start over with a different recording
      </button>
      {/* The attestation says what is TRUE of this recording. For a
          pasted link, "I own this voice" is a sentence the user cannot
          honestly tick — the video is someone else's — so a different
          one is shown, and it is the one the backend requires verbatim
          for a link-sourced job. Neither is optional; the checkbox
          still gates the commit either way. */}
      <label className="mt-4 flex max-w-2xl cursor-pointer items-start gap-2 text-[13px] text-white/70">
        <input type="checkbox" checked={consented} onChange={(e) => setConsented(e.target.checked)}
          className="mt-0.5 accent-cyan-300" />
        <span>
          {externalSource ? EXTERNAL_CONSENT_STATEMENT : CONSENT_STATEMENT}{" "}
          <span className="font-jetbrains text-[11px] text-white/45">
            (attestation stored with the voices — Voice Vault
            {externalSource ? ", together with the link it came from" : ""})
          </span>
        </span>
      </label>
      {externalSource && (
        <p className="font-jetbrains mt-2 max-w-2xl text-[11px] leading-relaxed text-white/45">
          This recording was fetched from a link, not recorded by you. Cloning a
          voice from someone else&apos;s published audio may need their permission
          — this attestation is stored with the voices and names the source video.
        </p>
      )}
      {/* Retention, opt-IN, and asked here because this is the consent
          moment. Off means the recording is used to clone and then
          discarded with the rest of the scan workdir; on means this box
          keeps the audio and its labels for the character, under the
          attestation above. Everything the checkbox promises is
          inspectable and deletable from the character page, which is the
          only thing that makes keeping it defensible. */}
      <label className="mt-3 flex max-w-2xl cursor-pointer items-start gap-2 border-t border-white/8 pt-3 text-[13px] text-white/70">
        <input type="checkbox" checked={keepCorpus} onChange={(e) => setKeepCorpus(e.target.checked)}
          className="mt-0.5 accent-emerald-300" />
        <span>
          Keep this recording for the character on this machine.{" "}
          <span className="font-jetbrains text-[11px] leading-relaxed text-white/45">
            The audio, its segment labels and the attestation above are stored
            on this Gravitone box — never uploaded anywhere — so the voices can
            be rebuilt from it later, and improved as more recordings arrive.
            You can list and delete it, one recording at a time, from the
            character page. Leave it off and nothing of the recording survives
            the clone.
          </span>
        </span>
      </label>
    </div>
  );
}
