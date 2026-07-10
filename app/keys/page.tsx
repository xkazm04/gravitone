import AppFrame from "@/components/ui/AppFrame";
import { Eyebrow } from "@/components/ui/Primitives";

export default function KeysPage() {
  return (
    <AppFrame>
      <div className="py-20">
        <Eyebrow>security</Eyebrow>
        <h1 className="font-instrument mt-5 text-4xl text-white">API keys</h1>
        <p className="mt-3 max-w-md text-white/55">
          Prototype pending — API-key exchange &amp; secret handling coming via /prototype.
        </p>
      </div>
    </AppFrame>
  );
}
