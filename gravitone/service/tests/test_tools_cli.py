"""One door to the emotion pipeline: `python -m service.tools <command>`.

The four tools that answer "does an emotion travel between voices?" had zero
callers repo-wide -- no route, no CI step, no script -- so the coverage loop and
the transfer measurement only ever ran if a human remembered four module paths
documented nowhere the refused operator would look. That they are unattended is
deliberate (two need the model stack, one WRITES voices); that they were
unfindable was not.

What is pinned here: dispatch (every command reaches its own tool's `main` with
its arguments intact), the roster (built FROM the table, so a tool cannot be
added to the dispatcher without appearing in it, and every entry says what it
needs / how long / what it writes), and the mistyped-command path.
"""
from __future__ import annotations

import unittest
from unittest import mock

from service.tools import cli


class DispatchTests(unittest.TestCase):
    def test_every_command_reaches_its_own_tool(self) -> None:
        for tool in cli.TOOLS:
            with self.subTest(command=tool.name):
                entry = mock.Mock(return_value=0)
                with mock.patch.object(cli, "_load_main", return_value=entry) as load:
                    self.assertEqual(cli.main([tool.name]), 0)
                load.assert_called_once_with(tool.module)
                entry.assert_called_once_with([])

    def test_arguments_after_the_command_are_passed_through_untouched(self) -> None:
        entry = mock.Mock(return_value=0)
        with mock.patch.object(cli, "_load_main", return_value=entry):
            cli.main(["ab", "--emotion", "angry", "--limit", "5", "--dry-run"])
        entry.assert_called_once_with(
            ["--emotion", "angry", "--limit", "5", "--dry-run"])

    def test_the_tools_exit_code_is_the_dispatchers(self) -> None:
        with mock.patch.object(cli, "_load_main", return_value=lambda _a: 3):
            self.assertEqual(cli.main(["autofill"]), 3)

    def test_a_tool_that_returns_none_is_a_success(self) -> None:
        with mock.patch.object(cli, "_load_main", return_value=lambda _a: None):
            self.assertEqual(cli.main(["basis"]), 0)

    def test_the_modules_it_dispatches_to_all_exist_and_expose_a_main(self) -> None:
        # The dispatch table is strings; this is what stops one of them rotting
        # into a name that only fails for the operator who typed it.
        for tool in cli.TOOLS:
            with self.subTest(command=tool.name):
                self.assertTrue(callable(cli._load_main(tool.module)))

    def test_a_mistyped_command_gets_the_roster_and_a_non_zero_status(self) -> None:
        with mock.patch.object(cli, "_out") as out:
            self.assertEqual(cli.main(["derive_ab"]), 2)
        printed = "\n".join(str(c.args[0]) for c in out.call_args_list)
        self.assertIn("unknown command 'derive_ab'", printed)
        for tool in cli.TOOLS:
            self.assertIn(tool.name, printed)

    def test_a_mistyped_command_runs_nothing(self) -> None:
        with mock.patch.object(cli, "_load_main") as load:
            cli.main(["basisss", "--voices-dir", "/tmp/nope"])
        load.assert_not_called()

    def test_no_arguments_and_the_help_flags_all_print_the_roster(self) -> None:
        for argv in ([], ["-h"], ["--help"], ["help"], ["list"]):
            with self.subTest(argv=argv):
                with mock.patch.object(cli, "_out") as out:
                    self.assertEqual(cli.main(argv), 0)
                self.assertIn("usage: python -m service.tools",
                              str(out.call_args_list[0].args[0]))


class RosterTests(unittest.TestCase):
    def test_every_tool_appears_with_what_it_needs_costs_and_writes(self) -> None:
        text = "\n".join(cli.roster())
        for tool in cli.TOOLS:
            with self.subTest(command=tool.name):
                self.assertIn(f"  {tool.name:<10} {tool.headline}", text)
                self.assertIn(tool.needs, text)
                self.assertIn(tool.runtime, text)
                self.assertIn(tool.writes, text)
                # the old per-module path still works and is printed beside it
                self.assertIn(tool.legacy, text)

    def test_the_two_tools_that_need_the_model_stack_say_so_by_name(self) -> None:
        # The discipline the tools already keep: what cannot run without
        # torch/pocket_tts names them rather than failing obscurely.
        for name in ("prosody", "ab"):
            with self.subTest(command=name):
                needs = cli.BY_NAME[name].needs
                self.assertIn("torch", needs)
                self.assertIn("pocket_tts", needs)
        self.assertIn("torch", "\n".join(cli.roster()))

    def test_the_tool_that_writes_voices_says_that_before_it_is_run(self) -> None:
        writes = cli.BY_NAME["autofill"].writes
        self.assertIn("DERIVED voices", writes)
        self.assertIn("--dry-run", writes)

    def test_the_tool_that_only_reports_says_it_writes_nothing(self) -> None:
        self.assertIn("nothing", cli.BY_NAME["residuals"].writes)

    def test_the_order_is_the_order_to_run_them_in(self) -> None:
        # residuals gates basis; prosody has to have measured the rows the A/B
        # harness scores against before ab can score anything; autofill consumes
        # both a basis and (optionally) ab's numbers.
        self.assertEqual([t.name for t in cli.TOOLS],
                         ["residuals", "basis", "prosody", "ab", "autofill"])

    def test_the_roster_is_ascii_so_a_cp1252_console_can_print_it(self) -> None:
        "\n".join(cli.roster()).encode("ascii")

    def test_the_refusal_an_operator_actually_hits_names_a_real_command(self) -> None:
        # emotion_basis' no-basis refusal (the 422 a fresh install gets from
        # /derive) points at this dispatcher; the two must not drift apart.
        from service import emotion_basis

        self.assertIn("python -m service.tools basis", emotion_basis.BUILD_HINT)
        self.assertIn("python -m service.tools residuals", emotion_basis.BUILD_HINT)
        for command in ("basis", "residuals"):
            self.assertIn(command, cli.BY_NAME)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
