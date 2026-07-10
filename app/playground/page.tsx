import AppFrame from "@/components/ui/AppFrame";
import { Eyebrow } from "@/components/ui/Primitives";

export default function PlaygroundPage() {
  return (
    <AppFrame>
      <div className="py-20">
        <Eyebrow>free playground</Eyebrow>
        <h1 className="font-instrument mt-5 text-4xl text-white">Playground</h1>
        <p className="mt-3 max-w-md text-white/55">
          Prototype pending — two directional variants incoming via the /prototype workflow.
        </p>
      </div>
    </AppFrame>
  );
}
