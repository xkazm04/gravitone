"use client";

// RACK — operations metaphor, the sibling of the Character table. One dense row
// per emotion slot: status, sample, voice id, added, actions. Space-efficient and
// practical; every slot is visible at once with no scrolling or spatial hunting.

import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { Fragment, useState } from "react";
import { useVoicePreview, relTime, pickAudio, deleteVoiceQuestion, type Slot } from "@/app/voices/_data/characters";
import { checkEmotion } from "@/lib/slugs";
import EmotionArt from "@/components/ui/EmotionArt";

export default function EmotionRack({
  name, characterId, slots, coverage, total, busySlot, addVoice, removeVoice, onRecord,
  addCustomEmotion, removeCustomEmotion, removingVoiceId = null,
}: {
  name: string;
  // The address the API actually answers on. Previously derived from `name` by
  // collapsing whitespace, which printed "mary-o'brien" for "Mary O'Brien" — a
  // copy-pasteable address that 404s. The server already told us the id; use it.
  characterId: string;
  slots: Slot[]; coverage: number; total: number; busySlot: string | null;
  addVoice: (emotion: string, f: File) => void; removeVoice: (id: string) => void;
  onRecord: (emotion: string) => void; // open the guided capture session
  addCustomEmotion: (name: string) => Promise<void>;
  removeCustomEmotion: (emotion: string) => Promise<void>;
  /** The voice whose DELETE is in flight — its remove button stops taking
   *  clicks instead of firing a second request behind the first. */
  removingVoiceId?: string | null;
}) {
  const { preview, playingId, busyId, failedId, failedReason } = useVoicePreview();
  const [custom, setCustom] = useState("");
  const [minting, setMinting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const missing = total - coverage;
  // Voices sharing a slot with the one that speaks. The registry tolerates them
  // so they can be deleted; coverage counts DISTINCT emotions, so without this
  // line nothing on the page would even hint they exist.
  const shadowed = slots.reduce((n, s) => n + Math.max(0, s.voices.length - 1), 0);

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
    if (!check.ok) { setErr(check.reason); return; }
    const n = check.slug;
    setMinting(true); setErr(null);
    try {
      await addCustomEmotion(n);
      setCustom("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not add the slot");
    } finally { setMinting(false); }
  }

  /** Ask before destroying a cloned embedding.
   *
   *  Removing a Voice was the only single-click destruction on this page, next
   *  to a consent gate and an import rename that both stop and ask. It names
   *  the Character, the slot and the id, because "remove" on a dense rack of
   *  rows is otherwise a click whose target the user infers from the cursor. */
  function confirmRemove(voiceId: string, label: string, shadowed = false) {
    if (!window.confirm(deleteVoiceQuestion(name, label, voiceId, shadowed))) return;
    removeVoice(voiceId);
  }

  async function dropSlot(emotion: string) {
    setErr(null);
    try { await removeCustomEmotion(emotion); }
    catch (e) { setErr(e instanceof Error ? e.message : "could not remove the slot"); }
  }

  return (
    <div className="py-4">
      <div className="font-jetbrains mb-3 flex items-center justify-between text-[11px] uppercase tracking-widest text-white/60">
        <span>emotion rack</span>
        <span>
          {coverage}/{total} recorded{missing > 0 && <span className="ml-2 text-amber-300/70">· {missing} fall back to baseline</span>}
          {shadowed > 0 && (
            <span
              className="ml-2 text-amber-300/70"
              title="Two voices occupy one slot. Only the first speaks; remove one to resolve it."
            >
              · {shadowed} shadowed
            </span>
          )}
        </span>
      </div>

      {err && <ErrorBanner className="mb-3">{err}</ErrorBanner>}

      <div className="glass-panel overflow-x-auto rounded-xl">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead className="border-b border-white/8">
            <tr className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">
              <th className="w-10 px-2 py-2" />
              <th className="px-3 py-2 text-left font-normal">emotion</th>
              <th className="px-3 py-2 text-left font-normal">status</th>
              <th className="px-3 py-2 text-left font-normal">sample</th>
              <th className="px-3 py-2 text-left font-normal">voice id</th>
              <th className="px-3 py-2 text-left font-normal">added</th>
              <th className="w-40 px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {slots.map((s) => {
              const filled = !!s.voice;
              const isPlaying = filled && playingId === s.voice!.voice_id;
              const isBusy = busySlot === s.emotion || (filled && busyId === s.voice!.voice_id);
              const previewFailed = filled && failedId === s.voice!.voice_id;
              // Extra voices registered on the same emotion. They never speak,
              // but they are real rows in the registry — each gets its own line
              // (and its own remove button) or it cannot be deleted at all.
              const shadows = s.voices.slice(1);

              return (
                <Fragment key={s.emotion}>
                <tr className={`border-b border-white/5 transition hover:bg-white/[0.03] ${!filled ? "opacity-70" : ""}`}>
                  <td className="px-2 py-2">
                    <button
                      onClick={() => (filled ? preview(s.voice!.voice_id, `${name} ${s.emotion}`) : onRecord(s.emotion))}
                      disabled={isBusy}
                      aria-label={filled ? `Play ${s.label}` : `Record ${s.label}`}
                      className={`grid h-7 w-7 place-items-center rounded-full text-[11px] transition disabled:opacity-50 ${
                        filled ? "text-slate-950 hover:brightness-110" : "border border-dashed border-white/20 text-white/65 hover:border-cyan-400/50 hover:text-cyan-300"
                      }`}
                      style={filled ? { background: `hsl(${s.hue} 85% 64%)` } : undefined}
                    >
                      {isBusy ? "…" : filled ? (isPlaying ? "⏸" : "▶") : "+"}
                    </button>
                  </td>

                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2.5">
                      <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-lg border border-white/8 bg-black/40">
                        <EmotionArt emotion={s.emotion} size={34} dim={!filled} />
                      </span>
                      <span className="text-sm font-medium text-white">{s.label}</span>
                      {filled && (
                        s.voice!.consent ? (
                          <span title="Consent receipt on file for this voice"
                            aria-label="consent receipt on file"
                            className="text-[13px] leading-none text-emerald-300/90">🛡</span>
                        ) : (
                          <span title="No receipt (pre-consent voice)"
                            aria-label="no consent receipt"
                            className="text-[13px] leading-none text-white/25">🛡</span>
                        )
                      )}
                      {s.custom && (
                        <span title="Custom emotion — glyph generated from the name"
                          className="font-jetbrains rounded-full border border-violet-400/30 bg-violet-400/10 px-1.5 py-0.5 text-[10px] text-violet-200">
                          custom
                        </span>
                      )}
                    </div>
                  </td>

                  <td className="px-3 py-2">
                    {filled ? (
                      <span className="flex items-center gap-2">
                        <span className="font-jetbrains rounded bg-cyan-400/10 px-1.5 py-0.5 text-[11px] text-cyan-300">recorded</span>
                        {shadows.length > 0 && (
                          <span
                            title="Two voices occupy this slot — this is the one the engine speaks with"
                            className="font-jetbrains rounded bg-emerald-400/10 px-1.5 py-0.5 text-[11px] text-emerald-300">
                            speaks this slot
                          </span>
                        )}
                        {previewFailed && (
                          // The reason, not just the fact: an unreachable
                          // backend, a 429 and a blocked autoplay are three
                          // different things for the user to do next.
                          <span title={failedReason ?? "The preview could not be synthesized — try again."}
                            className="font-jetbrains rounded bg-rose-400/10 px-1.5 py-0.5 text-[11px] text-rose-300">
                            {`preview failed${failedReason ? ` — ${failedReason}` : ""}`}
                          </span>
                        )}
                      </span>
                    ) : s.demand > 0 ? (
                      <span
                        className="font-jetbrains rounded bg-amber-400/10 px-1.5 py-0.5 text-[11px] text-amber-300"
                        title={`API callers requested ${s.label} ${s.demand}× and got baseline — record it to meet the demand`}
                      >
                        requested {s.demand}× → baseline
                      </span>
                    ) : (
                      <span className="font-jetbrains rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-white/65">→ baseline</span>
                    )}
                  </td>

                  <td className="font-jetbrains px-3 py-2 text-[12px] text-white/60">{filled ? `${s.voice!.sample_seconds ?? "?"}s` : "—"}</td>
                  <td className="font-jetbrains px-3 py-2 text-[12px] text-white/60">{filled ? s.voice!.voice_id : "—"}</td>
                  <td className="font-jetbrains px-3 py-2 text-[12px] text-white/65">{filled ? relTime(s.voice!.created) : "—"}</td>

                  <td className="px-3 py-2 text-right">
                    {filled ? (
                      <button onClick={() => confirmRemove(s.voice!.voice_id, s.label)}
                        disabled={removingVoiceId === s.voice!.voice_id}
                        aria-label={`Remove the ${s.label} voice`}
                        className="font-jetbrains text-[11px] text-white/55 transition hover:text-rose-300 disabled:opacity-40">
                        {removingVoiceId === s.voice!.voice_id ? "removing…" : "remove"}
                      </button>
                    ) : (
                      <>
                        <button onClick={() => onRecord(s.emotion)} disabled={isBusy}
                          className="font-jetbrains text-[11px] text-cyan-300/80 transition hover:text-cyan-200 disabled:opacity-50">
                          {isBusy ? "cloning…" : "● record this"}
                        </button>
                        <button onClick={() => pickAudio((f) => addVoice(s.emotion, f))} disabled={isBusy}
                          className="font-jetbrains ml-3 text-[11px] text-white/45 transition hover:text-white/80 disabled:opacity-50">
                          upload
                        </button>
                        {s.custom && (
                          <button onClick={() => void dropSlot(s.emotion)} disabled={isBusy}
                            title="Remove this custom slot"
                            className="font-jetbrains ml-3 text-[11px] text-white/35 transition hover:text-rose-300 disabled:opacity-50">
                            drop
                          </button>
                        )}
                      </>
                    )}
                  </td>
                </tr>

                {shadows.map((v) => {
                  const vBusy = busyId === v.voice_id;
                  return (
                    <tr key={v.voice_id} className="border-b border-white/5 bg-amber-400/[0.03] transition hover:bg-white/[0.03]">
                      <td className="px-2 py-2">
                        <button
                          onClick={() => preview(v.voice_id, `${name} ${s.emotion}`)}
                          disabled={vBusy}
                          aria-label={`Play the shadowed ${s.label} voice`}
                          className="grid h-7 w-7 place-items-center rounded-full border border-amber-300/40 text-[11px] text-amber-200 transition hover:bg-amber-400/10 disabled:opacity-50"
                        >
                          {vBusy ? "…" : playingId === v.voice_id ? "⏸" : "▶"}
                        </button>
                      </td>

                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2.5 pl-4">
                          <span className="font-jetbrains text-[12px] text-white/40">↳</span>
                          <span className="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-lg border border-white/8 bg-black/40">
                            <EmotionArt emotion={s.emotion} size={26} dim />
                          </span>
                          <span className="text-sm text-white/70">{s.label}</span>
                          {v.consent ? (
                            <span title="Consent receipt on file for this voice"
                              aria-label="consent receipt on file"
                              className="text-[13px] leading-none text-emerald-300/90">🛡</span>
                          ) : (
                            <span title="No receipt (pre-consent voice)"
                              aria-label="no consent receipt"
                              className="text-[13px] leading-none text-white/25">🛡</span>
                          )}
                        </div>
                      </td>

                      <td className="px-3 py-2">
                        <span className="flex items-center gap-2">
                          <span
                            title={`This slot already had a voice when this one was registered, so ${s.label} is spoken by ${s.voice!.voice_id}. Remove one of them to resolve the duplicate.`}
                            className="font-jetbrains rounded bg-amber-400/10 px-1.5 py-0.5 text-[11px] text-amber-300">
                            shadowed · never spoken
                          </span>
                          {failedId === v.voice_id && (
                            <span title={failedReason ?? "The preview could not be synthesized — try again."}
                              className="font-jetbrains rounded bg-rose-400/10 px-1.5 py-0.5 text-[11px] text-rose-300">
                              {`preview failed${failedReason ? ` — ${failedReason}` : ""}`}
                            </span>
                          )}
                        </span>
                      </td>

                      <td className="font-jetbrains px-3 py-2 text-[12px] text-white/60">{v.sample_seconds ?? "?"}s</td>
                      <td className="font-jetbrains px-3 py-2 text-[12px] text-white/60">{v.voice_id}</td>
                      <td className="font-jetbrains px-3 py-2 text-[12px] text-white/65">{relTime(v.created)}</td>

                      <td className="px-3 py-2 text-right">
                        <button onClick={() => confirmRemove(v.voice_id, s.label, true)}
                          disabled={removingVoiceId === v.voice_id}
                          aria-label={`Remove the shadowed ${s.label} voice`}
                          title="Delete this voice — the slot keeps the voice that speaks"
                          className="font-jetbrains text-[11px] text-white/55 transition hover:text-rose-300 disabled:opacity-40">
                          {removingVoiceId === v.voice_id ? "removing…" : "remove"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* custom emotion palette — the scale is a platform primitive, not a constant */}
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
    </div>
  );
}
