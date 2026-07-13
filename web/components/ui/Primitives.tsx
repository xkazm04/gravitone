"use client";

import { SURFACE } from "./tokens";

/** Mono uppercase eyebrow pill with a live dot. */
export function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-jetbrains inline-flex items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-400/5 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-cyan-300">
      <span className="h-1.5 w-1.5 rounded-full bg-cyan-300" />
      {children}
    </span>
  );
}

/** Glass panel — the core surface for every module. */
export function Panel({
  children,
  className = "",
  as: Tag = "div",
}: {
  children: React.ReactNode;
  className?: string;
  as?: keyof React.JSX.IntrinsicElements;
}) {
  return <Tag className={`${SURFACE} rounded-2xl ${className}`}>{children}</Tag>;
}

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost";
};

/** Primary = cyan glow; ghost = mono hairline. */
export function Button({ variant = "primary", className = "", children, ...rest }: BtnProps) {
  const base = "rounded-full px-6 py-3 text-sm font-semibold transition disabled:opacity-50";
  const styles =
    variant === "primary"
      ? "bg-gradient-to-r from-cyan-300 to-cyan-200 text-slate-950 hover:brightness-110 shadow-[0_8px_40px_-8px_rgba(103,232,249,0.45)]"
      : "font-jetbrains border border-white/15 text-white/85 hover:bg-white/5";
  return (
    <button className={`${base} ${styles} ${className}`} {...rest}>
      {children}
    </button>
  );
}

/** Live equalizer / waveform — entry-friendly, respects reduced-motion via CSS. */
export function Waveform({
  bars = 28,
  className = "",
  color = "cyan",
}: {
  bars?: number;
  className?: string;
  color?: "cyan" | "violet" | "emerald";
}) {
  const grad =
    color === "violet"
      ? "from-violet-400/40 to-violet-200"
      : color === "emerald"
      ? "from-emerald-400/40 to-emerald-200"
      : "from-cyan-400/40 to-cyan-200";
  return (
    <div className={`flex items-end gap-[3px] ${className}`} aria-hidden>
      {Array.from({ length: bars }).map((_, i) => (
        <span
          key={i}
          className={`eq-bar w-[3px] rounded-full bg-gradient-to-t ${grad}`}
          style={{
            height: "100%",
            animationDelay: `${(i % 9) * 0.09}s`,
            animationDuration: `${0.9 + (i % 5) * 0.12}s`,
          }}
        />
      ))}
    </div>
  );
}

/** Wordmark. */
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <span className="grid h-8 w-8 place-items-center rounded-lg border border-white/10 bg-white/5">
        <Waveform bars={4} className="h-3.5 w-4" />
      </span>
      <span className="font-instrument text-2xl tracking-tight text-white">Gravitone</span>
    </div>
  );
}
