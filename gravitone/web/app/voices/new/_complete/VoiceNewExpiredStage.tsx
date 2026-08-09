"use client";

/** The dead-session screen. */
export default function VoiceNewExpiredStage({ startOver }: { startOver: () => void }) {
  return (
    <div className="mt-8 max-w-3xl">
      <div className="glass-panel rounded-2xl p-5">
        <div className="font-jetbrains text-[11px] uppercase tracking-widest text-amber-300">session expired</div>
        <h2 className="font-instrument mt-2 text-3xl text-white">This ingest session ended.</h2>
        <p className="mt-2 max-w-2xl text-sm text-white/60">
          Scan sessions are held for a limited time and then cleaned up. Nothing was saved — start over with your recording.
        </p>
        <button onClick={startOver}
          className="mt-6 cursor-pointer rounded-full bg-cyan-300 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:brightness-110">
          Start over
        </button>
      </div>
    </div>
  );
}
