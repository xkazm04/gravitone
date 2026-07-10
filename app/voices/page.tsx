import AppFrame from "@/components/ui/AppFrame";
import { Eyebrow } from "@/components/ui/Primitives";

export default function VoicesPage() {
  return (
    <AppFrame>
      <div className="py-20">
        <Eyebrow>voice library</Eyebrow>
        <h1 className="font-instrument mt-5 text-4xl text-white">Voices</h1>
        <p className="mt-3 max-w-md text-white/55">
          Prototype pending — voice management (clone, browse, manage) coming via /prototype.
        </p>
      </div>
    </AppFrame>
  );
}
