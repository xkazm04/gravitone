"use client";

import { useEffect, useState } from "react";
import AppFrame from "@/components/ui/AppFrame";
import { Button, Eyebrow } from "@/components/ui/Primitives";
import { useAuth } from "@/lib/useAuth";

export default function ProfilePage() {
  const { user, profile, loading, ready, signIn, updateProfile } = useAuth();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => { if (profile?.displayName) setName(profile.displayName); }, [profile?.displayName]);

  async function save() {
    setSaving(true); setSaved(false);
    await updateProfile({ displayName: name.trim() || null });
    setSaving(false); setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <AppFrame>
      <div className="py-16">
        <Eyebrow>account</Eyebrow>
        <h1 className="font-instrument mt-4 text-4xl text-white">Profile.</h1>

        {!ready ? (
          <p className="mt-4 text-sm text-white/60">Firebase isn&apos;t configured — set the NEXT_PUBLIC_FIREBASE_* env vars.</p>
        ) : loading ? (
          <p className="mt-4 text-sm text-white/60">Loading…</p>
        ) : !user ? (
          <div className="mt-6">
            <p className="text-base text-white/70">Sign in with Google to view and edit your profile.</p>
            <Button className="mt-4 cursor-pointer" onClick={() => void signIn()}>Sign in with Google</Button>
          </div>
        ) : (
          <div className="mt-8 max-w-lg space-y-5">
            <div className="glass-panel flex items-center gap-4 rounded-2xl p-5">
              {profile?.photoURL ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={profile.photoURL} alt="" className="h-14 w-14 rounded-full" referrerPolicy="no-referrer" />
              ) : (
                <span className="grid h-14 w-14 place-items-center rounded-full bg-cyan-300 text-xl font-semibold text-slate-950">
                  {(profile?.displayName ?? user.email ?? "?").slice(0, 1).toUpperCase()}
                </span>
              )}
              <div>
                <div className="text-lg text-white">{profile?.displayName ?? "—"}</div>
                <div className="font-jetbrains text-[12px] text-white/60">{user.email}</div>
                <span className="font-jetbrains mt-1 inline-block rounded-full border border-cyan-400/30 bg-cyan-400/5 px-2 py-0.5 text-[10px] text-cyan-200">
                  {profile?.plan ?? "free"} plan
                </span>
              </div>
            </div>

            <div className="glass-panel rounded-2xl p-5">
              <label className="block">
                <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">display name</span>
                <input value={name} onChange={(e) => setName(e.target.value)}
                  className="font-hanken mt-2 w-full rounded-xl border border-white/12 bg-white/[0.03] px-4 py-2.5 text-base text-white focus:border-cyan-400/40 focus:outline-none" />
              </label>
              <div className="mt-4 flex items-center gap-3">
                <Button onClick={save} disabled={saving} className="cursor-pointer">{saving ? "Saving…" : "Save"}</Button>
                {saved && <span className="font-jetbrains text-[12px] text-emerald-300">✓ saved to Firestore</span>}
              </div>
            </div>

            <p className="font-jetbrains text-[11px] text-white/50">
              Stored in Firestore <span className="text-white/70">users/{user.uid}</span>
            </p>
          </div>
        )}
      </div>
    </AppFrame>
  );
}
