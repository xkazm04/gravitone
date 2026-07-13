"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import AppFrame from "@/components/ui/AppFrame";
import { Button, Eyebrow } from "@/components/ui/Primitives";
import { useAuth } from "@/lib/useAuth";
import { getStoredKey, mintDefaultKey, type StoredKey } from "@/lib/mintKey";
import { migrationSnippet, SNIPPET_LANGS, type SnippetLang } from "@/lib/switchkit";
import MyVoices from "./MyVoices";

export default function ProfilePage() {
  const { user, profile, loading, ready, signIn, updateProfile } = useAuth();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [storedKey, setStoredKey] = useState<StoredKey | null>(null);
  const [minting, setMinting] = useState(false);
  const [lang, setLang] = useState<SnippetLang>("curl");
  const [copied, setCopied] = useState<"key" | "snippet" | null>(null);

  useEffect(() => { if (profile?.displayName) setName(profile.displayName); }, [profile?.displayName]);
  useEffect(() => { if (user) setStoredKey(getStoredKey(user.uid)); }, [user]);

  async function mint() {
    if (!user || minting) return;
    setMinting(true);
    const k = await mintDefaultKey(user.uid, user.email);
    if (k) setStoredKey({ secret: k.secret, prefix: k.prefix });
    setMinting(false);
  }

  async function copyText(what: "key" | "snippet", text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    } catch { /* selectable anyway */ }
  }

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

            {/* your API key — the 60-second ElevenLabs migration */}
            <div className="glass-panel rounded-2xl p-5">
              <div className="flex items-center justify-between">
                <span className="font-jetbrains text-[11px] uppercase tracking-widest text-white/60">your api key</span>
                {storedKey && (
                  <div className="flex gap-1.5">
                    {SNIPPET_LANGS.map((l) => (
                      <button key={l} onClick={() => setLang(l)}
                        className={`font-jetbrains cursor-pointer rounded-full border px-2 py-0.5 text-[10px] transition ${
                          l === lang ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200" : "border-white/12 text-white/60 hover:text-white"
                        }`}>
                        {l}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {storedKey ? (
                <>
                  <div className="mt-3 flex items-center gap-2 rounded-xl border border-cyan-400/25 bg-black/40 p-3">
                    <code className="font-jetbrains flex-1 truncate text-sm text-cyan-200">{storedKey.secret}</code>
                    <button onClick={() => void copyText("key", storedKey.secret)}
                      className="font-jetbrains shrink-0 rounded-lg border border-white/15 px-3 py-1.5 text-[12px] text-white/85 transition hover:bg-white/5">
                      {copied === "key" ? "✓ copied" : "copy"}
                    </button>
                  </div>
                  <p className="mt-3 text-sm text-white/65">
                    Point any ElevenLabs client at your Gravitone box — the whole migration is the base URL:
                  </p>
                  <pre className="font-jetbrains mt-2 max-h-44 overflow-auto rounded-xl border border-white/8 bg-black/40 p-3 text-[11px] leading-relaxed text-cyan-100/90">
                    {migrationSnippet(lang, { apiKey: storedKey.secret })}
                  </pre>
                  <div className="mt-3 flex items-center gap-3">
                    <button onClick={() => void copyText("snippet", migrationSnippet(lang, { apiKey: storedKey.secret }))}
                      className="font-jetbrains cursor-pointer rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-white/85 transition hover:bg-white/5">
                      {copied === "snippet" ? "✓ copied" : "copy snippet"}
                    </button>
                    <Link href="/keys" className="font-jetbrains text-[11px] text-cyan-300/80 transition hover:text-cyan-200">
                      manage all keys →
                    </Link>
                  </div>
                </>
              ) : (
                <div className="mt-3">
                  <p className="text-sm text-white/65">
                    Mint a tts-scoped key and migrate any ElevenLabs client in 60 seconds — change one base URL, keep your code.
                  </p>
                  <Button onClick={() => void mint()} disabled={minting} className="mt-3 cursor-pointer">
                    {minting ? "Minting…" : "Mint my API key"}
                  </Button>
                </div>
              )}
            </div>

            {/* Personal Voice Vault */}
            <MyVoices uid={user.uid} />

            <p className="font-jetbrains text-[11px] text-white/50">
              Stored in Firestore <span className="text-white/70">users/{user.uid}</span>
            </p>
          </div>
        )}
      </div>
    </AppFrame>
  );
}
