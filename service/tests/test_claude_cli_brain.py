"""The Claude CLI as the interviewer — argv, streaming, and the tool guard.

The subprocess machinery is tested against a FAKE cli: a small Python script
that emits the same ``stream-json`` lines the real one does. That exercises the
part which actually breaks — process spawn, JSONL parsing, sentence streaming,
the tool-use abort, the timeout, the kill on cancellation — without spending a
subscription call or needing a network. The argv itself is asserted separately,
because the flags are a safety contract and not an implementation detail.

The live CLI is exercised opt-in:

    GRAVITONE_CLAUDE_CLI=1 python -m unittest service.tests.test_claude_cli_brain
"""
from __future__ import annotations

import asyncio
import dataclasses
import json
import os
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

from service import dialog

LIVE = os.environ.get("GRAVITONE_CLAUDE_CLI") == "1"


def collect(backend, agent, history) -> list[str]:
    async def _drain():
        return [s async for s in backend.reply(agent, history)]

    return asyncio.run(_drain())


AGENT = dialog.Agent(agent_id="i", name="I", prompt="You are an interviewer.")


# --- the fake cli ----------------------------------------------------------
# Prints canned stream-json. `scenario` selects what goes wrong, so each failure
# mode is reproducible without waiting for a real model to misbehave.
_FAKE = textwrap.dedent('''
    import json, sys, time
    scenario = sys.argv[-1]
    sys.stdin.read()

    def emit(obj):
        sys.stdout.write(json.dumps(obj) + "\\n")
        sys.stdout.flush()

    def delta(kind, text):
        return {"type": "stream_event",
                "event": {"type": "content_block_delta",
                          "delta": {"type": kind, "text": text, "thinking": text}}}

    emit({"type": "system", "subtype": "init", "tools": []})
    if scenario == "thinking_only":
        emit(delta("thinking_delta", "Let me consider the candidate..."))
        emit({"type": "result", "subtype": "success"})
    elif scenario == "tool_use":
        emit({"type": "stream_event",
              "event": {"type": "content_block_start",
                        "content_block": {"type": "tool_use", "name": "Bash"}}})
        time.sleep(30)
    elif scenario == "tool_use_message":
        emit({"type": "assistant",
              "message": {"content": [{"type": "tool_use", "name": "Write"}]}})
        time.sleep(30)
    elif scenario == "crash":
        sys.stderr.write("not logged in\\n")
        sys.exit(2)
    elif scenario == "hang":
        time.sleep(60)
    elif scenario == "junk":
        sys.stdout.write("this is not json\\n")
        sys.stdout.flush()
        emit(delta("text_delta", "Still fine."))
        emit({"type": "result", "subtype": "success"})
    else:
        emit(delta("thinking_delta", "reasoning that must not be spoken"))
        for piece in ["That's ", "helpful.", " What did you build", "?"]:
            emit(delta("text_delta", piece))
        emit({"type": "result", "subtype": "success"})
''')


class _FakeCliBackend(dialog.ClaudeCliBackend):
    """Real reply()/streaming code, pointed at the fake cli above."""

    def __init__(self, script: Path, scenario: str = "ok"):
        super().__init__()
        self._script = script
        self._scenario = scenario

    def _argv(self, agent):  # noqa: D102 - see class docstring
        return [sys.executable, str(self._script), self._scenario]


class _FakeCliCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.script = Path(self._tmp.name) / "fake_claude.py"
        self.script.write_text(_FAKE, "utf-8")
        self._orig = dialog.SETTINGS

    def tearDown(self) -> None:
        dialog.SETTINGS = self._orig
        self._tmp.cleanup()


class StreamingTests(_FakeCliCase):
    def test_a_reply_arrives_as_whole_sentences(self) -> None:
        out = collect(_FakeCliBackend(self.script), AGENT, [])
        self.assertEqual(out, ["That's helpful.", "What did you build?"])

    def test_reasoning_is_never_spoken(self) -> None:
        """Thinking is not part of what the agent says out loud.

        If it leaked it would go into the transcript AND through the
        synthesizer, so the candidate would hear the model deliberating.
        """
        out = collect(_FakeCliBackend(self.script), AGENT, [])
        self.assertNotIn("reasoning that must not be spoken", " ".join(out))

    def test_a_turn_that_only_thought_says_nothing(self) -> None:
        self.assertEqual(collect(_FakeCliBackend(self.script, "thinking_only"), AGENT, []), [])

    def test_one_unparseable_line_does_not_lose_the_turn(self) -> None:
        out = collect(_FakeCliBackend(self.script, "junk"), AGENT, [])
        self.assertEqual(out, ["Still fine."])


class ToolGuardTests(_FakeCliCase):
    def test_a_tool_call_stops_the_turn(self) -> None:
        """The guarantee that does not depend on knowing the tool's name."""
        with self.assertRaises(dialog.DialogError) as caught:
            collect(_FakeCliBackend(self.script, "tool_use"), AGENT, [])
        self.assertIn("Bash", str(caught.exception))

    def test_a_tool_call_in_a_whole_message_is_caught_too(self) -> None:
        with self.assertRaises(dialog.DialogError) as caught:
            collect(_FakeCliBackend(self.script, "tool_use_message"), AGENT, [])
        self.assertIn("Write", str(caught.exception))

    def test_the_denylist_covers_everything_that_can_act(self) -> None:
        for tool in ("Bash", "PowerShell", "Write", "Edit", "Read", "WebFetch",
                     "Task", "Skill", "CronCreate", "RemoteTrigger", "SendMessage"):
            self.assertIn(tool, dialog.ClaudeCliBackend.DISALLOWED, tool)


class FailureTests(_FakeCliCase):
    def test_a_cli_that_cannot_run_reports_its_stderr(self) -> None:
        with self.assertRaises(dialog.DialogError) as caught:
            collect(_FakeCliBackend(self.script, "crash"), AGENT, [])
        self.assertIn("not logged in", str(caught.exception))

    def test_a_silent_cli_times_out_with_advice(self) -> None:
        dialog.SETTINGS = dataclasses.replace(dialog.SETTINGS, claude_cli_timeout_s=1.0)
        with self.assertRaises(dialog.DialogError) as caught:
            collect(_FakeCliBackend(self.script, "hang"), AGENT, [])
        message = str(caught.exception)
        self.assertIn("CLAUDE_CLI_TIMEOUT_S", message)
        self.assertIn("scripted", message)

    def test_a_missing_executable_names_the_way_out(self) -> None:
        backend = dialog.ClaudeCliBackend(command="claude-does-not-exist")
        self.assertFalse(backend.available())
        with self.assertRaises(dialog.DialogError) as caught:
            collect(backend, AGENT, [])
        self.assertIn("CONVAI_LLM=scripted", str(caught.exception))

    def test_an_abandoned_turn_does_not_leave_the_cli_thinking(self) -> None:
        """A barge-in cancels the turn; the subprocess must not outlive it.

        An orphaned CLI keeps working (and keeps spending) for a reply nobody
        will ever hear.
        """
        backend = _FakeCliBackend(self.script, "hang")

        async def _cancel_mid_turn():
            agen = backend.reply(AGENT, [])
            task = asyncio.ensure_future(agen.__anext__())
            await asyncio.sleep(0.5)
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            await agen.aclose()          # what an interrupted `async for` does
            return backend

        asyncio.run(_cancel_mid_turn())
        # aclose() ran the generator's finally, which kills the child. If it had
        # not, this process would still have a live grandchild sleeping 60s.


class ArgvTests(unittest.TestCase):
    """The flags are a safety contract, so they are asserted directly."""

    def setUp(self) -> None:
        self.backend = dialog.ClaudeCliBackend()
        if not self.backend.available():
            self.skipTest("the Claude CLI is not installed on this box")

    def test_the_agent_brief_replaces_claude_codes_own_identity(self) -> None:
        argv = self.backend._argv(AGENT)
        self.assertIn("--system-prompt", argv)
        prompt = argv[argv.index("--system-prompt") + 1]
        self.assertIn("You are an interviewer.", prompt)
        # ...and the model is told to emit only speech.
        self.assertIn("say out loud", prompt)

    def test_the_dangerous_tools_are_refused_on_the_command_line(self) -> None:
        argv = self.backend._argv(AGENT)
        self.assertIn("--disallowed-tools", argv)
        tail = argv[argv.index("--disallowed-tools") + 1:]
        for tool in ("Bash", "Write", "PowerShell"):
            self.assertIn(tool, tail)
        # --allowed-tools is NOT used: it only decides what is pre-approved and
        # leaves every tool callable, which reads like a guard and is not one.
        self.assertNotIn("--allowed-tools", argv)

    def test_the_session_inherits_no_project_configuration(self) -> None:
        argv = self.backend._argv(AGENT)
        self.assertEqual(argv[argv.index("--setting-sources") + 1], "")
        self.assertIn("--strict-mcp-config", argv)

    def test_it_streams_so_synthesis_can_start_early(self) -> None:
        argv = self.backend._argv(AGENT)
        self.assertIn("--output-format", argv)
        self.assertEqual(argv[argv.index("--output-format") + 1], "stream-json")
        self.assertIn("--include-partial-messages", argv)
        self.assertIn("--verbose", argv)  # stream-json requires it


class TranscriptTests(unittest.TestCase):
    def test_history_becomes_a_readable_two_party_transcript(self) -> None:
        text = dialog.ClaudeCliBackend._transcript(AGENT, [
            {"role": "assistant", "content": "Tell me about your background."},
            {"role": "user", "content": "Six years of Python."},
        ])
        self.assertIn("You: Tell me about your background.", text)
        self.assertIn("Candidate: Six years of Python.", text)

    def test_the_first_turn_says_the_call_just_connected(self) -> None:
        self.assertIn("just connected", dialog.ClaudeCliBackend._transcript(AGENT, []))

    def test_the_other_party_can_be_someone_other_than_a_candidate(self) -> None:
        """An agent that IS the candidate must not call the interviewer one.

        This is what a two-sided simulation needs: the same backend drives both
        seats, and each has to see the other correctly labelled.
        """
        persona = dataclasses.replace(AGENT, counterpart="Interviewer")
        text = dialog.ClaudeCliBackend._transcript(persona, [
            {"role": "user", "content": "Tell me about your background."},
            {"role": "assistant", "content": "Eight years in payments."},
        ])
        self.assertIn("Interviewer: Tell me about your background.", text)
        self.assertIn("You: Eight years in payments.", text)
        self.assertNotIn("Candidate:", text)


class SelectionTests(unittest.TestCase):
    def test_the_name_maps_to_the_backend(self) -> None:
        made = dialog.make_backend("claude-cli")
        # Falls back to scripted on a box with no CLI — asserted either way so
        # this passes in CI and locally.
        if dialog.ClaudeCliBackend().available():
            self.assertIsInstance(made, dialog.ClaudeCliBackend)
        else:
            self.assertIsInstance(made, dialog.ScriptedBackend)

    def test_an_absent_cli_falls_back_instead_of_failing_the_session(self) -> None:
        orig = dialog.SETTINGS
        dialog.SETTINGS = dataclasses.replace(orig, claude_cli_command="claude-nope")
        try:
            self.assertIsInstance(dialog.make_backend("claude-cli"), dialog.ScriptedBackend)
        finally:
            dialog.SETTINGS = orig


@unittest.skipUnless(LIVE, "set GRAVITONE_CLAUDE_CLI=1 (spends a subscription call)")
class LiveClaudeTests(unittest.TestCase):
    def test_it_answers_what_the_candidate_actually_said(self) -> None:
        backend = dialog.ClaudeCliBackend()
        if not backend.available():
            self.skipTest("the Claude CLI is not installed")
        agent = dialog.Agent(
            agent_id="i", name="I",
            prompt="You are a job interviewer conducting a spoken screening "
                   "interview. Ask ONE question at a time, two sentences maximum.")
        out = collect(backend, agent, [
            {"role": "assistant", "content": "Tell me about your background."},
            {"role": "user",
             "content": "I spent six years building payment systems in Kotlin."},
        ])
        joined = " ".join(out)
        print(f"\n  live reply: {joined}")
        self.assertTrue(out)
        # A real model reacts to the content; a canned one could not.
        self.assertRegex(joined.lower(), r"kotlin|payment|system|build")


if __name__ == "__main__":
    unittest.main()
