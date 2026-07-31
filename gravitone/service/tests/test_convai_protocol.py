"""The conversation socket — the wire protocol an ElevenLabs client expects.

Driven end to end with a fake worker pool and a stubbed transcriber, so these
cases exercise the protocol and the turn-taking rather than the model stack:
what the socket accepts, what it sends and in which order, what an interruption
does, and what happens to a sound that turns out not to contain any words.
"""
from __future__ import annotations

import dataclasses
import time
import unittest

from service.tests import fake_engine  # installs shims — must precede app import

import service.app as appmod  # noqa: E402
from service import convai, dialog, stt  # noqa: E402
from service.tests.test_vad import silence, tone  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
import base64  # noqa: E402

AGENT = "local-interviewer"


def heard(text: str) -> stt.Transcript:
    return stt.Transcript(text=text, language_code="en", language_probability=1.0,
                          duration_s=1.0, transcribe_s=0.01)


class TicketTests(unittest.TestCase):
    """A connect ticket is the only credential a browser socket can carry."""

    def test_a_fresh_ticket_opens_its_own_agent(self) -> None:
        ticket = convai.mint_ticket(AGENT)
        self.assertTrue(convai.verify_ticket(AGENT, ticket))

    def test_a_ticket_is_bound_to_one_agent(self) -> None:
        ticket = convai.mint_ticket("cheap-agent")
        self.assertFalse(convai.verify_ticket("expensive-agent", ticket))

    def test_an_expired_ticket_is_refused(self) -> None:
        self.assertFalse(convai.verify_ticket(AGENT, convai.mint_ticket(AGENT, ttl_s=-1)))

    def test_tampering_is_refused(self) -> None:
        exp, nonce, sig = convai.mint_ticket(AGENT).split(".", 2)
        for forged in (f"{exp}.{nonce}.{'0' * len(sig)}",     # forged signature
                       f"{int(exp) + 3600}.{nonce}.{sig}",    # extended life
                       f"{exp}.{nonce}", "", "garbage", None):
            self.assertFalse(convai.verify_ticket(AGENT, forged), forged)


class SessionAccountingTests(unittest.TestCase):
    def setUp(self) -> None:
        self._orig = convai.SETTINGS
        convai.SETTINGS = dataclasses.replace(convai.SETTINGS, convai_max_sessions=2)
        convai._Sessions.active = 0

    def tearDown(self) -> None:
        convai.SETTINGS = self._orig
        convai._Sessions.active = 0

    def test_the_cap_refuses_rather_than_queues(self) -> None:
        self.assertTrue(convai._Sessions.take())
        self.assertTrue(convai._Sessions.take())
        self.assertFalse(convai._Sessions.take())
        convai._Sessions.give_back()
        self.assertTrue(convai._Sessions.take())

    def test_the_count_never_goes_negative(self) -> None:
        convai._Sessions.give_back()
        self.assertEqual(convai._Sessions.active, 0)


class ConversationTests(unittest.TestCase):
    """The socket itself, driven the way the browser SDK drives it."""

    def setUp(self) -> None:
        self._orig_engine = appmod.ENGINE
        self._orig_transcribe = stt.transcribe_pcm
        self._orig_backend = convai._BACKEND
        convai._BACKEND = dialog.ScriptedBackend()
        self.heard_texts = ["I've been building backend services for six years."]
        self._calls = 0

        def _fake_transcribe(pcm, **kwargs):
            i = min(self._calls, len(self.heard_texts) - 1)
            self._calls += 1
            return heard(self.heard_texts[i])

        stt.transcribe_pcm = _fake_transcribe
        self.client = TestClient(appmod.app)

    def tearDown(self) -> None:
        appmod.ENGINE = self._orig_engine
        stt.transcribe_pcm = self._orig_transcribe
        convai._BACKEND = self._orig_backend
        convai._Sessions.active = 0
        engine = getattr(self, "engine", None)
        if engine is not None:
            engine.close()

    # -- helpers ------------------------------------------------------------
    def _engine(self, **kwargs) -> None:
        self.engine = fake_engine.FakeEngine(workers=2, **kwargs)
        appmod.ENGINE = self.engine

    def _url(self, agent_id: str = AGENT) -> str:
        res = self.client.get("/v1/convai/conversation/get-signed-url",
                              params={"agent_id": agent_id})
        self.assertEqual(res.status_code, 200)
        # The mint hands back an absolute ws:// URL; the test client wants the path.
        return res.json()["signed_url"].split("testserver", 1)[1]

    @staticmethod
    def _init(ws, **agent_override) -> None:
        ws.send_json({"type": "conversation_initiation_client_data",
                      "conversation_config_override": {"agent": agent_override}})

    @staticmethod
    def _speak(ws, ms: int = 700) -> None:
        """Stream one utterance the way a real client does: in real-time-sized
        chunks, with enough trailing silence for the gate to call the turn."""
        audio = silence(300) + tone(ms) + silence(1000)
        step = 16000 * 2 // 10  # 100 ms
        for i in range(0, len(audio), step):
            ws.send_json({"user_audio_chunk":
                          base64.b64encode(audio[i:i + step]).decode("ascii")})

    @staticmethod
    def _until(ws, kind: str, limit: int = 200) -> tuple[dict, list[dict]]:
        """Read to the next message of ``kind``, returning it and what preceded."""
        seen: list[dict] = []
        for _ in range(limit):
            msg = ws.receive_json()
            if msg.get("type") == kind:
                return msg, seen
            seen.append(msg)
        raise AssertionError(f"never saw a {kind!r}; got {[m.get('type') for m in seen]}")

    # -- cases --------------------------------------------------------------
    def test_the_handshake_announces_the_conversation(self) -> None:
        self._engine()
        with self.client.websocket_connect(self._url()) as ws:
            self._init(ws)
            meta = ws.receive_json()
            self.assertEqual(meta["type"], "conversation_initiation_metadata")
            event = meta["conversation_initiation_metadata_event"]
            self.assertTrue(event["conversation_id"])
            # The client parses the rate out of this to run its playback clock.
            self.assertEqual(event["agent_output_audio_format"], "pcm_16000")
            self.assertEqual(event["user_input_audio_format"], "pcm_16000")

    def test_the_agent_opens_the_conversation(self) -> None:
        self._engine()
        with self.client.websocket_connect(self._url()) as ws:
            self._init(ws)
            ws.receive_json()  # metadata
            reply, before = self._until(ws, "agent_response")
            # Text lands BEFORE audio: clients record the turn off this event.
            self.assertEqual([m.get("type") for m in before], [])
            said = reply["agent_response_event"]["agent_response"]
            self.assertEqual(said, dialog.BUILTIN_AGENTS[AGENT].first_message)
            audio = ws.receive_json()
            self.assertEqual(audio["type"], "audio")
            self.assertTrue(base64.b64decode(audio["audio_event"]["audio_base_64"]))

    def test_a_spoken_turn_becomes_a_transcript_and_a_reply(self) -> None:
        self._engine()
        with self.client.websocket_connect(self._url()) as ws:
            self._init(ws, first_message="")  # skip the opening; test one turn
            ws.receive_json()                 # metadata
            self._speak(ws)
            transcript, _ = self._until(ws, "user_transcript")
            self.assertEqual(transcript["user_transcription_event"]["user_transcript"],
                             self.heard_texts[0])
            reply, _ = self._until(ws, "agent_response")
            self.assertEqual(reply["agent_response_event"]["agent_response"],
                             dialog.BUILTIN_AGENTS[AGENT].script[0])
            self.assertEqual(ws.receive_json()["type"], "audio")

    def test_a_sound_with_no_words_in_it_is_not_a_turn(self) -> None:
        """The transcriber is the backstop for a level-based gate.

        A door or a cough clears the level threshold; it must not become an
        empty turn in the transcript.
        """
        self._engine()
        self.heard_texts = ["", "This one has words in it."]
        with self.client.websocket_connect(self._url()) as ws:
            self._init(ws, first_message="")
            ws.receive_json()
            self._speak(ws)   # heard as "" -> dropped entirely
            self._speak(ws)   # heard as words -> a turn
            transcript, before = self._until(ws, "user_transcript")
            self.assertEqual(transcript["user_transcription_event"]["user_transcript"],
                             self.heard_texts[1])
            # Nothing at all was sent for the first one.
            self.assertEqual(before, [])

    def test_talking_over_the_agent_interrupts_it(self) -> None:
        # A slow pool keeps the opening turn rendering while we cut in.
        self._engine(delay=1.5)
        with self.client.websocket_connect(self._url()) as ws:
            self._init(ws)
            ws.receive_json()                    # metadata
            self._until(ws, "agent_response")    # the agent has the floor
            self._speak(ws)
            interruption, _ = self._until(ws, "interruption")
            self.assertEqual(interruption["interruption_event"]["reason"],
                             "user_speech")

    def test_a_client_override_re_prompts_the_agent(self) -> None:
        self._engine()
        with self.client.websocket_connect(self._url()) as ws:
            self._init(ws, first_message="Right, let's begin.")
            ws.receive_json()
            reply, _ = self._until(ws, "agent_response")
            self.assertEqual(reply["agent_response_event"]["agent_response"],
                             "Right, let's begin.")

    def test_the_socket_answers_pings_with_nothing_and_survives_junk(self) -> None:
        """One malformed frame from a client must not end a conversation."""
        self._engine()
        with self.client.websocket_connect(self._url()) as ws:
            self._init(ws, first_message="")
            ws.receive_json()
            ws.send_text("this is not json")
            ws.send_json({"type": "pong", "event_id": 1})
            ws.send_json({"type": "something_from_a_later_protocol"})
            self._speak(ws)
            transcript, _ = self._until(ws, "user_transcript")
            self.assertTrue(transcript["user_transcription_event"]["user_transcript"])

    def test_an_unsigned_socket_is_refused(self) -> None:
        self._engine()
        for url in (f"/v1/convai/conversation?agent_id={AGENT}",
                    f"/v1/convai/conversation?agent_id={AGENT}&token=forged"):
            with self.assertRaises(Exception):
                with self.client.websocket_connect(url) as ws:
                    ws.receive_json()

    def test_a_ticket_does_not_open_a_different_agent(self) -> None:
        self._engine()
        ticket = convai.mint_ticket("some-other-agent")
        with self.assertRaises(Exception):
            with self.client.websocket_connect(
                    f"/v1/convai/conversation?agent_id={AGENT}&token={ticket}") as ws:
                ws.receive_json()


class AuthTests(unittest.TestCase):
    """With a root key configured, the two halves are guarded differently."""

    def setUp(self) -> None:
        from service import auth

        self.auth = auth
        self._orig = auth.SETTINGS
        auth.SETTINGS = dataclasses.replace(auth.SETTINGS, api_key="gvt_root_test")
        self.client = TestClient(appmod.app)

    def tearDown(self) -> None:
        self.auth.SETTINGS = self._orig

    def test_the_mint_is_scope_checked_like_every_other_route(self) -> None:
        url = "/v1/convai/conversation/get-signed-url"
        params = {"agent_id": AGENT}
        self.assertEqual(self.client.get(url, params=params).status_code, 401)
        self.assertEqual(self.client.get(url, params=params,
                                         headers={"xi-api-key": "wrong"}).status_code, 401)
        ok = self.client.get(url, params=params,
                             headers={"xi-api-key": "gvt_root_test"})
        self.assertEqual(ok.status_code, 200)
        self.assertTrue(convai.verify_ticket(
            AGENT, ok.json()["signed_url"].split("token=")[1]))

    def test_the_socket_wants_a_ticket_and_a_key_is_not_one(self) -> None:
        """The header a browser cannot send is not an accepted substitute."""
        with self.assertRaises(Exception):
            with self.client.websocket_connect(
                    f"/v1/convai/conversation?agent_id={AGENT}",
                    headers={"xi-api-key": "gvt_root_test"}) as ws:
                ws.receive_json()


class DisabledServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self._orig = convai.SETTINGS
        convai.SETTINGS = dataclasses.replace(convai.SETTINGS, convai_enabled=False)
        self.client = TestClient(appmod.app)

    def tearDown(self) -> None:
        convai.SETTINGS = self._orig

    def test_the_mint_says_why_rather_than_404ing(self) -> None:
        res = self.client.get("/v1/convai/conversation/get-signed-url",
                              params={"agent_id": AGENT})
        self.assertEqual(res.status_code, 503)
        self.assertIn("CONVAI_ENABLED", res.json()["detail"])


if __name__ == "__main__":
    unittest.main()
