"""Who the agent is, and what it says next — the registry and the brains.

No sockets and no model here: the conversation protocol is tested separately,
and everything below is the part that decides what gets said.
"""
from __future__ import annotations

import asyncio
import dataclasses
import json
import tempfile
import unittest
from pathlib import Path

from service import dialog


def collect(backend, agent, history) -> list[str]:
    async def _drain():
        return [s async for s in backend.reply(agent, history)]

    return asyncio.run(_drain())


class RegistryTests(unittest.TestCase):
    def setUp(self) -> None:
        self._orig = dialog.SETTINGS
        self._tmp = tempfile.TemporaryDirectory()
        dialog.SETTINGS = dataclasses.replace(dialog.SETTINGS,
                                              convai_agents_dir=self._tmp.name)

    def tearDown(self) -> None:
        dialog.SETTINGS = self._orig
        self._tmp.cleanup()

    def _write(self, name: str, body) -> Path:
        path = Path(self._tmp.name) / f"{name}.json"
        path.write_text(body if isinstance(body, str) else json.dumps(body), "utf-8")
        return path

    def test_an_empty_directory_is_a_working_installation(self) -> None:
        ids = [a.agent_id for a in dialog.list_agents()]
        self.assertIn("local-interviewer", ids)
        self.assertIsNotNone(dialog.get_agent("local-interviewer"))
        self.assertIsNone(dialog.get_agent("nobody"))

    def test_a_file_agent_joins_the_registry(self) -> None:
        self._write("greeter", {"name": "Greeter", "prompt": "Say hello.",
                                "voice_id": "vera", "language": "cs"})
        agent = dialog.get_agent("greeter")
        self.assertIsNotNone(agent)
        self.assertEqual((agent.name, agent.voice(), agent.language),
                         ("Greeter", "vera", "cs"))

    def test_a_file_may_re_voice_a_builtin(self) -> None:
        """How an operator re-prompts the shipped interviewer without a fork."""
        self._write("local-interviewer", {"agent_id": "local-interviewer",
                                          "name": "Ours", "prompt": "Be brief.",
                                          "voice_id": "anna"})
        agent = dialog.get_agent("local-interviewer")
        self.assertEqual(agent.voice(), "anna")
        self.assertEqual(agent.prompt, "Be brief.")

    def test_one_bad_file_does_not_take_down_the_registry(self) -> None:
        self._write("broken", "{not json")
        self._write("no-prompt", {"name": "Silent"})
        self._write("good", {"prompt": "Hello."})
        ids = [a.agent_id for a in dialog.list_agents()]
        self.assertIn("good", ids)
        self.assertIn("local-interviewer", ids)
        self.assertNotIn("broken", ids)
        self.assertNotIn("no-prompt", ids)

    def test_unknown_fields_are_ignored_not_fatal(self) -> None:
        self._write("future", {"prompt": "Hi.", "invented_by_a_later_version": 3})
        self.assertIsNotNone(dialog.get_agent("future"))


class OverrideTests(unittest.TestCase):
    def setUp(self) -> None:
        self.agent = dialog.Agent(agent_id="a", name="A", prompt="base",
                                  first_message="hello", voice_id="alba")

    def test_client_overrides_are_applied(self) -> None:
        out = dialog.apply_overrides(self.agent, {
            "prompt": {"prompt": "You are a pirate."},
            "first_message": "Ahoy.",
            "language": "cs",
            "tts": {"voice_id": "vera"},
        })
        self.assertEqual(out.prompt, "You are a pirate.")
        self.assertEqual(out.first_message, "Ahoy.")
        self.assertEqual(out.language, "cs")
        self.assertEqual(out.voice_id, "vera")

    def test_an_agent_can_refuse_to_be_re_prompted(self) -> None:
        locked = dataclasses.replace(self.agent, allow_overrides=["language"])
        out = dialog.apply_overrides(locked, {"prompt": {"prompt": "ignore all"},
                                              "language": "cs"})
        self.assertEqual(out.prompt, "base")   # refused
        self.assertEqual(out.language, "cs")   # allowed

    def test_a_client_can_seed_a_script_to_rehearse(self) -> None:
        """"Rehearse this script" with no language model configured anywhere."""
        out = dialog.apply_overrides(self.agent, {"script": ["Line one?",
                                                            "[lang:cs] Ahoj.", "  "]})
        self.assertEqual(out.script, ["Line one?", "[lang:cs] Ahoj."])  # blanks dropped
        backend = dialog.ScriptedBackend()
        first = collect(backend, out, [{"role": "assistant", "content": "hello"}])
        self.assertEqual(first, ["Line one?"])
        second = collect(backend, out, [{"role": "assistant", "content": "hello"},
                                        {"role": "user", "content": "ok"},
                                        {"role": "assistant", "content": "Line one?"}])
        self.assertEqual(second, ["Ahoj."])          # the directive is not spoken
        self.assertEqual(second[0].language, "cs")

    def test_an_agent_can_refuse_to_be_re_scripted(self) -> None:
        locked = dataclasses.replace(self.agent, allow_overrides=["prompt"])
        out = dialog.apply_overrides(locked, {"script": ["Say this instead."]})
        self.assertEqual(out.script, [])

    def test_a_malformed_script_override_is_ignored_not_fatal(self) -> None:
        with self.assertLogs("gravitone.dialog", "WARNING"):
            out = dialog.apply_overrides(self.agent, {"script": "one line"})
        self.assertEqual(out.script, [])

    def test_no_override_returns_the_same_agent(self) -> None:
        self.assertIs(dialog.apply_overrides(self.agent, None), self.agent)
        self.assertIs(dialog.apply_overrides(self.agent, {}), self.agent)


class SentenceStreamTests(unittest.TestCase):
    def test_sentences_emerge_as_they_complete(self) -> None:
        buf = dialog._SentenceBuffer()
        self.assertEqual(buf.push("Hello there"), [])          # nothing final yet
        self.assertEqual(buf.push(". How are"), ["Hello there."])
        self.assertEqual(buf.push(" you? Fine"), ["How are you?"])
        self.assertEqual(buf.drain(), ["Fine"])

    def test_a_model_that_never_stops_is_flushed_anyway(self) -> None:
        """Without this the whole latency argument silently stops applying."""
        buf = dialog._SentenceBuffer()
        out = buf.push("word, " * 60)
        self.assertTrue(out)
        for chunk in out:
            self.assertLessEqual(len(chunk), dialog._FORCE_FLUSH_CHARS)
        # Nothing is lost on the way: every word still comes out, in order.
        self.assertEqual(" ".join(out + buf.drain()).replace(",", "").split(),
                         ["word"] * 60)

    def test_drain_is_empty_when_nothing_is_pending(self) -> None:
        self.assertEqual(dialog._SentenceBuffer().drain(), [])


class TurnPartTests(unittest.TestCase):
    """The compatibility shim: a part IS a string, so nothing downstream cares."""

    def test_a_part_is_a_string_everywhere_a_string_was_expected(self) -> None:
        part = dialog.TurnPart("Hello there.", language="cs", emotion="warm")
        self.assertIsInstance(part, str)
        self.assertEqual(part, "Hello there.")
        self.assertEqual("Hello there.", part)
        self.assertEqual(part.strip(), "Hello there.")
        self.assertEqual(" ".join([part, part]), "Hello there. Hello there.")
        self.assertEqual(len(part), len("Hello there."))
        self.assertEqual(part.encode("utf-8"), b"Hello there.")
        # ...and hashes like its text, so a part and its string are one key.
        self.assertEqual({part: 1}["Hello there."], 1)

    def test_the_direction_rides_alongside_the_words(self) -> None:
        part = dialog.TurnPart("Ahoj.", language="cs", end_call=True)
        self.assertEqual((part.language, part.emotion, part.end_call),
                         ("cs", None, True))
        self.assertTrue(part.directed())
        self.assertFalse(dialog.TurnPart("Hello.").directed())

    def test_an_undirected_part_defaults_to_the_agents_own_performance(self) -> None:
        part = dialog.TurnPart("Hello.")
        self.assertIsNone(part.language)
        self.assertIsNone(part.emotion)
        self.assertFalse(part.end_call)

    def test_a_part_can_be_re_directed_without_rewriting_the_text(self) -> None:
        part = dataclasses.replace(dialog.TurnPart("Ahoj."), language="cs")
        self.assertEqual(part, "Ahoj.")
        self.assertEqual(part.language, "cs")

    def test_the_repr_shows_the_direction(self) -> None:
        self.assertIn("language='cs'", repr(dialog.TurnPart("Ahoj.", language="cs")))


class DirectiveTests(unittest.TestCase):
    """The grammar the brain directs itself with — and the guarantees around it."""

    @staticmethod
    def stream(*deltas: str) -> list[dialog.TurnPart]:
        buf = dialog._SentenceBuffer()
        out: list[dialog.TurnPart] = []
        for delta in deltas:
            out += buf.push(delta)
        return out + buf.drain()

    def test_a_directive_is_never_spoken(self) -> None:
        parts = self.stream("[emotion:warm] Thanks for that. What did you build?")
        self.assertEqual(parts, ["Thanks for that.", "What did you build?"])
        self.assertNotIn("[", " ".join(parts))
        self.assertEqual([p.emotion for p in parts], ["warm", "warm"])

    def test_a_language_switch_starts_a_new_part(self) -> None:
        parts = self.stream("Of course. [lang:cs] Ahoj, jak se máte?")
        self.assertEqual(parts, ["Of course.", "Ahoj, jak se máte?"])
        self.assertEqual([p.language for p in parts], [None, "cs"])

    def test_a_switch_mid_sentence_closes_the_old_language_first(self) -> None:
        """The mouth must not change inside a sentence — that is the audible seam."""
        parts = self.stream("One moment [lang:cs] ano, rozumím.")
        self.assertEqual([(str(p), p.language) for p in parts],
                         [("One moment", None), ("ano, rozumím.", "cs")])

    def test_end_call_written_after_the_last_sentence_attaches_to_it(self) -> None:
        parts = self.stream("Thanks for your time. [end_call]")
        self.assertEqual(parts, ["Thanks for your time."])
        self.assertTrue(parts[-1].end_call)

    def test_end_call_survives_as_a_pure_direction_when_it_arrives_too_late(self) -> None:
        """The sentence was already released for synthesis; the hang-up was not.

        Holding sentences back on the chance a directive follows would cost the
        whole streaming latency win, so the hang-up arrives as a wordless part.
        """
        parts = self.stream("Thanks for your time. ", "[end_call]")
        self.assertEqual([str(p) for p in parts], ["Thanks for your time.", ""])
        self.assertTrue(parts[-1].end_call)
        self.assertFalse(parts[-1].speakable())
        self.assertTrue(parts[0].speakable())
        self.assertFalse(parts[0].end_call)

    def test_end_call_before_more_words_rides_out_with_them(self) -> None:
        parts = self.stream("[end_call] Goodbye for now.")
        self.assertEqual(parts, ["Goodbye for now."])
        self.assertTrue(parts[-1].end_call)
        self.assertTrue(parts[-1].speakable())   # no wordless part needed

    def test_the_hang_up_is_signalled_exactly_once(self) -> None:
        parts = self.stream("[end_call] One. Two.")
        self.assertEqual(parts, ["One.", "Two."])
        self.assertTrue(all(p.speakable() for p in parts))

    def test_a_directive_split_across_chunks_cannot_leak(self) -> None:
        """The case that would put "[lan" through a synthesizer."""
        for cut in range(1, len("[lang:cs]")):
            head, tail = "[lang:cs]"[:cut], "[lang:cs]"[cut:]
            parts = self.stream("Fine. ", head, tail, " Ahoj.")
            self.assertEqual(parts, ["Fine.", "Ahoj."], cut)
            self.assertNotIn("[", " ".join(parts), cut)
            self.assertEqual(parts[-1].language, "cs", cut)

    def test_a_directive_arriving_one_character_at_a_time_cannot_leak(self) -> None:
        parts = self.stream(*list("Fine. [emotion:warm] Good."))
        self.assertEqual(parts, ["Fine.", "Good."])
        self.assertEqual(parts[-1].emotion, "warm")

    def test_a_truncated_directive_is_dropped_not_spoken(self) -> None:
        with self.assertLogs("gravitone.dialog", "WARNING"):
            parts = self.stream("Almost done. [lang:c")
        self.assertEqual(parts, ["Almost done."])
        self.assertNotIn("lang", " ".join(parts))

    def test_an_unknown_directive_is_dropped_and_logged_never_voiced(self) -> None:
        with self.assertLogs("gravitone.dialog", "WARNING") as logged:
            parts = self.stream("[laughs] That's funny. [pace:fast] Anyway.")
        self.assertEqual(parts, ["That's funny.", "Anyway."])
        self.assertIn("laughs", " ".join(logged.output))
        self.assertIn("pace", " ".join(logged.output))

    def test_a_directive_with_no_value_is_not_a_directive(self) -> None:
        with self.assertLogs("gravitone.dialog", "WARNING"):
            parts = self.stream("[lang:] Hello.")
        self.assertEqual(parts, ["Hello."])
        self.assertIsNone(parts[0].language)

    def test_a_bracket_in_ordinary_prose_is_still_spoken(self) -> None:
        """A model that opens a bracket and never closes it must not mute the turn."""
        text = "We use Kotlin [" + "x" * 60 + " and Rust."
        parts = self.stream(text)
        self.assertIn("Kotlin [", " ".join(parts))
        self.assertIn("Rust", " ".join(parts))

    def test_a_regional_tag_is_normalized(self) -> None:
        self.assertEqual(self.stream("[lang:cs-CZ] Ahoj.")[0].language, "cs")

    def test_split_sentences_strips_directives_too(self) -> None:
        """The opening line goes through this path, so it needs the same guarantee."""
        parts = dialog.split_sentences("[lang:cs] Dobrý den. Jak se máte?")
        self.assertEqual(parts, ["Dobrý den.", "Jak se máte?"])
        self.assertEqual([p.language for p in parts], ["cs", "cs"])

    def test_pending_covers_a_half_received_directive(self) -> None:
        buf = dialog._SentenceBuffer()
        buf.push("[lang:c")
        self.assertTrue(buf.pending())


class LanguageTrackerTests(unittest.TestCase):
    """When the mouth is allowed to follow the ear."""

    def agent(self, **kwargs) -> dialog.Agent:
        base = {"agent_id": "a", "name": "A", "prompt": "p", "language": "en",
                "languages": ["cs"]}
        return dialog.Agent(**(base | kwargs))

    def test_one_utterance_does_not_flap_the_voice(self) -> None:
        tracker = dialog.LanguageTracker(self.agent())
        self.assertIsNone(tracker.heard("cs"))
        self.assertEqual(tracker.caller, "en")

    def test_two_consecutive_utterances_switch(self) -> None:
        tracker = dialog.LanguageTracker(self.agent())
        tracker.heard("cs")
        self.assertEqual(tracker.heard("cs"), "cs")
        self.assertEqual(tracker.caller, "cs")
        # ...and it does not keep re-announcing the switch it already made.
        self.assertIsNone(tracker.heard("cs"))

    def test_the_ear_alone_never_moves_the_mouth(self) -> None:
        """A Czech voice reading an English sentence is the failure mode here.

        The ear confirming Czech does NOT mean the brain answered in Czech, so
        the spoken language waits for the brain's own directive.
        """
        tracker = dialog.LanguageTracker(self.agent())
        tracker.heard("cs")
        tracker.heard("cs")
        self.assertEqual(tracker.caller, "cs")
        self.assertEqual(tracker.language, "en")     # still the mouth we resolved
        self.assertEqual(tracker.directed("cs"), "cs")
        self.assertEqual(tracker.language, "cs")

    def test_an_interrupted_streak_starts_over(self) -> None:
        tracker = dialog.LanguageTracker(self.agent())
        tracker.heard("cs")
        tracker.heard("en")          # back to the base language
        self.assertIsNone(tracker.heard("cs"))
        self.assertEqual(tracker.caller, "en")

    def test_a_low_confidence_guess_is_not_a_vote(self) -> None:
        tracker = dialog.LanguageTracker(self.agent())
        tracker.heard("cs", probability=0.2)
        self.assertIsNone(tracker.heard("cs", probability=0.2))

    def test_an_undeclared_language_is_refused_and_counted(self) -> None:
        """The demand signal that says which Piper voice to install next."""
        tracker = dialog.LanguageTracker(self.agent(languages=[]))
        tracker.heard("de")
        self.assertIsNone(tracker.heard("de"))
        self.assertEqual(tracker.declined, {"de": 2})

    def test_the_brain_switches_without_hysteresis(self) -> None:
        """A directive is explicit; only the EAR's guess needs confirming."""
        tracker = dialog.LanguageTracker(self.agent())
        self.assertEqual(tracker.directed("cs"), "cs")
        self.assertIsNone(tracker.directed("cs"))       # already there
        self.assertIsNone(tracker.directed("de"))       # not declared
        self.assertEqual(tracker.declined, {"de": 1})


class DirectingPromptTests(unittest.TestCase):
    def agent(self, **kwargs) -> dialog.Agent:
        base = {"agent_id": "a", "name": "A", "prompt": "Be brief."}
        return dialog.Agent(**(base | kwargs))

    def test_the_agents_own_brief_is_kept_intact(self) -> None:
        self.assertTrue(dialog.directing_prompt(self.agent()).startswith("Be brief."))

    def test_a_polyglot_agent_is_told_how_to_switch(self) -> None:
        prompt = dialog.directing_prompt(self.agent(languages=["cs"]))
        self.assertIn("[lang:XX]", prompt)
        self.assertIn("Czech", prompt)

    def test_a_monolingual_agent_is_told_to_stay_put(self) -> None:
        prompt = dialog.directing_prompt(self.agent())
        self.assertIn("Stay in it", prompt)
        self.assertNotIn("may switch into", prompt)

    def test_the_last_heard_language_is_named(self) -> None:
        prompt = dialog.directing_prompt(self.agent(languages=["cs"]), heard="cs-CZ")
        self.assertIn("heard as Czech", prompt)

    def test_the_directive_grammar_is_always_explained(self) -> None:
        for prompt in (dialog.directing_prompt(self.agent()),
                       dialog.directing_prompt(self.agent(languages=["cs"]))):
            self.assertIn("[end_call]", prompt)
            self.assertIn("never read one out loud", prompt)


class SwitchApologyTests(unittest.TestCase):
    """An unspeakable switch is refused IN THE LANGUAGE WE CAN SPEAK."""

    def test_english_names_the_language_it_cannot_speak(self) -> None:
        said = dialog.switch_apology("en", "de")
        self.assertIn("German", said)
        self.assertIn("English", said)

    def test_a_czech_agent_apologizes_in_czech(self) -> None:
        said = dialog.switch_apology("cs", "en")
        self.assertIn("Omlouvám se", said)
        self.assertIn("anglicky", said)
        self.assertNotIn("English", said)

    def test_an_unlisted_language_is_named_by_its_code_not_guessed_at(self) -> None:
        self.assertIn("hu", dialog.switch_apology("en", "hu-HU"))

    def test_an_unknown_speaking_language_still_says_something(self) -> None:
        self.assertTrue(dialog.switch_apology("hu", "de"))


class AgentLanguageMatrixTests(unittest.TestCase):
    def test_an_agent_declares_which_switches_it_honours(self) -> None:
        agent = dialog.Agent(agent_id="a", name="A", prompt="p", language="en",
                             languages=["cs-CZ", "cs", "de"])
        self.assertEqual(agent.switch_languages(), ["en", "cs", "de"])
        self.assertTrue(agent.honours("cs"))
        self.assertTrue(agent.honours("de-AT"))
        self.assertFalse(agent.honours("fr"))
        self.assertFalse(agent.honours(None))

    def test_by_default_an_agent_honours_only_its_own_language(self) -> None:
        agent = dialog.Agent(agent_id="a", name="A", prompt="p", language="cs")
        self.assertEqual(agent.switch_languages(), ["cs"])
        self.assertFalse(agent.honours("en"))

    def test_a_file_agent_can_declare_the_matrix(self) -> None:
        import json as jsonmod
        import tempfile as tempmod

        with tempmod.TemporaryDirectory() as tmp:
            Path(tmp, "poly.json").write_text(jsonmod.dumps(
                {"prompt": "p", "language": "en", "languages": ["cs"]}), "utf-8")
            orig = dialog.SETTINGS
            dialog.SETTINGS = dataclasses.replace(orig, convai_agents_dir=tmp)
            try:
                self.assertEqual(dialog.get_agent("poly").switch_languages(),
                                 ["en", "cs"])
            finally:
                dialog.SETTINGS = orig


class ScriptedBackendTests(unittest.TestCase):
    def setUp(self) -> None:
        self.agent = dialog.Agent(
            agent_id="s", name="S", prompt="p", first_message="Welcome.",
            script=["First question?", "Second question?", "Goodbye."])
        self.backend = dialog.ScriptedBackend()

    def _turn(self, assistant_turns: int) -> list[str]:
        history = []
        for _ in range(assistant_turns):
            history.append({"role": "user", "content": "ok"})
            history.append({"role": "assistant", "content": "said"})
        return collect(self.backend, self.agent, history)

    def test_the_script_advances_with_the_conversation(self) -> None:
        # One assistant turn so far = the first message; the script starts next.
        self.assertEqual(self._turn(1), ["First question?"])
        self.assertEqual(self._turn(2), ["Second question?"])
        self.assertEqual(self._turn(3), ["Goodbye."])

    def test_it_holds_on_the_last_line_rather_than_running_out(self) -> None:
        self.assertEqual(self._turn(9), ["Goodbye."])

    def test_position_comes_from_history_so_one_instance_serves_everyone(self) -> None:
        # Two interleaved conversations through the SAME backend instance.
        self.assertEqual(self._turn(1), ["First question?"])
        self.assertEqual(self._turn(2), ["Second question?"])
        self.assertEqual(self._turn(1), ["First question?"])

    def test_a_multi_sentence_line_arrives_as_separate_sentences(self) -> None:
        agent = dataclasses.replace(self.agent, script=["Thanks. And then what?"])
        self.assertEqual(collect(self.backend, agent,
                                 [{"role": "assistant", "content": "x"}]),
                         ["Thanks.", "And then what?"])

    def test_a_script_line_can_direct_itself(self) -> None:
        """How a language-switch test stays deterministic without a model."""
        agent = dataclasses.replace(
            self.agent, script=["[lang:cs] Dobrý den. Jak se máte?"])
        parts = collect(self.backend, agent, [{"role": "assistant", "content": "x"}])
        self.assertEqual(parts, ["Dobrý den.", "Jak se máte?"])
        self.assertEqual([p.language for p in parts], ["cs", "cs"])

    def test_a_script_can_end_the_call(self) -> None:
        agent = dataclasses.replace(self.agent, script=["Thanks. [end_call]"])
        parts = collect(self.backend, agent, [{"role": "assistant", "content": "x"}])
        self.assertEqual(parts, ["Thanks."])
        self.assertTrue(parts[-1].end_call)

    def test_an_agent_with_no_script_still_answers(self) -> None:
        agent = dataclasses.replace(self.agent, script=[])
        self.assertTrue(collect(self.backend, agent, []))


class BackendSelectionTests(unittest.TestCase):
    def test_names_map_to_backends(self) -> None:
        self.assertIsInstance(dialog.make_backend("scripted"), dialog.ScriptedBackend)
        self.assertIsInstance(dialog.make_backend("ollama"), dialog.OpenAiCompatBackend)

    def test_a_typo_falls_back_instead_of_failing_the_session(self) -> None:
        self.assertIsInstance(dialog.make_backend("gtp-4"), dialog.ScriptedBackend)

    def test_the_backend_says_what_it_is(self) -> None:
        described = dialog.OpenAiCompatBackend(base_url="http://x/v1",
                                               model="m").describe()
        self.assertEqual(described["backend"], "openai-compat")
        self.assertEqual(described["model"], "m")


class OpenAiCompatOverHttpTests(unittest.TestCase):
    """The model-backed brain against a REAL socket.

    Parsing one SSE line is unit-testable; "does this backend actually stream
    from an OpenAI-compatible server" is not. A throwaway HTTP server closes
    that gap without needing a model: it asserts the request shape the backend
    sends and streams a reply back the way a real server does.
    """

    def setUp(self) -> None:
        import json as jsonmod
        import threading
        from http.server import BaseHTTPRequestHandler, HTTPServer

        received: list[dict] = []
        self.received = received
        chunks = ["Thanks", " for that.", " What", " did you", " build?"]
        self.status = 200

        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802 - stdlib naming
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                received.append({"path": self.path,
                                 "auth": self.headers.get("Authorization"),
                                 **jsonmod.loads(body)})
                if outer.status != 200:
                    self.send_response(outer.status)
                    self.end_headers()
                    self.wfile.write(b"model not found")
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                for piece in chunks:
                    frame = jsonmod.dumps({"choices": [{"delta": {"content": piece}}]})
                    self.wfile.write(f"data: {frame}\n\n".encode())
                self.wfile.write(b": keep-alive\n\n")   # framing the parser must ignore
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()

            def log_message(self, *a):  # silence the test log
                return

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        host, port = self.server.server_address
        self.base_url = f"http://{host}:{port}/v1"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def _backend(self, **kwargs) -> dialog.OpenAiCompatBackend:
        return dialog.OpenAiCompatBackend(base_url=self.base_url, model="test-model",
                                          **kwargs)

    def test_a_streamed_reply_arrives_as_whole_sentences(self) -> None:
        agent = dialog.Agent(agent_id="a", name="A", prompt="Be brief.")
        out = collect(self._backend(), agent, [{"role": "user", "content": "hi"}])
        # Deltas split mid-sentence; what comes out is speakable units, which is
        # what lets synthesis start before the model has finished writing.
        self.assertEqual(out, ["Thanks for that.", "What did you build?"])

    def test_the_request_carries_the_prompt_as_a_system_turn(self) -> None:
        agent = dialog.Agent(agent_id="a", name="A", prompt="You are an interviewer.",
                             temperature=0.7)
        collect(self._backend(), agent, [{"role": "user", "content": "hello"}])
        sent = self.received[-1]
        self.assertEqual(sent["path"], "/v1/chat/completions")
        self.assertEqual(sent["model"], "test-model")
        self.assertTrue(sent["stream"])
        self.assertEqual(sent["temperature"], 0.7)
        self.assertEqual(sent["messages"][0],
                         {"role": "system", "content": "You are an interviewer."})
        self.assertEqual(sent["messages"][1], {"role": "user", "content": "hello"})
        self.assertIsNone(sent["auth"])  # no key configured -> no header

    def test_an_api_key_is_sent_as_a_bearer_token(self) -> None:
        agent = dialog.Agent(agent_id="a", name="A", prompt="p")
        collect(self._backend(api_key="sk-local"), agent, [])
        self.assertEqual(self.received[-1]["auth"], "Bearer sk-local")

    def test_a_refusing_server_says_so_in_words(self) -> None:
        self.status = 404
        agent = dialog.Agent(agent_id="a", name="A", prompt="p")
        with self.assertRaises(dialog.DialogError) as caught:
            collect(self._backend(), agent, [])
        self.assertIn("404", str(caught.exception))

    def test_an_unreachable_model_names_the_env_var_to_fix(self) -> None:
        agent = dialog.Agent(agent_id="a", name="A", prompt="p")
        dead = dialog.OpenAiCompatBackend(base_url="http://127.0.0.1:1/v1", model="m")
        with self.assertRaises(dialog.DialogError) as caught:
            collect(dead, agent, [])
        message = str(caught.exception)
        self.assertIn("CONVAI_LLM_BASE_URL", message)
        self.assertIn("scripted", message)  # and the way to run without one


class SseParsingTests(unittest.TestCase):
    def test_a_delta_line_yields_its_text(self) -> None:
        line = 'data: {"choices":[{"delta":{"content":"Hi"}}]}'
        self.assertEqual(dialog._sse_delta(line), "Hi")

    def test_framing_and_keepalives_yield_nothing(self) -> None:
        for line in ("", ": keep-alive", "data: [DONE]", "event: message",
                     "data: {broken", 'data: {"choices":[]}',
                     'data: {"choices":[{"delta":{}}]}'):
            self.assertEqual(dialog._sse_delta(line), "", line)


if __name__ == "__main__":
    unittest.main()
