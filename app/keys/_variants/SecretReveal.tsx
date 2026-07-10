"use client";

// Copy-once secret reveal. The full key is shown exactly once (create/rotate);
// after dismiss it's gone. Portal to body so it layers above everything.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "@/components/ui/Primitives";
import { EASE } from "@/components/ui/tokens";
import type { ApiKeyWithSecret } from "./data";

export default function SecretReveal({ keyData, onClose }: { keyData: ApiKeyWithSecret | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => { setCopied(false); }, [keyData]);

  if (!mounted) return null;

  const copy = async () => {
    if (!keyData) return;
    try { await navigator.clipboard.writeText(keyData.secret); setCopied(true); } catch { /* ignore */ }
  };

  return createPortal(
    <AnimatePresence>
      {keyData && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="fixed inset-0 z-[9999] grid place-items-center bg-black/75 p-4 backdrop-blur-md"
          onClick={onClose} role="dialog" aria-modal="true"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.26, ease: EASE }} onClick={(e) => e.stopPropagation()}
            className="glass-panel w-full max-w-lg rounded-3xl p-8"
          >
            <div className="font-jetbrains text-[11px] uppercase tracking-widest text-cyan-300/80">save this key now</div>
            <h2 className="font-instrument mt-2 text-2xl text-white">{keyData.name}</h2>
            <p className="mt-2 text-sm text-white/65">
              This is the only time the full secret is shown. Store it somewhere safe — you can rotate it if it leaks.
            </p>

            <div className="mt-5 flex items-center gap-2 rounded-xl border border-cyan-400/30 bg-black/40 p-3">
              <code className="font-jetbrains flex-1 truncate text-sm text-cyan-200">{keyData.secret}</code>
              <button onClick={copy}
                className="font-jetbrains shrink-0 rounded-lg border border-white/15 px-3 py-1.5 text-[12px] text-white/85 transition hover:bg-white/5">
                {copied ? "✓ copied" : "copy"}
              </button>
            </div>

            <div className="mt-4 flex flex-wrap gap-1.5">
              {keyData.scopes.map((s) => (
                <span key={s} className="font-jetbrains rounded-full border border-white/12 bg-white/5 px-2.5 py-1 text-[11px] text-white/70">{s}</span>
              ))}
            </div>

            <div className="mt-6 flex justify-end">
              <Button onClick={onClose}>I&apos;ve saved it</Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
