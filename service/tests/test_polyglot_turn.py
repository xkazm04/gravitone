"""The polyglot turn: the brain directs, and the mouth follows — over the socket.

``test_dialog`` pins the grammar and ``test_piper`` pins the resolution rule.
What is only true END TO END is the wiring between them, which is what this
module drives through the real conversation socket: an agent declaring a second
language reports a MATRIX rather than a boolean, a ``[lang:cs]`` directive
re-resolves the mouth at the sentence boundary and sends the Czech sentence to
Piper while the English one goes to the Pocket TTS pool, a switch we have no
voice for is refused OUT LOUD in the language we can still speak, and
``[end_call]`` hangs up normally once the goodbye has actually been sent.

The direction is supplied by a client ``script`` override, so every case here is
deterministic with no language model anywhere. Piper is stubbed the way
``test_piper`` stubs it — a voice is two files on disk, and synthesis is recorded
rather than performed.
"""
from __future__ import annotations

import base64
import dataclasses
import json
import tempfile
import unittest
from pathlib import Path

from service.tests import fake_engine  # installs shims — must precede app import

import service.app as appmod  # noqa: E402
from service import convai, dialog, piper, stt  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from service.tests.test_vad import silence, tone  # noqa: E402

CS_VOICE = "cs_CZ-jirka-medium"


def heard(text: str, language: str = "en", probability: float = 1.0) -> stt.Transcript:
    return stt.Transcript(text=text, language_code=language,
                          language_probability=probability,
                          duration_s=1.0, transcribe_s=0.01)


class _PolyglotCase(unittest.TestCase):
    """A bilingual agent on disk, a fake Piper, and a fake worker pool."""

    # What the agent file declares. A subclass changes this before setUp runs.
    declares: list[str] = ["cs"]

    def setUp(self) -> None:
        self._agents = tempfile.TemporaryDirectory()
        self._voices = tempfile.TemporaryDirectory()
        self._orig = {"dialog": dialog.SETTINGS, "piper": piper.SETTINGS,
                      "convai": convai.SETTINGS, "engine": appmod.ENGINE,
                      "transcribe": stt.transcribe_pcm, "backend": convai._BACKEND,
                      "synth": piper.synthesize_pcm}
        Path(self._agents.name, "poly.json").write_text(json.dumps({
            "agent_id": "poly", "name": "Polyglot", "prompt": "Be brief.",
            "first_message": "", "language": "en", "languages": self.declares,
        }), "utf-8")
        dialog.SETTINGS = dataclasses.replace(
            dialog.SETTINGS, convai_agents_dir=self._agents.name)
        piper.SETTINGS = dataclasses.replace(
            piper.SETTINGS, piper_voices_dir=self._voices.name)
        piper._CACHE.clear()

        # Piper synthesis is RECORDED, not performed: what matters here is which
        # mouth was asked to say which sentence.
        self.piper_said: list[tuple[str, str]] = []

        def _fake_piper(voice_id: str, text: str):
            self.piper_said.append((voice_id, text))
            # 22.05 kHz, like the real *-medium voices, so the session's resample
            # path is the one a Czech sentence actually takes.
            return b"\x01\x02" * (len(text) * 100), 22050

        piper.synthesize_pcm = _fake_piper

        self.transcripts: list[stt.Transcript] = [heard("Tell me more.")]
        self._calls = 0

        def _fake_transcribe(pcm, **kwargs):
            self.transcribe_kwargs.append(kwargs)
            i = min(self._calls, len(self.transcripts) - 1)
            self._calls += 1
            return self.transcripts[i]

        self.transcribe_kwargs: list[dict] = []
        stt.transcribe_pcm = _fake_transcribe
        convai._BACKEND = dialog.ScriptedBackend()
        self.engine = fake_engine.FakeEngine(workers=2)
        appmod.ENGINE = self.engine
        self.client = TestClient(appmod.app)

    def tearDown(self) -> None:
        dialog.SETTINGS = self._orig["dialog"]
        piper.SETTINGS = self._orig["piper"]
        convai.SETTINGS = self._orig["convai"]
        appmod.ENGINE = self._orig["engine"]
        stt.transcribe_pcm = self._orig["transcribe"]
        convai._BACKEND = self._orig["backend"]
        piper.synthesize_pcm = self._orig["synth"]
        convai._Sessions.active = 0
        piper._CACHE.clear()
        self.engine.close()
        self._agents.cleanup()
        self._voices.cleanup()

    # -- helpers ------------------------------------------------------------
    def add_czech_voice(self) -> None:
        d = Path(self._voices.name)
        (d / f"{CS_VOICE}.onnx").write_bytes(b"onnx")
        (d / f"{CS_VOICE}.onnx.json").write_text("{}", "utf-8")

    def url(self, agent_id: str = "poly") -> str:
        res = self.client.get("/v1/convai/conversation/get-signed-url",
                              params={"agent_id": agent_id})
        self.assertEqual(res.status_code, 200, res.text)
        return res.json()["signed_url"].split("testserver", 1)[1]

    @staticmethod
    def init(ws, **override) -> None:
        ws.send_json({"type": "conversation_initiation_client_data",
                      "conversation_config_override": {"agent": override}})

    @staticmethod
    def say(ws, ms: int = 700) -> None:
        audio = silence(300) + tone(ms) + silence(1000)
        step = 16000 * 2 // 10
        for i in range(0, len(audio), step):
            ws.send_json({"user_audio_chunk":
                          base64.b64encode(audio[i:i + step]).decode("ascii")})

    @staticmethod
    def until(ws, kind: str, limit: int = 300) -> dict:
        seen: list[str] = []
        for _ in range(limit):
            msg = ws.receive_json()
            if msg.get("type") == kind:
                return msg
            seen.append(msg.get("type"))
        raise AssertionError(f"never saw {kind!r}; got {seen}")

    def one_turn(self, script: list[str], expect: int = 1) -> str:
        """Drive one spoken turn against ``script`` and return the reply text.

        ``agent_response`` is sent BEFORE the audio (that is the protocol's
        ordering contract), so a test that stopped reading there would close the
        socket while the renderer was still working and see no synthesis at all.
        ``expect`` is how many sentences must have been rendered before we look.
        """
        with self.client.websocket_connect(self.url()) as ws:
            self.init(ws, first_message="", script=script)
            ws.receive_json()          # metadata
            self.say(ws)
            reply = self.until(ws, "agent_response")
            self.wait_for_synthesis(ws, expect)
            return reply["agent_response_event"]["agent_response"]

    def wait_for_synthesis(self, ws, expect: int, limit: int = 400) -> None:
        """Consume frames until ``expect`` sentences have been through a mouth.

        Audio is only ever sent AFTER its sentence was synthesized, so reading
        frames is what makes the synthesis observable.
        """
        for _ in range(limit):
            if len(self.engine.jobs) + len(self.piper_said) >= expect:
                return
            ws.receive_json()
        raise AssertionError(
            f"only {len(self.engine.jobs)} pocket + {len(self.piper_said)} piper "
            f"sentence(s) were rendered; expected {expect}")


class AgentMatrixTests(_PolyglotCase):
    """What /v1/convai/agents promises about a bilingual agent."""

    def test_a_declared_language_with_no_voice_is_reported_unspeakable(self) -> None:
        described = self._described()
        self.assertTrue(described["speakable"])          # English still works
        self.assertTrue(described["languages"]["en"]["speakable"])
        self.assertFalse(described["languages"]["cs"]["speakable"])
        self.assertIn("download_voices", described["languages"]["cs"]["problem"])

    def test_installing_the_voice_fills_in_the_matrix(self) -> None:
        self.add_czech_voice()
        matrix = self._described()["languages"]
        self.assertEqual(matrix["cs"], {"speakable": True, "voice_id": CS_VOICE,
                                        "tts": "piper"})
        self.assertEqual(matrix["en"]["tts"], "pocket-tts")

    def test_a_monolingual_agent_reports_a_one_entry_matrix(self) -> None:
        """The boolean does not go away; the matrix explains it."""
        described = next(a for a in self._agents_json()
                         if a["agent_id"] == "local-interviewer")
        self.assertEqual(list(described["languages"]), ["en"])
        self.assertTrue(described["speakable"])

    def _agents_json(self) -> list[dict]:
        res = self.client.get("/v1/convai/agents")
        self.assertEqual(res.status_code, 200, res.text)
        return res.json()["agents"]

    def _described(self) -> dict:
        return next(a for a in self._agents_json() if a["agent_id"] == "poly")


class MidCallSwitchTests(_PolyglotCase):
    def test_the_mouth_follows_the_brain_at_the_sentence_boundary(self) -> None:
        """The feature: two engines inside ONE turn, split where a sentence ended."""
        self.add_czech_voice()
        reply = self.one_turn(["Of course. [lang:cs] Ahoj, jak se mate?"], expect=2)
        self.assertEqual(reply, "Of course. Ahoj, jak se mate?")
        # The English sentence went to the Pocket TTS pool...
        self.assertEqual([j.text for j in self.engine.jobs], ["Of course."])
        # ...and the Czech one to the installed Piper voice.
        self.assertEqual(self.piper_said, [(CS_VOICE, "Ahoj, jak se mate?")])

    def test_no_directive_text_ever_reaches_a_synthesizer(self) -> None:
        self.add_czech_voice()
        reply = self.one_turn(
            ["[emotion:warm] Right. [lang:cs] Dobre. [end_call]"], expect=2)
        spoken = [j.text for j in self.engine.jobs] + [t for _, t in self.piper_said]
        for said in spoken + [reply]:
            self.assertNotIn("[", said)
            self.assertNotIn("lang", said)
            self.assertNotIn("emotion", said)

    def test_a_switch_back_reuses_the_first_mouth(self) -> None:
        self.add_czech_voice()
        reply = self.one_turn(["[lang:cs] Ano. [lang:en] And in English?"], expect=2)
        self.assertEqual(reply, "Ano. And in English?")
        self.assertEqual(self.piper_said, [(CS_VOICE, "Ano.")])
        self.assertEqual([j.text for j in self.engine.jobs], ["And in English?"])

    def test_the_declared_language_is_pre_warmed_at_connect(self) -> None:
        """So the switching sentence does not pay a cold ONNX load."""
        self.add_czech_voice()
        warmed: list[list[str]] = []
        original = piper.prewarm
        piper.prewarm = lambda languages=(), voice_ids=(): (
            warmed.append(list(languages)) or original(languages, voice_ids))
        try:
            with self.client.websocket_connect(self.url()) as ws:
                self.init(ws, first_message="")
                ws.receive_json()
                self.say(ws)
                self.until(ws, "agent_response")
        finally:
            piper.prewarm = original
        self.assertEqual(warmed, [["cs"]])

    def test_a_polyglot_agent_does_not_pin_the_transcriber(self) -> None:
        """Pinning the language is what would stop the ear reporting a switch."""
        self.add_czech_voice()
        self.one_turn(["Fine."])
        self.assertIsNone(self.transcribe_kwargs[-1]["language"])


class UnspeakableSwitchTests(_PolyglotCase):
    declares: list[str] = []      # declares NO second language

    def test_an_undeclared_switch_is_refused_out_loud_in_english(self) -> None:
        reply = self.one_turn(["[lang:de] Guten Tag, wie geht es Ihnen?"])
        self.assertIn("German", reply)
        self.assertIn("English", reply)
        self.assertNotIn("Guten Tag", reply)
        # The apology was spoken by the mouth we still have, not a German one.
        self.assertEqual([j.text for j in self.engine.jobs], [reply])
        self.assertEqual(self.piper_said, [])

    def test_the_apology_happens_once_not_per_sentence(self) -> None:
        reply = self.one_turn(["[lang:de] Eins. Zwei. Drei."])
        self.assertEqual(len(self.engine.jobs), 1)
        self.assertIn("German", reply)
        for german in ("Eins.", "Zwei.", "Drei."):
            self.assertNotIn(german, reply)


class DeclaredButUninstalledTests(_PolyglotCase):
    """Declared "cs", never downloaded a Czech voice: refuse, do not mispronounce."""

    def test_a_missing_voice_refuses_rather_than_reading_czech_in_english(self) -> None:
        reply = self.one_turn(["Sure. [lang:cs] Ahoj, jak se mate?"], expect=2)
        self.assertEqual([j.text for j in self.engine.jobs],
                         ["Sure.", reply.split("Sure. ", 1)[1]])
        self.assertIn("Czech", reply)
        self.assertNotIn("Ahoj", reply)
        self.assertEqual(self.piper_said, [])


class EndCallTests(_PolyglotCase):
    def test_end_call_hangs_up_after_the_goodbye_has_been_sent(self) -> None:
        with self.client.websocket_connect(self.url()) as ws:
            self.init(ws, first_message="",
                      script=["That's everything. Thanks for your time. [end_call]"])
            ws.receive_json()      # metadata
            self.say(ws)
            reply = self.until(ws, "agent_response")
            said = reply["agent_response_event"]["agent_response"]
            self.assertEqual(said, "That's everything. Thanks for your time.")
            self.assertNotIn("end_call", said)
            # The audio for the goodbye goes out BEFORE the close: a hang-up that
            # cut off its own last words would be worse than no hang-up at all.
            self.assertEqual(self.until(ws, "audio")["type"], "audio")
            closed = self._drain_to_close(ws)
        self.assertEqual(closed, 1000)   # a normal ending, not a failure

    def test_a_turn_without_end_call_keeps_the_socket_open(self) -> None:
        with self.client.websocket_connect(self.url()) as ws:
            self.init(ws, first_message="", script=["Still talking."])
            ws.receive_json()
            self.say(ws)
            self.until(ws, "agent_response")
            self.until(ws, "audio")
            ws.send_json({"type": "user_activity"})   # the socket still accepts

    @staticmethod
    def _drain_to_close(ws, limit: int = 300) -> int | None:
        """Read until the server closes, returning the close code."""
        for _ in range(limit):
            message = ws.receive()
            if message.get("type") == "websocket.close":
                return message.get("code")
        raise AssertionError("the socket was never closed")


if __name__ == "__main__":
    unittest.main()
