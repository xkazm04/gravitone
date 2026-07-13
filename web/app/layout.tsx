import type { Metadata } from "next";
import {
  Instrument_Serif,
  Hanken_Grotesk,
  JetBrains_Mono,
  Bricolage_Grotesque,
  Gabarito,
  Shantell_Sans,
} from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/useAuth";

const instrument = Instrument_Serif({ weight: "400", subsets: ["latin"], variable: "--font-instrument", display: "swap" });
const hanken = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-hanken", display: "swap" });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap" });
const bricolage = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-bricolage", display: "swap" });
const gabarito = Gabarito({ subsets: ["latin"], variable: "--font-gabarito", display: "swap" });
const shantell = Shantell_Sans({ subsets: ["latin"], variable: "--font-shantell", display: "swap" });

export const metadata: Metadata = {
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
          bricolage.variable, gabarito.variable, shantell.variable,
        ].join(" ")}
      >
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
