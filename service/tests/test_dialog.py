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
