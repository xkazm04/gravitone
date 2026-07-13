import type { Metadata } from "next";
import BenchmarksView from "./BenchmarksView";

export const metadata: Metadata = {
  title: "Gravitone benchmarks — measured $/audio-hour on Arm CPUs",
  description:
    "Reproducible TTS benchmarks: dollars per audio-hour on Graviton vs ElevenLabs list pricing, plus a capacity planner that turns your volume into an exact instance + env config.",
};

// Public proof asset — deliberately NOT wrapped in the auth-gated AppFrame.
export default function BenchmarksPage() {
  return <BenchmarksView />;
}
