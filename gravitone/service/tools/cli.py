"""One door to the emotion pipeline: ``python -m service.tools <command>``.

Four scripts answer the product's boldest technical claim -- *does an emotion
travel between voices?* -- and until this file existed each of them was a
separate command with a separate module path, discoverable only by reading the
source. Nothing calls them: no route, no scheduler, no CI step. That is a
deliberate choice (they take minutes, two of them need the model stack, and one
of them WRITES voices), but it makes the command itself the whole interface,
and an interface nobody can find is an interface nobody runs. Hence one name to
know instead of four:

    python -m service.tools                 # this roster, in the order to run it
    python -m service.tools residuals       # do the emotions agree at all?
    python -m service.tools basis           # build the shared directions
    python -m service.tools prosody --dry-run
    python -m service.tools ab --dry-run    # do derived voices land where real ones do?
    python -m service.tools autofill --dry-run

Every argument after the command is handed to that tool unchanged, so
``python -m service.tools ab --emotion angry --limit 5`` is exactly the old
``python -m service.tools.derive_ab --emotion angry --limit 5``, and the old
module paths still work. This adds a door; it closes none.

**What each one NEEDS is part of its description, by name.** Two of these
cannot run without torch + pocket_tts (they have to make a sound to measure
one), and on a box without them each tool already degrades to a named skip
rather than a traceback. The roster says so up front so an operator on a dev box
knows which two will refuse before spending a minute finding out.
"""
from __future__ import annotations

import importlib
import sys
from dataclasses import dataclass

# Deliberately NOT wired to a scheduler or a CI job, and no generated basis is
# checked in: what this pipeline writes (a basis, prosody rows, and in
# autofill's case actual derived voices) is an owner's call to make on a real
# corpus, not something a repo should do to an install behind its back.


@dataclass(frozen=True)
class Tool:
    """One command in the roster, with everything needed to decide to run it."""
    name: str
    module: str        # the module whose `main(argv)` this dispatches to
    headline: str      # what question it answers
    needs: str         # what has to be installed for it to do the real thing
    runtime: str       # roughly how long, on a real corpus
    writes: str        # what it changes -- "nothing" is an answer

    @property
    def legacy(self) -> str:
        return f"python -m {self.module}"


# In the order an operator should run them. `prosody` sits before `ab` because
# the A/B harness scores against stored prosody probes and has nothing to score
# against until the old rows are measured.
TOOLS: tuple[Tool, ...] = (
    Tool("residuals", "service.tools.emotion_residuals",
         "does (emotion - baseline) agree between speakers? the go/no-go gate",
         "numpy + safetensors (reads embeddings; no engine)",
         "seconds", "nothing -- it only reports"),
    Tool("basis", "service.emotion_basis",
         "average the agreeing residuals into portable per-emotion directions",
         "numpy + safetensors (reads embeddings; no engine)",
         "seconds to minutes, with the registry size",
         "voices/_basis.safetensors and voices/_basis.json"),
    Tool("prosody", "service.tools.prosody_backfill",
         "measure prosody for Voices registered before the probe existed",
         "torch + pocket_tts (it has to SPEAK a line to measure it)",
         "a few seconds per voice", "a `prosody` row per measured Voice"),
    Tool("ab", "service.tools.derive_ab",
         "blind A/B: does a DERIVED voice land where the recording it replaces "
         "lands? this is what fills in transfer quality",
         "torch + pocket_tts (it renders both arms)",
         "two renders per testable speaker/emotion pair",
         "the `transfer` block in voices/_basis.json"),
    Tool("autofill", "service.tools.derive_autofill",
         "derive the hottest missing slot per Character from unmet-demand "
         "telemetry (capped, and every voice is reversible)",
         "numpy + safetensors, and the service package importable",
         "seconds per slot",
         "DERIVED voices in the registry -- start with --dry-run"),
)

BY_NAME: dict[str, Tool] = {t.name: t for t in TOOLS}

HELP_FLAGS = frozenset({"-h", "--help", "help", "list"})


def _out(line: str) -> None:
    """ASCII-only stdout -- this runs on a cp1252 Windows console."""
    print(line.encode("ascii", "replace").decode("ascii"))


def roster() -> list[str]:
    """The help text, as lines. Built from :data:`TOOLS` so a tool cannot be
    added to the dispatcher without appearing in the roster."""
    lines = ["usage: python -m service.tools <command> [options]",
             "",
             "The emotion pipeline, in the order to run it. Nothing runs these "
             "automatically; each is a deliberate operator action.",
             ""]
    for tool in TOOLS:
        lines.append(f"  {tool.name:<10} {tool.headline}")
        lines.append(f"  {'':<10}   needs:  {tool.needs}")
        lines.append(f"  {'':<10}   takes:  {tool.runtime}")
        lines.append(f"  {'':<10}   writes: {tool.writes}")
        lines.append(f"  {'':<10}   (also: {tool.legacy})")
        lines.append("")
    lines.append("Every option after <command> is passed to that tool unchanged; "
                 "'--help' after a command shows its own options.")
    lines.append("Tools that need torch/pocket_tts refuse BY NAME on a box "
                 "without them, and write nothing.")
    return lines


def _load_main(module: str):
    """The named module's ``main``. Imported LATE, and only for the command that
    was asked for: importing all five up front would make `--help` require numpy
    on a box that has none."""
    return importlib.import_module(module).main


def main(argv: list[str] | None = None) -> int:
    """Dispatch. ``0`` on a delegated run, ``0`` for the roster, ``2`` for an
    unknown command -- an operator who mistyped gets the roster and a non-zero
    status, not a silent no-op."""
    argv = list(argv if argv is not None else sys.argv[1:])
    if not argv or argv[0] in HELP_FLAGS:
        for line in roster():
            _out(line)
        return 0
    name, rest = argv[0], argv[1:]
    tool = BY_NAME.get(name)
    if tool is None:
        _out(f"service.tools: unknown command '{name}' -- known commands: "
             f"{', '.join(t.name for t in TOOLS)}")
        _out("run 'python -m service.tools' for what each one needs and writes")
        return 2
    return int(_load_main(tool.module)(rest) or 0)
