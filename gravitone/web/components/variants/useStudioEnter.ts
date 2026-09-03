"use client";

/*
 * The landing page's one piece of navigation logic, held apart from its layout:
 * an auth-gated CTA that remembers where the visitor was going.
 */

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/useAuth";

export function useStudioEnter() {
  const { user, signIn } = useAuth();
  const router = useRouter();

  // Where the visitor was actually trying to go when they pressed a CTA.
  //
  // Both landing CTAs used to be plain <Link href="/playground">, and every
  // module route is wrapped by AppFrame, which router.replace("/")s anyone who
  // is not signed in. So the page's primary button returned the visitor to the
  // page they were already on, by way of a "redirecting…" flash — the front
  // door turning people around. Signed out, a CTA now opens sign-in and the
  // destination waits here until auth actually lands (a click handler that
  // navigated straight after `await signIn()` would race AppFrame's gate,
  // which reads React state, not Firebase's).
  const pending = useRef<string | null>(null);
  useEffect(() => {
    if (!user || !pending.current) return;
    const to = pending.current;
    pending.current = null;
    router.push(to);
  }, [user, router]);

  const enter = (href: string) => {
    if (user) { router.push(href); return; }
    pending.current = href;
    // signIn() reports its own failures through the auth context's banner; all
    // this needs is to stop holding a destination nobody is travelling to.
    void signIn().catch(() => { pending.current = null; });
  };

  return { user, enter };
}
