// Provenance for a shared take: where it came from, and what came out of it.
//
// A child take puts new words (or a new emotion) into a voice someone else
// published. Carrying its parent link on the page is what keeps a fork honest
// — the visitor can hear the original, not just the edit.

import Link from "next/link";
import type { LineageMember, TakeLineage } from "@/lib/takes";

function label(m: LineageMember): string {
  return m.character_name || m.character_id || m.id;
}

function note(m: LineageMember | undefined): string {
  const raw = m?.derived_from ?? {};
  const value = raw["direction"] ?? raw["note"];
  return typeof value === "string" ? value.slice(0, 120) : "";
}

export default function Lineage({ lineage }: { lineage: TakeLineage }) {
  const parent = lineage.ancestors[0];
  const children = lineage.children;
  if (!parent && children.length === 0) return null;

  const older = lineage.ancestors.length - 1; // grandparents and beyond
  // The child's own block says what was ASKED for when it was forked.
  const direction = note(lineage.take);

  return (
    <div className="glass-panel mt-4 rounded-2xl p-4">
      <div className="font-jetbrains text-[11px] uppercase tracking-widest text-white/50">
        lineage
      </div>

      {parent && (
        <p className="mt-2 text-sm text-white/75">
          {parent.missing ? (
            <>
              Derived from an earlier take that has since been evicted from the share store
              (shares are not an archive).
            </>
          ) : (
            <>
              Derived from{" "}
              <Link href={`/t/${parent.id}`} className="text-cyan-300 transition hover:text-cyan-200">
                {label(parent)}&apos;s take
              </Link>
              {older > 0 && (
                <span className="text-white/50">
                  {" "}
                  · {older} earlier {older === 1 ? "version" : "versions"} before it
                  {lineage.depth_capped && " (chain truncated)"}
                </span>
              )}
              .
            </>
          )}
          {direction && <span className="text-white/50"> Asked for: {direction}.</span>}
        </p>
      )}

      {children.length > 0 && (
        <div className="mt-3">
          <p className="text-sm text-white/75">
            Re-performed {lineage.children_total} {lineage.children_total === 1 ? "time" : "times"}:
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {children.map((c) => (
              <Link
                key={c.id}
                href={`/t/${c.id}`}
                className="font-jetbrains rounded-full border border-white/12 px-3 py-1 text-[11px] text-white/70 transition hover:border-cyan-400/40 hover:text-cyan-200"
              >
                {label(c)}
                {typeof c.seconds === "number" && c.seconds > 0 && (
                  <span className="opacity-60"> · {c.seconds}s</span>
                )}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
