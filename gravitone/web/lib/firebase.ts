"use client";

// Firebase client init. The web config is public by design — access is secured
// by Firebase Auth (Google provider) + the Firestore security rules we deployed.
import { getApp, getApps, initializeApp } from "firebase/app";
import {
  browserLocalPersistence,
  getAuth,
  GoogleAuthProvider,
  onIdTokenChanged,
  setPersistence,
  signOut,
} from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { clearStoredKey } from "./mintKey";

// Minimal init (apiKey/authDomain/projectId) — the proven shape from the sibling
// grant-writing app on this same Firebase project. The web API key is public.
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
};

export const firebaseReady = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

export const auth = getAuth(app);
// Keep users signed in across reloads/sessions via local storage. Firebase on
// its own would never expire that — see the session policy below, which puts a
// ceiling on it.
if (firebaseReady) void setPersistence(auth, browserLocalPersistence).catch(() => {});
export const db = getFirestore(app);

/* ---------------------------------------------------------------------------
   SESSION EXPIRY POLICY

   Launch posture, recorded deliberately: Google is the ONLY sign-in provider.
   No passwords stored, no reset flow, no email-verification surface to harden
   before the deadline — one identity path, and Google owns the credential.

   The cost of that posture is `browserLocalPersistence`: the refresh token
   survives reloads, browser restarts and closed tabs indefinitely, so a session
   left on a shared or borrowed machine never ends on its own. There is no
   server-side session to expire (the app is static + a token-authenticated
   backend), so the ceiling is enforced client-side, here, at the one module
   that owns the auth object.

   POLICY: a session is valid for at most MAX_SESSION_MS after the user's last
   real sign-in. Past that, we sign out and Google re-authentication is
   required. 12 hours is picked to be proportionate — it survives a working day
   and a demo, and it dies overnight. Re-auth against an already-live Google
   session is a single click, so the cost of being wrong on the short side is
   near zero, which is why it is not longer.

   Checked at three moments, all cheap: whenever Firebase emits/refreshes an ID
   token (covers app load and the hourly refresh), whenever a backgrounded tab
   becomes visible again (covers the laptop-reopened-next-morning case, where no
   token event may have fired), and on a 5-minute tick (covers a tab left open
   and focused). `lastSignInTime` comes from Firebase's own user metadata, so it
   is authoritative and survives reloads without us storing anything.
--------------------------------------------------------------------------- */

/** Maximum age of a session before Google re-authentication is required. */
export const MAX_SESSION_MS = 12 * 60 * 60 * 1000;

/** Age of a session in ms, or null when the timestamp is absent/unparseable. */
export function sessionAgeMs(
  lastSignInTime: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (!lastSignInTime) return null;
  const at = Date.parse(lastSignInTime);
  return Number.isNaN(at) ? null : now - at;
}

/**
 * True only when we can prove the session is too old. An unknown or
 * unparseable `lastSignInTime` fails OPEN on purpose: a missing timestamp is a
 * Firebase-metadata quirk, not evidence of staleness, and bouncing a working
 * user out of a live demo is the worse failure of the two.
 */
export function sessionExpired(
  lastSignInTime: string | null | undefined,
  now: number = Date.now(),
): boolean {
  const age = sessionAgeMs(lastSignInTime, now);
  return age !== null && age > MAX_SESSION_MS;
}

/** Check the current user against the policy; sign out if the ceiling is past. */
function enforceSessionAge(): void {
  const user = auth.currentUser;
  if (!user || !sessionExpired(user.metadata.lastSignInTime)) return;
  // Purge the copy-once secret before signing out, exactly as the manual
  // sign-out path does — currentUser is null afterwards.
  clearStoredKey(user.uid);
  void signOut(auth).catch(() => {});
}

if (firebaseReady && typeof window !== "undefined") {
  onIdTokenChanged(auth, enforceSessionAge);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") enforceSessionAge();
  });
  window.setInterval(enforceSessionAge, 5 * 60 * 1000);
}

export const googleProvider = new GoogleAuthProvider();
googleProvider.addScope("email");
googleProvider.addScope("profile");
