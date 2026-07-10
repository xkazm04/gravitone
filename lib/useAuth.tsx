"use client";

// Auth + profile context. Google sign-in via Firebase popup; on sign-in we
// upsert a user profile in Firestore (users/{uid}) and keep it in sync.

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import {
  browserLocalPersistence,
  getRedirectResult,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signInWithRedirect,
  signOut as fbSignOut,
  type AuthError,
  type User,
} from "firebase/auth";
import { doc, getDoc, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
import { auth, db, firebaseReady, googleProvider } from "./firebase";

// Popup can fail (blocked, closed, COOP, internal-error) — fall back to a
// full-page redirect, which always works. getRedirectResult (on mount) then
// completes that path.
const REDIRECT_FALLBACK = new Set([
  "auth/popup-blocked",
  "auth/popup-closed-by-user",
  "auth/cancelled-popup-request",
  "auth/internal-error",
  "auth/operation-not-supported-in-this-environment",
]);

export type Profile = {
  uid: string;
  displayName: string | null;
  email: string | null;
  photoURL: string | null;
  createdAt?: unknown;
  lastLogin?: unknown;
  plan?: string;
};

type AuthState = {
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  ready: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  updateProfile: (patch: Partial<Profile>) => Promise<void>;
  error: string | null;
};

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!firebaseReady) { setLoading(false); return; }
    // Complete a redirect-based sign-in if we came back from one.
    getRedirectResult(auth).catch((e) => setError(e instanceof Error ? e.message : "sign-in failed"));
    return onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        const ref = doc(db, "users", u.uid);
        const snap = await getDoc(ref);
        const base: Profile = {
          uid: u.uid, displayName: u.displayName, email: u.email, photoURL: u.photoURL,
        };
        if (snap.exists()) {
          await updateDoc(ref, { lastLogin: serverTimestamp() });
          setProfile({ ...(snap.data() as Profile), ...base });
        } else {
          await setDoc(ref, { ...base, plan: "free", createdAt: serverTimestamp(), lastLogin: serverTimestamp() });
          setProfile({ ...base, plan: "free" });
        }
      } else {
        setProfile(null);
      }
      setLoading(false);
    });
  }, []);

  const signIn = useCallback(async () => {
    setError(null);
    if (!firebaseReady) { setError("Firebase not configured"); return; }
    await setPersistence(auth, browserLocalPersistence);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (e) {
      const code = (e as AuthError)?.code ?? "";
      const coop = /Cross-Origin-Opener-Policy|window\.close/i.test(String(e));
      if (REDIRECT_FALLBACK.has(code) || coop) {
        try { await signInWithRedirect(auth, googleProvider); return; }
        catch (e2) { setError(e2 instanceof Error ? e2.message : "sign-in failed"); return; }
      }
      setError(e instanceof Error ? e.message : "sign-in failed");
    }
  }, []);

  const signOut = useCallback(async () => { await fbSignOut(auth); }, []);

  const updateProfile = useCallback(async (patch: Partial<Profile>) => {
    if (!user) return;
    await updateDoc(doc(db, "users", user.uid), patch);
    setProfile((p) => (p ? { ...p, ...patch } : p));
  }, [user]);

  return (
    <Ctx.Provider value={{ user, profile, loading, ready: firebaseReady, signIn, signOut, updateProfile, error }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
