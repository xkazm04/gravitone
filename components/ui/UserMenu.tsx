"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { useAuth } from "@/lib/useAuth";
import { Button } from "./Primitives";

export default function UserMenu() {
  const { user, profile, loading, ready, signIn, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  if (!ready) {
    return <span className="font-jetbrains text-[11px] text-white/40">auth off</span>;
  }
  if (loading) {
    return <span className="font-jetbrains text-[11px] text-white/50">…</span>;
  }
  if (!user) {
    return (
      <Button variant="ghost" className="cursor-pointer px-4 py-1.5" onClick={() => void signIn()}>
        Sign in
      </Button>
    );
  }

  const initial = (profile?.displayName ?? user.email ?? "?").slice(0, 1).toUpperCase();

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex cursor-pointer items-center gap-2 rounded-full border border-white/12 py-1 pl-1 pr-3 transition hover:border-white/25">
        {profile?.photoURL ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={profile.photoURL} alt="" className="h-7 w-7 rounded-full" referrerPolicy="no-referrer" />
        ) : (
          <span className="grid h-7 w-7 place-items-center rounded-full bg-cyan-300 text-sm font-semibold text-slate-950">{initial}</span>
        )}
        <span className="max-w-[120px] truncate text-sm text-white/90">{profile?.displayName ?? user.email}</span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.16 }}
            className="glass-panel absolute right-0 top-full z-50 mt-2 w-56 rounded-xl p-2"
          >
            <div className="px-3 py-2">
              <div className="truncate text-sm text-white">{profile?.displayName}</div>
              <div className="font-jetbrains truncate text-[11px] text-white/55">{user.email}</div>
              <span className="font-jetbrains mt-1 inline-block rounded-full border border-cyan-400/30 bg-cyan-400/5 px-2 py-0.5 text-[10px] text-cyan-200">
                {profile?.plan ?? "free"} plan
              </span>
            </div>
            <div className="my-1 h-px bg-white/8" />
            <Link href="/profile" onClick={() => setOpen(false)} className="block rounded-lg px-3 py-2 text-sm text-white/80 transition hover:bg-white/5">Profile</Link>
            <button onClick={() => void signOut()} className="w-full cursor-pointer rounded-lg px-3 py-2 text-left text-sm text-white/80 transition hover:bg-white/5">Sign out</button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
