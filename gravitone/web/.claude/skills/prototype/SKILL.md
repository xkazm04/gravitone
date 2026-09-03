---
name: prototype
description: Iteratively prototype a gravitone-web UI module through 2 directional variants behind a tab switcher, then consolidate the winner. Use per module (playground, voices, API keys, auth) to pick the best UI/UX.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Prototype — Directional Variant Workflow (gravitone-web)

Adapted from the personas `/prototype` skill for this repo. A disciplined A/B loop:
produce **2 radically different directional variants** of a module behind a tab
switcher, let the user prune/fuse across rounds until one wins, then consolidate.

## The quality bar — mine this before writing ANY variant

gravitone-web has a locked identity: **Obsidian** (dark cinematic). Variants must
read as siblings of it, not one-off prototypes. Before round 1, internalize:

- **Design tokens & primitives:** `components/ui/tokens.ts` (EASE, ACCENT, `rise`,
  SURFACE, TEXT) and `components/ui/Primitives.tsx` (`Eyebrow`, `Panel`, `Button`,
  `Waveform`, `Wordmark`). **Import these — never hand-roll a button, panel, pill,
  or waveform.** A raw `<button>` or `bg-violet-500/15` is a tell.
- **Fonts:** `.font-instrument` (display serif), `.font-hanken` (body),
  `.font-jetbrains` (mono labels/data). Labels are mono uppercase, tracked.
- **Atmosphere utilities** (in `app/globals.css`): `.aurora`, `.grain`,
  `.glass-panel`, `.text-aurora`, `.eq-bar`. Module pages wrap in
  `components/ui/AppFrame.tsx` (aurora + nav shell).
- **Reference surface:** `components/variants/StudioDark.tsx` is the canonical
  execution of the identity (hero, glass now-playing panel, voice chips, feature
  cards). Match its layout shape, motion language, and data patterns.

## The harness

Each module lives at its own route (`app/<module>/page.tsx`) and renders
`components/ui/PrototypeTabs.tsx` with 2 variants:

```tsx
<PrototypeTabs
  storageKey="proto-playground"
  variants={[
    { id: "console", label: "Console", sub: "terminal-first", node: <PlaygroundConsole /> },
    { id: "stage",   label: "Stage",   sub: "performer view", node: <PlaygroundStage /> },
  ]}
/>
```
Variant components live in `app/<module>/_variants/`. Both accept the same props.

## The loop

1. **Ground** in the quality bar above (a few reads). Skip this and round 1 gets thrown away.
2. **Round 1: exactly 2 directional variants.** Not 3. Each carries a *single
   central metaphor* through layout + type + motion + copy. A variant is a
   different mental model, not "baseline with spacing tweaked." Directions must
   answer, in round 1: *what am I working with?* (show meaningful stats/state, not
   name-only chips) and *what did I get?* (label/annotate outputs, not raw values).
3. **Iterate by subtraction + fusion.** Rejection → delete the file, import, tab
   entry immediately. Fusion → extract the strong piece, merge into the keeper,
   delete the source. Specific feedback → refine inside the chosen variant (do NOT
   spawn a new variant for a fix). Add a variant only when explicitly asked.
   Hoist shared sub-components the moment two variants render the same structure.
4. **Consolidate the winner.** Remove the switcher (or make winner default),
   delete losers from disk + imports, typecheck clean, render winner directly.
5. **Refactor only on explicit request.**

End every round with an explicit menu of what changed, then stop and ask for the
next move. Don't auto-advance.

## Guardrails (do not relearn these)

- **Animation austerity.** No `repeat: Infinity`, no looping scan-lines/orbits/
  drifting particles, no `hover:-translate-y-*` on cards in a *shipped* variant.
  (The landing's ambient aurora/equalizer is the atmosphere exception; module UI
  stays calm.) Welcome: entry fades (once on mount), hover-gated color/shadow/
  border transitions, click-gated drawer/panel transitions, `AnimatePresence`.
- **Typography: brighter, not muted.** Promote copy by removing opacity AND
  bumping size (`text-white/60` → `text-white`, add weight). Body ≥ `text-base`;
  reserve `text-xs` for uppercase tracked labels. No `text-[10px]`.
- **Data-concrete over abstract.** Show real fields (voice name + language +
  clone source + duration; key scope + last-used; RTF/latency) over decorative dots.
- **SVG motion:** animate `x/y/scale/opacity/pathLength/strokeDashoffset`, never
  raw `cx/cy/r`.
- **Atomic commits per round.** One commit per round of variants, one per
  consolidation. `git add <path>` per file — never `git add -A`.
- **One-shot typecheck** (`npx tsc --noEmit`) at the end of a round, not per file.

## Modules to prototype (this app)

| Route | Module | Core job |
|---|---|---|
| `/playground` | TTS playground | text → voice → generate/download a recording, free |
| `/voices` | Voice management | clone from a sample, browse/manage the library |
| `/keys` | API-key exchange | issue/rotate/scope keys, copy-once secret handling |
| `/(auth)` | Auth | Supabase Google OAuth entry + session |

## Exit checklist per module
- [ ] Winner is the directly-rendered module; losers deleted from disk + imports.
- [ ] Only `components/ui` primitives used — no hand-rolled buttons/panels/pills.
- [ ] `npx tsc --noEmit` clean on touched files.
- [ ] No infinite motion in the shipped variant.
