"use client";

import { useState } from "react";
import { checkEmotion } from "@/lib/slugs";

/** Mint a new emotion slot on this Character, and say what it will be called. */
export default function EmotionPalettePanel({
  characterId, addCustomEmotion, onError,
}: {
  characterId: string;
  addCustomEmotion: (name: string) => Promise<void>;
  /** The rack's one banner — the drop-a-slot path writes to it too. */
  onError: (message: string | null) => void;
}) {
  const [custom, setCustom] = useState("");
  const [minting, setMinting] = useState(false);

  // The WHOLE of normalize_emotion (lib/slugs), not just its substitution half:
  // what the panel prints below is now the same verdict the service will reach,
  // so it can never advertise a name the mint request would 400.
  const typed = custom.trim().length > 0;
  const check = checkEmotion(custom);
  const slugPreview = typed && check.ok ? check.slug : "sarcastic";

  async function mint() {
    if (!typed || minting) return;
    // Refused HERE, with the server's own wording, instead of after a round
    // trip. The service still validates — this is the user's optimization.
    if (!check.ok) { onError(check.reason); return; }
    const n = check.slug;
    setMinting(true); onError(null);
    try {
      await addCustomEmotion(n);
      setCustom("");
    } catch (e) {
      onError(e instanceof Error ? e.message : "could not add the slot");
    } finally { setMinting(false); }
  }

  return (
    <div className="glass-panel mt-4 rounded-xl p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">
          extend the palette
        </span>
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void mint()}
          placeholder="sarcastic, battle cry, asmr…"
          maxLength={24}
          aria-invalid={typed && !check.ok}
          aria-describedby="custom-emotion-hint"
          className={`font-hanken w-56 rounded-lg border bg-white/[0.03] px-3 py-1.5 text-sm text-white placeholder:text-white/40 focus:outline-none ${
            typed && !check.ok
              ? "border-rose-400/40 focus:border-rose-400/60"
              : "border-white/12 focus:border-violet-400/40"
          }`}
        />
        <button
          onClick={() => void mint()}
          disabled={!typed || !check.ok || minting}
          title={typed && !check.ok ? check.reason : undefined}
          className="font-jetbrains cursor-pointer rounded-full border border-violet-400/30 bg-violet-400/10 px-3 py-1.5 text-[12px] text-violet-200 transition hover:bg-violet-400/20 disabled:opacity-40"
        >
          {minting ? "adding…" : "+ custom emotion"}
        </button>
      </div>
      {/* Either the address the API will really answer on, or the reason it
          won't — never the first sentence about a name that is the second. */}
      {typed && !check.ok ? (
        <p id="custom-emotion-hint" className="font-jetbrains mt-2 text-[11px] leading-relaxed text-rose-200/90">
          “{custom.trim()}” can’t be an emotion slot — {check.reason}.
        </p>
      ) : (
        <p id="custom-emotion-hint" className="font-jetbrains mt-2 text-[11px] leading-relaxed text-white/45">
          A custom slot is addressable immediately —{" "}
          <span className="text-violet-200">{characterId}:{slugPreview}</span>{" "}
          in the API and <span className="text-violet-200">[{slugPreview}]</span> in metatags — and
          falls back to baseline until you record it. Its glyph is generated from the name.
        </p>
      )}
    </div>
  );
}
