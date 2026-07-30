import type { Metadata } from "next";
import {
  Instrument_Serif,
  Hanken_Grotesk,
  JetBrains_Mono,
} from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/useAuth";
import GravitoneTokens from "@/components/ui/GravitoneTokens";
import AudioBusProvider from "@/components/ui/AudioBus";

const instrument = Instrument_Serif({ weight: "400", subsets: ["latin"], variable: "--font-instrument", display: "swap" });
const hanken = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-hanken", display: "swap" });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap" });

export const metadata: Metadata = {
  // Resolves relative OpenGraph image URLs (the /t/{id} + /r/{id} share cards)
  // against the real origin. Without it Next falls back to localhost, so every
  // social-share preview — the whole "each share is a landing page" loop —
  // renders a broken image off-platform.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
  title: "Gravitone — voice AI that runs on a CPU",
  description:
    "Clone any voice and generate expressive speech through an ElevenLabs-compatible API — CPU-native, Arm-ready, self-hostable. Emotion-addressable Characters, multi-character performances, and sentence-streaming synthesis, with a consent receipt on every clone.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        className={[
          instrument.variable, hanken.variable, jetbrains.variable,
        ].join(" ")}
      >
        {/* Design tokens + Signal Layer channel defaults, straight from
            components/ui/tokens.ts. Server-rendered as the first thing in the
            document, so every --gt-* var globals.css reads resolves on the first
            paint. (A <style> element here rather than a manual <head> — the App
            Router owns <head> through the Metadata API.) */}
        <GravitoneTokens />
        {/* One AudioContext for the whole app: the bus owns the scoped node the
            --gt-* signal channels are written on, so any surface below can react
            to real audio without building an analyser of its own. */}
        <AudioBusProvider>
          <AuthProvider>{children}</AuthProvider>
        </AudioBusProvider>
      </body>
    </html>
  );
}
