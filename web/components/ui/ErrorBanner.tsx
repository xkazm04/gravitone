// The one inline failure/warning surface. Severity decides the palette —
// previously amber and rose each meant "error" in some files and "warning" in
// others, so users couldn't read severity from color.
//   error   → rose:  the action failed / data is missing
//   warning → amber: the action succeeded with caveats / degraded info
import type { ReactNode } from "react";

export function ErrorBanner({
  children,
  severity = "error",
  className = "mt-4",
}: {
  children: ReactNode;
  severity?: "error" | "warning";
  className?: string;
}) {
  if (!children) return null;
  const palette =
    severity === "error"
      ? "border-rose-400/25 bg-rose-400/5 text-rose-200"
      : "border-amber-400/25 bg-amber-400/5 text-amber-200/90";
  return (
    <p role="alert" className={`font-jetbrains rounded-lg border px-4 py-2 text-[11px] ${palette} ${className}`}>
      {children}
    </p>
  );
}
