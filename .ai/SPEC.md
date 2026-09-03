# `ai-manifest` — schemaVersion 0.1.0

The contract `.ai/manifest.yaml` implements, written down **inside this
repository** so that a reader auditing a fresh clone — on a laptop, offline, with
no access to whichever repository the shape was first agreed in — can determine
what the manifest means without leaving the tree.

Until 2026-08-24 the manifest's own header cited `personas/.ai/manifest.yaml` as
its shape reference. That path does not exist in this repository, resolves to
nothing in a clone, and forfeited the whole point of a self-describing artifact.
This document replaces that citation.

## Reimplementation clause

**Any implementation that performs the checks this document describes is
conformant.** No runner exists in this repository yet; the checks below are performed by reading (the sibling content studio carries `pipeline/check-manifest.mjs` as one runner, and it is not the definition). If
a check below cannot be reimplemented from this prose alone, that is a hole in
this document and not a question to answer by reading the runner.

## Purpose

The manifest is the agent-facing contract for a repository: what this repo is,
how to run its gates, where its generated artifacts live, and what must not be
touched. It is read by tools that were not written when it was authored, which is
what every rule below is shaped around.

## Format

YAML, in a deliberately small subset so that a reader — human or otherwise — never
has to resolve an ambiguity:

- Two-space indentation. No tabs.
- Scalars, block mappings, inline mappings (`{ a: b, c: d }`) and inline
  sequences (`[a, b]`).
- No anchors, no aliases, no multi-document streams, no block sequences of
  mappings.
- `#` starts a comment to end of line, outside quotes.

Comments are not decoration here: several fields below are only honest because a
comment records when and how they were verified.

## Required fields

| Field | Type | Meaning |
|---|---|---|
| `schema` | string | Contract identity as a plain NAME, not a fetchable address. Always `ai-manifest`. |
| `schemaVersion` | string | Semver of THIS contract, versioned separately from the repository. |
| `repo.name` | string | Short repo identity. |
| `repo.purpose` | string | One sentence. What the repo is for, not how it is built. |
| `capabilities` | mapping | See below. |
| `paths` | mapping | See below. |
| `boundaries` | mapping | See below. |

`generatedAt`, `generatedFrom`, `registry`, `knowledge` and `skills` are
OPTIONAL. Their absence is not a failure.

## `capabilities` — a name → an invocation

Each entry is `<capability>: { command: "<invocation>", verified: <bool> }`.

Two rules, and the first is the reason this field exists:

1. **The key is a CAPABILITY, never a tool.** `test`, `build`, `typecheck`,
   `lint` — never `playwright`, `next`, `tsc`, `eslint`. A reader learns what the
   repo can do; the tool behind it is free to change without the contract
   changing. No field anywhere names the tool.
2. **`verified` is a claim about EXECUTION.** It may be `true` only if the
   command has actually been run in this repository and exited zero. It is not
   "the script exists" and not "this looks right"; a doctor flips it to true
   after running the thing. A comment beside it saying when and with what result
   is expected, not required.

**CHECK C1.** Every capability whose command is of the form `npm run <script>` or
`npm <script>` must name a script that exists in `package.json`. A capability
pointing at a script nobody ever added is a contract lying about what the repo
can do.

**CHECK C2.** At least one capability is declared. A manifest with an empty
`capabilities` block has told a reader nothing, and is more likely to be a broken
parse than a repository with no gates.

## `paths` — pointers, not embeds

Each value is a repository-relative path to something that lives in the repo.

**CHECK P1.** Every value under `paths` must resolve on disk from the repository
root. A pointer that does not resolve in a fresh clone is worse than an absent
one: it sends a reader looking for something that was renamed or never existed.

Paths point; they never restate. A manifest that inlines a copy of what it points
at has created a second authority for it, and the two will disagree.

## `boundaries`

| Field | Meaning |
|---|---|
| `neverTouch` | Files an agent must not edit, each with the reason legible at the entry or in a comment beside it. Generated artifacts belong here: a hand edit is erased by the next generation and, until then, is read as truth. |
| `secretsFrom` | Where secrets come from, in prose. It names the FILE and the VARIABLE CLASSES; it never contains a secret. |

**CHECK B1.** `neverTouch` is present and non-empty, OR carries a comment
explaining why the repository has no untouchable artifacts. An absent boundary
block reads identically to "nothing here is generated", which is rarely true and
dangerous when wrong.

**CHECK B2.** No value anywhere in the manifest looks like a credential. A
manifest is committed; a key in it is a leaked key. Concretely: no value may
match a long unbroken run of base64/hex-like characters (32+), and no value may
contain `BEGIN PRIVATE KEY`.

## Unknown fields MUST be ignored

A reader that encounters a field it does not know **ignores it and continues**. It
must not warn, must not fail, and must not strip it on rewrite. This is what lets
the contract grow without a coordinated upgrade of every tool that reads it, and
it is the single most important rule in this document.

Correspondingly, a producer may add fields freely. Removing or repurposing an
existing field is a breaking change and requires a `schemaVersion` major bump.

## Versioning

`schemaVersion` is semver over THIS document.

- **Patch** — wording, clarification, no behaviour change.
- **Minor** — new optional fields; every existing manifest stays conformant.
- **Major** — a field removed, renamed, or given a different meaning.

`schemaVersion` is not the repository's version and never tracks it.

## The checks, as a list

A conformant checker performs all of these and distinguishes three outcomes:
**pass**, **fail**, and **could-not-run**. It must never report could-not-run as
pass — a checker that finds no manifest, or parses none of it, has not verified
anything, and saying so is the whole difference between a gate and a decoration.

| Id | Check |
|---|---|
| R1 | Every required field above is present. |
| R2 | `schema` is exactly `ai-manifest`. |
| R3 | `schemaVersion` parses as semver. |
| C1 | Every `npm`-shaped capability command names a real `package.json` script. |
| C2 | At least one capability is declared. |
| P1 | Every `paths` value resolves on disk. |
| B1 | `boundaries.neverTouch` is present and non-empty. |
| B2 | No value looks like a credential. |
| I1 | The checker read a non-trivial number of lines and found at least the required top-level keys — otherwise **could-not-run**, never pass. |
