"""Zero-gap turn-taking — the four speculations, and the promises they make.

A conversation that starts answering before the caller has finished talking is
only safe if every guess it makes is invisible until the turn is confirmed. That
is the whole subject of this module. Each of the four features gets its normal
path exercised, but the cases that MATTER here are the invariants, because they
are what makes the features shippable rather than clever:

  * a partial transcript never reaches ``history`` or the recorded transcript,
  * a cancelled speculation leaves no audio on the wire,
  * an opener plays only after a turn end was confirmed by real words,
  * with the flags off, the conversation does exactly what it did before.

Driven over the real socket with the fake worker pool and a stubbed transcriber
(the pattern test_convai_protocol.py established), so these are assertions about
the session's behaviour and not about a model. The utterances are streamed at
PACE — with real sleeps between chunks — because speculation is a race against
the caller by definition, and audio delivered instantly is not that race.
"""
from __future__ import annotations

import base64
import dataclasses
import time
import unittest

from service.tests import fake_engine  # installs shims — must precede app import

import service.app as appmod  # noqa: E402
from service import convai, dialog, stt  # noqa: E402
from service.tests.test_vad import silence, tone  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

AGENT = "local-interviewer"
FINAL_TEXT = "I have been building backend services for six years."
# What the partial decodes claim to hear. Every partial says the same thing, so
# two consecutive ones agree from the second one onward — the cheap stability
# signal ``convai.agreed_prefix`` looks for.
PARTIAL_TEXT = "I have been building backend services"


def heard(text: str, transcribe_s: float = 0.01) -> stt.Transcript:
    return stt.Transcript(text=text, language_code="en", language_probability=1.0,
                          duration_s=1.0, transcribe_s=transcribe_s)


class _CountingBrain(dialog.DialogBackend):
    """Says one fixed reply and counts how many times it was asked for it."""

    name = "counting"

    def __init__(self, reply_text: str = "Thanks, that's helpful. What next?"):
        self.reply_text = reply_text
        self.calls: list[list[dict]] = []

    async def reply(self, agent, history):
        self.calls.append(list(history))
        for sentence in dialog.split_sentences(self.reply_text):
            yield sentence


# ---------------------------------------------------------------------------
# The pure helpers
# ---------------------------------------------------------------------------
class AgreedPrefixTests(unittest.TestCase):
    def test_one_partial_agrees_with_nothing(self) -> None:
        self.assertEqual(convai.agreed_prefix([]), "")
        self.assertEqual(convai.agreed_prefix(["I have been building"]), "")

    def test_two_identical_partials_agree_completely(self) -> None:
        self.assertEqual(convai.agreed_prefix(["I have been", "I have been"]),
                         "I have been")

    def test_a_half_word_is_dropped_rather_than_handed_to_a_model(self) -> None:
        # "exper" / "experience" agree on five letters of one word. A prefix that
        # ends mid-word reads as a typo to a language model, where an unfinished
        # sentence reads as an unfinished sentence.
        self.assertEqual(convai.agreed_prefix(["what is your exper",
                                               "what is your experience"]),
                         "what is your")

    def test_disagreement_from_the_first_word_agrees_on_nothing(self) -> None:
        self.assertEqual(convai.agreed_prefix(["yes absolutely", "no not really"]), "")

    def test_only_the_newest_two_partials_count(self) -> None:
        self.assertEqual(convai.agreed_prefix(["nothing alike", "a b", "a b"]), "a b")


class ContinuationTests(unittest.TestCase):
    def test_punctuation_and_case_do_not_break_a_match(self) -> None:
        self.assertTrue(convai.continues("I have been building, yes, for years.",
                                         "i have been building"))

    def test_a_different_sentence_does_not_vindicate_a_guess(self) -> None:
        self.assertFalse(convai.continues("Actually let me start again.",
                                          "I have been building"))

    def test_an_empty_prefix_vindicates_nothing(self) -> None:
        self.assertFalse(convai.continues("anything at all", "   "))

    def test_a_prefix_must_be_a_PREFIX_not_a_substring(self) -> None:
        self.assertFalse(convai.continues("well, I have been building",
                                          "I have been building"))


class DistributionTests(unittest.TestCase):
    def test_no_turns_reports_no_numbers_rather_than_zeroes(self) -> None:
        self.assertEqual(convai._distribution([]), {"n": 0})

    def test_the_median_of_an_even_count_is_the_midpoint(self) -> None:
        self.assertEqual(convai._distribution([0.4, 0.2, 0.8, 0.6]),
                         {"n": 4, "min": 0.2, "median": 0.5, "max": 0.8})


class OpenerConfigTests(unittest.TestCase):
    def setUp(self) -> None:
        self._orig = convai.SETTINGS

    def tearDown(self) -> None:
        convai.SETTINGS = self._orig

    def _set(self, **kwargs) -> None:
        convai.SETTINGS = dataclasses.replace(convai.SETTINGS, **kwargs)

    def test_openers_are_off_until_a_replica_asks_for_them(self) -> None:
        self.assertFalse(convai.openers_enabled(AGENT))

    def test_an_empty_agent_list_means_every_agent(self) -> None:
        self._set(convai_openers=True, convai_opener_agents="")
        self.assertTrue(convai.openers_enabled(AGENT))
        self.assertTrue(convai.openers_enabled("some-other-agent"))

    def test_naming_agents_excludes_the_ones_that_must_not_backchannel(self) -> None:
        """The legal read-back case: one replica, two agents, one opener."""
        self._set(convai_openers=True, convai_opener_agents=f"{AGENT}, another")
        self.assertTrue(convai.openers_enabled(AGENT))
        self.assertTrue(convai.openers_enabled("another"))
        self.assertFalse(convai.openers_enabled("legal-read-back"))

    def test_the_replica_switch_beats_the_agent_list(self) -> None:
        self._set(convai_openers=False, convai_opener_agents=AGENT)
        self.assertFalse(convai.openers_enabled(AGENT))

    def test_phrases_are_parsed_and_blanks_dropped(self) -> None:
        self._set(convai_opener_phrases=" Mm-hm. || Got it, ")
        self.assertEqual(convai.opener_phrases(), ["Mm-hm.", "Got it,"])


class EchoReferenceTests(unittest.TestCase):
    """The session half of self-echo suppression; the gate half is in test_vad."""

    def setUp(self) -> None:
        self._orig = convai.SETTINGS
        self.agent = dialog.BUILTIN_AGENTS[AGENT]

    def tearDown(self) -> None:
        convai.SETTINGS = self._orig

    def _session(self, **kwargs) -> convai._Session:
        convai.SETTINGS = dataclasses.replace(convai.SETTINGS, **kwargs)
        # __init__ never touches the socket, so a placeholder is honest here.
        return convai._Session(object(), self.agent)

    def test_nothing_is_declared_while_the_flag_is_off(self) -> None:
        session = self._session(convai_echo_suppression=False)
        session._note_echo(tone(500))
        self.assertFalse(session.gate.echo_active)

    def test_sent_audio_opens_an_echo_window(self) -> None:
        session = self._session(convai_echo_suppression=True)
        session._note_echo(tone(500))
        self.assertTrue(session.gate.echo_active)
        # And the window is spent by the microphone frames that follow it.
        session.gate.feed(silence(2000))
        self.assertFalse(session.gate.echo_active)

    def test_an_empty_chunk_declares_nothing(self) -> None:
        session = self._session(convai_echo_suppression=True)
        session._note_echo(b"")
        self.assertFalse(session.gate.echo_active)


# ---------------------------------------------------------------------------
# The live socket
# ---------------------------------------------------------------------------
class _SocketCase(unittest.TestCase):
    """One conversation, with the transcriber and the brain under test control."""

    # Partial decodes are stubbed to take this long, which is also what makes
    # the timing realistic: a partial costs real time on the threadpool, and two
    # of them cannot both land inside one chunk.
    PARTIAL_S = 0.05
    FINAL_S = 0.25

    def setUp(self) -> None:
        self._orig_engine = appmod.ENGINE
        self._orig_settings = convai.SETTINGS
        self._orig_final = stt.transcribe_pcm
        self._orig_partial = stt.transcribe_partial
        self._orig_backend = convai._BACKEND
        self._orig_session = convai._Session

        self.brain = _CountingBrain()
        convai._BACKEND = self.brain
        self.final_text = FINAL_TEXT
        self.partial_text = PARTIAL_TEXT
        self.partial_calls = 0

        def _final(pcm, **kwargs):
            # Slow on purpose: the final decode is the window a speculation has
            # to finish in, and a test that removes that window tests nothing.
            time.sleep(self.FINAL_S)
            return heard(self.final_text, transcribe_s=self.FINAL_S)

        def _partial(pcm, **kwargs):
            self.partial_calls += 1
            time.sleep(self.PARTIAL_S)
            return heard(self.partial_text, transcribe_s=self.PARTIAL_S)

        stt.transcribe_pcm = _final
        stt.transcribe_partial = _partial

        # Every session this test opens, so its private state (history, the
        # recorder's turns, the speculation counters) can be asserted on.
        self.sessions: list[convai._Session] = []
        watcher = self

        class _Watched(self._orig_session):  # type: ignore[misc, valid-type]
            def __init__(inner, websocket, agent):  # noqa: N805
                super().__init__(websocket, agent)
                watcher.sessions.append(inner)

        convai._Session = _Watched
        convai.opener_cache().clear()
        self.engine = fake_engine.FakeEngine(workers=4, delay=0.02)
        appmod.ENGINE = self.engine
        self.client = TestClient(appmod.app)

    def tearDown(self) -> None:
        self.engine.close()
        appmod.ENGINE = self._orig_engine
        convai.SETTINGS = self._orig_settings
        stt.transcribe_pcm = self._orig_final
        stt.transcribe_partial = self._orig_partial
        convai._BACKEND = self._orig_backend
        convai._Session = self._orig_session
        convai._Sessions.active = 0
        convai.opener_cache().clear()

    # -- helpers ------------------------------------------------------------
    def _flags(self, **kwargs) -> None:
        convai.SETTINGS = dataclasses.replace(convai.SETTINGS, **kwargs)

    def _url(self, agent_id: str = AGENT) -> str:
        res = self.client.get("/v1/convai/conversation/get-signed-url",
                              params={"agent_id": agent_id})
        self.assertEqual(res.status_code, 200)
        return res.json()["signed_url"].split("testserver", 1)[1]

    @staticmethod
    def _init(ws, **agent_override) -> None:
        ws.send_json({"type": "conversation_initiation_client_data",
                      "conversation_config_override": {"agent": agent_override}})

    @staticmethod
    def _speak(ws, ms: int = 1600, *, paced: bool = True, tail: int = 1100) -> None:
        """Stream one utterance at (roughly) wire pace.

        The sleeps are the point: partial decodes are scheduled from the audio
        path, so a client that dumps a whole utterance in one go never gives the
        session a moment in which the utterance is still in progress.
        """
        audio = silence(300) + tone(ms) + silence(tail)
        step = 16000 * 2 // 10  # 100 ms of audio per frame
        for i in range(0, len(audio), step):
            ws.send_json({"user_audio_chunk":
                          base64.b64encode(audio[i:i + step]).decode("ascii")})
            if paced:
                time.sleep(0.05)

    @staticmethod
    def _until(ws, kind: str, limit: int = 400) -> tuple[dict, list[dict]]:
        seen: list[dict] = []
        for _ in range(limit):
            msg = ws.receive_json()
            if msg.get("type") == kind:
                return msg, seen
            seen.append(msg)
        raise AssertionError(f"never saw a {kind!r}; got {[m.get('type') for m in seen]}")

    @staticmethod
    def _finals(messages: list[dict]) -> list[str]:
        """The user transcripts a client would RECORD (interims excluded)."""
        return [m["user_transcription_event"]["user_transcript"] for m in messages
                if m.get("type") == "user_transcript"
                and m["user_transcription_event"].get("is_final") is not False]

    @staticmethod
    def _interims(messages: list[dict]) -> list[str]:
        return [m["user_transcription_event"]["user_transcript"] for m in messages
                if m.get("type") == "user_transcript"
                and m["user_transcription_event"].get("is_final") is False]


class FlagsOffTests(_SocketCase):
    """With everything off, this is the conversation that shipped before."""

    def test_a_turn_is_byte_for_byte_the_old_exchange(self) -> None:
        with self.client.websocket_connect(self._url()) as ws:
            self._init(ws, first_message="")
            ws.receive_json()                     # metadata
            self._speak(ws, paced=False)
            transcript, before = self._until(ws, "user_transcript")
            self.assertEqual(before, [])          # nothing precedes it
            event = transcript["user_transcription_event"]
            # The final event is UNCHANGED: exactly one key, no is_final flag.
            self.assertEqual(event, {"user_transcript": FINAL_TEXT})
            reply, between = self._until(ws, "agent_response")
            self.assertEqual(between, [])         # no opener, no interim
            self.assertEqual(reply["agent_response_event"]["agent_response"],
                             self.brain.reply_text)
            self.assertEqual(ws.receive_json()["type"], "audio")
        self.assertEqual(self.partial_calls, 0)   # the ear was never speculated with
        self.assertEqual(len(self.brain.calls), 1)  # the brain was asked once

    def test_the_agents_surface_says_every_speculation_is_off(self) -> None:
        flags = self.client.get("/v1/convai/agents").json()["speculation"]
        self.assertEqual([flags["partial_decode"], flags["speculate"],
                          flags["openers"], flags["echo_suppression"]],
                         [False, False, False, False])

    def test_the_session_kept_no_speculative_state(self) -> None:
        with self.client.websocket_connect(self._url()) as ws:
            self._init(ws, first_message="")
            ws.receive_json()
            self._speak(ws, paced=False)
            self._until(ws, "agent_response")
        session = self.sessions[-1]
        self.assertEqual(session._partials, [])
        self.assertIsNone(session._spec)
        self.assertEqual({k: v for k, v in session._stats.items() if v}, {})


class PartialDecodeTests(_SocketCase):
    def test_a_partial_is_emitted_as_an_interim_transcript(self) -> None:
        self._flags(convai_partial_decode=True, convai_partial_interval_ms=0,
                    convai_partial_min_ms=400)
        with self.client.websocket_connect(self._url()) as ws:
            self._init(ws, first_message="")
            ws.receive_json()
            self._speak(ws)
            reply, before = self._until(ws, "agent_response")
            interims = self._interims(before)
            self.assertTrue(interims, "no interim transcript was emitted")
            self.assertEqual(set(interims), {PARTIAL_TEXT})
            # The FINAL transcript still arrives, still unflagged, and it is the
            # final decode's text — not the guess.
            self.assertEqual(self._finals(before), [FINAL_TEXT])

    def test_a_partial_never_enters_history_or_the_recorded_transcript(self) -> None:
        """The invariant that makes partial decoding safe at all.

        Partial text is noisier than final text by construction
        (``condition_on_previous_text=False``, a clip that stops mid-word), so a
        partial in the prompt corrupts the next turn and a partial in the
        transcript corrupts the evidence.
        """
        self._flags(convai_partial_decode=True, convai_partial_interval_ms=0,
                    convai_partial_min_ms=400)
        with self.client.websocket_connect(self._url()) as ws:
            self._init(ws, first_message="")
            ws.receive_json()
            self._speak(ws)
            self._until(ws, "agent_response")
        session = self.sessions[-1]
        self.assertGreater(session._stats["interims_sent"], 0)  # it really ran
        user_said = [m["content"] for m in session.history if m["role"] == "user"]
        self.assertEqual(user_said, [FINAL_TEXT])
        recorded = [t.text for t in session.recorder.turns if t.role == "candidate"]
        self.assertEqual(recorded, [FINAL_TEXT])
        self.assertNotIn(PARTIAL_TEXT, [m["content"] for m in session.history])
        # And the brain was prompted with the final text, never the guess.
        for history in self.brain.calls:
            self.assertNotIn(PARTIAL_TEXT, [m["content"] for m in history])

    def test_partials_are_forgotten_at_the_turn_boundary(self) -> None:
        self._flags(convai_partial_decode=True, convai_partial_interval_ms=0,
                    convai_partial_min_ms=400)
        with self.client.websocket_connect(self._url()) as ws:
            self._init(ws, first_message="")
            ws.receive_json()
            self._speak(ws)
            self._until(ws, "agent_response")
            # Silence after the turn: the gate is idle, so the guesses about the
            # utterance that just ended are dropped rather than carried forward.
            ws.send_json({"user_audio_chunk":
                          base64.b64encode(silence(200)).decode("ascii")})
            time.sleep(0.1)
        self.assertEqual(self.sessions[-1]._partials, [])

    def test_the_latency_report_reaches_the_recording_surface(self) -> None:
        self._flags(convai_partial_decode=True, convai_partial_interval_ms=0,
                    convai_partial_min_ms=400)
        with self.client.websocket_connect(self._url()) as ws:
            self._init(ws, first_message="")
            ws.receive_json()
            self._speak(ws)
            self._until(ws, "agent_response")
        report = self.sessions[-1].recorder.meta["latency"]
        self.assertTrue(report["flags"]["partial_decode"])
        self.assertGreaterEqual(report["partials_run"], 1)
        self.assertIn("turn_latency_s", report)
        self.assertIn("n", report["turn_latency_s"])
        self.assertIn("stt_partials_process", report)


class SpeculationTests(_SocketCase):
    def _speculating(self, **extra) -> None:
        self._flags(convai_partial_decode=True, convai_speculate=True,
                    convai_partial_interval_ms=0, convai_partial_min_ms=400,
                    convai_speculate_min_chars=8, **extra)

    def test_a_vindicated_guess_answers_without_asking_the_brain_twice(self) -> None:
        """The actual win: the reply was written during the caller's hangover."""
        self._speculating()
        with self.client.websocket_connect(self._url()) as ws:
            self._init(ws, first_message="")
            ws.receive_json()
            self._speak(ws)
            reply, _ = self._until(ws, "agent_response")
            self.assertEqual(reply["agent_response_event"]["agent_response"],
                             self.brain.reply_text)
        session = self.sessions[-1]
        self.assertEqual(session._stats["speculations_used"], 1)
        # One brain call for the whole turn — the speculative one. The real turn
        # spent zero thinking time.
        self.assertEqual(len(self.brain.calls), 1)
        # The speculation was prompted with the PREFIX, and the transcript still
        # records what was actually said.
        self.assertEqual(self.brain.calls[0][-1]["content"], PARTIAL_TEXT)
        self.assertEqual([t.text for t in session.recorder.turns
                          if t.role == "candidate"], [FINAL_TEXT])

    def test_a_speculation_puts_no_audio_on_the_wire_before_the_turn(self) -> None:
        """Whatever was guessed, nothing was audible until the turn was real."""
        self._speculating()
        with self.client.websocket_connect(self._url()) as ws:
            self._init(ws, first_message="")
            ws.receive_json()
            self._speak(ws)
            reply, before = self._until(ws, "agent_response")
            # Openers are off here, so ANY audio before the text event would be
            # a speculation that had been spoken.
            self.assertEqual([m.get("type") for m in before
                              if m.get("type") == "audio"], [])
            self.assertEqual(ws.receive_json()["type"], "audio")
        self.assertGreaterEqual(self.sessions[-1]._stats["speculations"], 1)

    def test_a_wrong_guess_is_discarded_and_the_brain_answers_properly(self) -> None:
        """The caller said something else. The guess dies unheard."""
        self._speculating()
        self.final_text = "Actually, let me start that answer again."
        with self.client.websocket_connect(self._url()) as ws:
            self._init(ws, first_message="")
            ws.receive_json()
            self._speak(ws)
            reply, before = self._until(ws, "agent_response")
            self.assertEqual([m.get("type") for m in before
                              if m.get("type") == "audio"], [])
            self.assertEqual(reply["agent_response_event"]["agent_response"],
                             self.brain.reply_text)
        session = self.sessions[-1]
        self.assertEqual(session._stats["speculations_used"], 0)
        self.assertGreaterEqual(session._stats["speculations_discarded"], 1)
        # Asked twice: once on the guess, once for real. That is the cost of a
        # wrong speculation, and it is CPU rather than a wrong thing said.
        self.assertEqual(len(self.brain.calls), 2)
        self.assertIsNone(session._spec)

    def test_a_sound_with_no_words_cancels_the_guess_it_prompted(self) -> None:
        self._speculating()
        self.final_text = ""      # a cough that cleared the level threshold
        with self.client.websocket_connect(self._url()) as ws:
            self._init(ws, first_message="")
            ws.receive_json()
            self._speak(ws)
            time.sleep(0.4)
            ws.send_json({"type": "pong"})
        session = self.sessions[-1]
        self.assertIsNone(session._spec)
        self.assertEqual(session._stats["speculations_used"], 0)
        # Nothing became a turn: no history, no transcript, nothing spoken.
        self.assertEqual(session.history, [])
        self.assertEqual(session.recorder.turns, [])

    def test_a_guess_is_never_carried_into_the_next_turn(self) -> None:
        self._speculating()
        with self.client.websocket_connect(self._url()) as ws:
            self._init(ws, first_message="")
            ws.receive_json()
            self._speak(ws)
            self._until(ws, "agent_response")
            self._speak(ws)
            self._until(ws, "agent_response")
        session = self.sessions[-1]
        self.assertIsNone(session._spec)
        self.assertEqual(len(session.recorder.turns), 4)  # two turns, both sides

    def test_speculation_needs_partial_decoding_to_be_on(self) -> None:
        """The flags are independent, and thinking early depends on hearing early."""
        self._flags(convai_partial_decode=False, convai_speculate=True)
        with self.client.websocket_connect(self._url()) as ws:
            self._init(ws, first_message="")
            ws.receive_json()
            self._speak(ws, paced=False)
            self._until(ws, "agent_response")
        self.assertEqual(self.sessions[-1]._stats["speculations"], 0)
        self.assertEqual(self.partial_calls, 0)


class OpenerTests(_SocketCase):
    def test_an_opener_takes_the_floor_before_the_reply(self) -> None:
        self._flags(convai_openers=True)
        with self.client.websocket_connect(self._url()) as ws:
            self._init(ws, first_message="")
            ws.receive_json()
            self._speak(ws, paced=False)
            reply, before = self._until(ws, "agent_response")
            kinds = [m.get("type") for m in before]
            self.assertEqual(kinds[0], "user_transcript")
            # Audio between the transcript and the reply text: the backchannel.
            self.assertIn("audio", kinds)
        session = self.sessions[-1]
        self.assertEqual(session._stats["openers_sent"], 1)
        self.assertIn(convai.opener_phrases()[0], self.engine.executed)

    def test_an_opener_commits_the_agent_to_nothing(self) -> None:
        """It is audible, and it is not a turn: no text event, no history, no
        transcript row. A backchannel that answered anything would be a
        speculation that had already been spoken."""
        self._flags(convai_openers=True)
        with self.client.websocket_connect(self._url()) as ws:
            self._init(ws, first_message="")
            ws.receive_json()
            self._speak(ws, paced=False)
            reply, _ = self._until(ws, "agent_response")
        session = self.sessions[-1]
        phrase = convai.opener_phrases()[0]
        self.assertNotIn(phrase, [m["content"] for m in session.history])
        self.assertNotIn(phrase, [t.text for t in session.recorder.turns])
        self.assertEqual([t.role for t in session.recorder.turns],
                         ["candidate", "agent"])
        self.assertEqual(reply["agent_response_event"]["agent_response"],
                         self.brain.reply_text)

    def test_an_opener_never_plays_for_a_sound_with_no_words_in_it(self) -> None:
        """A confirmed turn end is words heard, not a level crossed."""
        self._flags(convai_openers=True)
        self.final_text = ""
        with self.client.websocket_connect(self._url()) as ws:
            self._init(ws, first_message="")
            ws.receive_json()
            self._speak(ws, paced=False)
            time.sleep(0.4)
            ws.send_json({"type": "pong"})
        self.assertEqual(self.sessions[-1]._stats["openers_sent"], 0)
        self.assertEqual(self.engine.executed, [])

    def test_an_opener_is_rendered_once_per_voice_and_then_cached(self) -> None:
        self._flags(convai_openers=True, convai_opener_phrases="Mm-hm.")
        with self.client.websocket_connect(self._url()) as ws:
            self._init(ws, first_message="")
            ws.receive_json()
            self._speak(ws, paced=False)
            self._until(ws, "agent_response")
            self._speak(ws, paced=False)
            self._until(ws, "agent_response")
        self.assertEqual(self.sessions[-1]._stats["openers_sent"], 2)
        self.assertEqual(self.engine.executed.count("Mm-hm."), 1)
        self.assertGreaterEqual(convai.opener_cache().stats()["hits"], 1)

    def test_an_excluded_agent_gets_no_opener(self) -> None:
        self._flags(convai_openers=True, convai_opener_agents="someone-else")
        with self.client.websocket_connect(self._url()) as ws:
            self._init(ws, first_message="")
            ws.receive_json()
            self._speak(ws, paced=False)
            reply, before = self._until(ws, "agent_response")
            self.assertEqual([m.get("type") for m in before], ["user_transcript"])
        self.assertEqual(self.sessions[-1]._stats["openers_sent"], 0)

    def test_a_failed_opener_costs_the_turn_nothing(self) -> None:
        self._flags(convai_openers=True, convai_opener_phrases="Mm-hm.")
        self.engine.errors = {"Mm-hm.": "no mouth today"}
        with self.client.websocket_connect(self._url()) as ws:
            self._init(ws, first_message="")
            ws.receive_json()
            self._speak(ws, paced=False)
            reply, _ = self._until(ws, "agent_response")
            self.assertEqual(reply["agent_response_event"]["agent_response"],
                             self.brain.reply_text)
            self.assertEqual(ws.receive_json()["type"], "audio")
        self.assertEqual(self.sessions[-1]._stats["openers_sent"], 0)


if __name__ == "__main__":
    unittest.main()
