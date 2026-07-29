"use client";

// Copy-once secret reveal. The full key is shown once (create/rotate); after
// dismiss it's gone. Portal to body so it layers above everything.
//
// This is the one screen in the product where losing the text is unrecoverable,
// so it is deliberately hard to leave by accident: no backdrop-click dismiss,
// only the explicit button or Escape. It is also a real dialog — the role, the
// accessible name and the focus trap sit on the panel, not on the backdrop.

import { useCallback, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "@/components/ui/Primitives";
import { EASE } from "@/components/ui/tokens";
import { isStoredSecret } from "@/lib/mintKey";
import { useClientReady } from "@/lib/useMounted";
import { useCopyFeedback } from "@/lib/useCopyFeedback";
import MigrationKit from "./MigrationKit";
import type { ApiKeyWithSecret } from "./data";

export default function SecretReveal({ keyData, onClose }: { keyData: ApiKeyWithSecret | null; onClose: () => void }) {
  // A refused clipboard (permission, insecure context) used to be swallowed
  // while the button kept reading "copy". The shared hook says so instead.
  const { copy, copied, failed, reset } = useCopyFeedback();
  const ready = useClientReady();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => { reset(); }, [keyData, reset]);

  // Escape + a Tab wrap that keeps the keyboard inside the dialog — the same
  // trap EmotionPicker uses. `ready` is a dependency because the portal (and so
  // the panel this focuses) does not exist on the first render.
  const open = keyData !== null;
  useEffect(() => {
    if (!open || !ready) return;
    opener.current = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(panelRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ) ?? []).filter((el) => !el.hasAttribute("disabled"));
    // Focus the panel itself so its label is announced before its controls.
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panelRef.current)) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault(); first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener.current?.focus?.();
    };
  }, [open, ready, onClose]);

  const copySecret = useCallback(() => {
    if (keyData) void copy(keyData.secret);
  }, [copy, keyData]);

  if (!ready) return null;

  // The first-sign-in key is saved in this browser on purpose (see lib/mintKey),
  // so for THAT key "shown once" is a lie. Ask, and say which one this is.
  const reCopyable = keyData ? isStoredSecret(keyData.secret) : false;

  return createPortal(
    <AnimatePresence>
      {keyData && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="fixed inset-0 z-[9999] grid place-items-center bg-black/75 p-4 backdrop-blur-md"
        >
          <motion.div
            ref={panelRef}
            role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
            initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.26, ease: EASE }}
            className="glass-panel max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-3xl p-8 focus:outline-none"
          >
            <div className="font-jetbrains text-[11px] uppercase tracking-widest text-cyan-300/80">save this key now</div>
            <h2 id={titleId} className="font-instrument mt-2 text-2xl text-white">{keyData.name}</h2>
            <p className="mt-2 text-sm text-white/65">
              {reCopyable
                ? "This key is also saved in this browser, so you can re-copy it from your profile or the account menu until you sign out. Anywhere else, this is the only time it is shown — store it somewhere safe."
                : "This is the only time the full secret is shown. Store it somewhere safe — you can rotate it if it leaks."}
            </p>

            <div className="mt-5 flex items-center gap-2 rounded-xl border border-cyan-400/30 bg-black/40 p-3">
              <code className="font-jetbrains flex-1 truncate text-sm text-cyan-200">{keyData.secret}</code>
              <button onClick={copySecret}
                className="font-jetbrains shrink-0 cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-[12px] text-white/85 transition hover:bg-white/5">
                {failed ? "copy blocked — select it" : copied ? "✓ copied" : "copy"}
              </button>
            </div>

            <div className="mt-4 flex flex-wrap gap-1.5">
              {keyData.scopes.map((s) => (
                <span key={s} className="font-jetbrains rounded-full border border-white/12 bg-white/5 px-2.5 py-1 text-[11px] text-white/70">{s}</span>
              ))}
            </div>

            {/* the key-in-hand moment IS the switching moment */}
            <MigrationKit apiKey={keyData.secret} />

            <div className="mt-6 flex justify-end">
              <Button onClick={onClose} className="cursor-pointer">I&apos;ve saved it</Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
