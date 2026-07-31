"""The streaming speech gate — where a conversation decides a turn ended.

Every case here is audio built in the test, so the assertions are about the
state machine and not about a fixture: a tone is speech, digital silence is
not, and the boundaries between them are the only thing being measured.
"""
from __future__ import annotations

import math
import unittest

import numpy as np

from service.vad import SPEECH_END, SPEECH_START, SpeechGate

RATE = 16000


def tone(ms: int, amp: int = 3000, rate: int = RATE) -> bytes:
    """A 220 Hz tone at a realistic speech level (~-24 dBFS RMS).

    The amplitude matters: loudness-normalized speech sits well below full
    scale, and a gate tested with a full-scale tone would be tested against
    audio it will never receive.
    """
    n = int(rate * ms / 1000)
    t = np.arange(n, dtype=np.float64) / rate
    return (np.sin(2 * math.pi * 220 * t) * amp).astype("<i2").tobytes()


def silence(ms: int, rate: int = RATE) -> bytes:
    return b"\x00\x00" * int(rate * ms / 1000)


def noise(ms: int, amp: int = 60, rate: int = RATE, seed: int = 7) -> bytes:
    """A quiet hiss — a real room, not a digitally silent file."""
    rng = np.random.default_rng(seed)
    n = int(rate * ms / 1000)
    return (rng.normal(0, amp, n)).astype("<i2").tobytes()


def kinds(events) -> list[str]:
    return [e.kind for e in events]


class SpeechGateTests(unittest.TestCase):
    def test_silence_is_never_a_turn(self) -> None:
        gate = SpeechGate(RATE)
        self.assertEqual(kinds(gate.feed(silence(3000))), [])
        self.assertFalse(gate.speaking)

    def test_one_utterance_between_two_silences(self) -> None:
        gate = SpeechGate(RATE)
        events = gate.feed(silence(400) + tone(1000) + silence(1000))
        self.assertEqual(kinds(events), [SPEECH_START, SPEECH_END])
        utt = events[1].utterance
        self.assertEqual(utt.reason, "silence")
        # The tone is 1.0s. Pre-roll adds a little in front and the hangover is
        # trimmed off the back, so the span is close to the tone but not exact —
        # what matters is that a second of speech did not become three.
        self.assertAlmostEqual(utt.seconds, 1.0, delta=0.25)
        self.assertEqual(len(utt.pcm), int(utt.seconds * RATE) * 2)

    def test_trailing_silence_is_the_signal_not_the_speech(self) -> None:
        # A client that pads generously must not produce a longer utterance.
        short = SpeechGate(RATE)
        long = SpeechGate(RATE)
        a = short.feed(silence(200) + tone(800) + silence(800))[-1].utterance
        b = long.feed(silence(200) + tone(800) + silence(3000))[-1].utterance
        self.assertEqual(a.seconds, b.seconds)

    def test_a_click_is_not_a_word(self) -> None:
        gate = SpeechGate(RATE)
        events = gate.feed(silence(300) + tone(80) + silence(1000))
        # It may well START (that is what a transient looks like at onset), but
        # nothing under the minimum is ever handed on as an utterance.
        self.assertNotIn(SPEECH_END, kinds(events))

    def test_leading_edge_survives_the_onset_delay(self) -> None:
        # Onset needs consecutive loud frames to confirm, so without pre-roll
        # the utterance would start mid-word. The recovered span must be at
        # least as long as the tone that caused it.
        gate = SpeechGate(RATE)
        utt = gate.feed(silence(300) + tone(600) + silence(1000))[-1].utterance
        self.assertGreaterEqual(len(utt.pcm), len(tone(600)) - 2 * gate.frame_bytes)

    def test_chunk_size_does_not_move_the_boundary(self) -> None:
        """A client's packet size is not allowed to change what was heard."""
        audio = silence(300) + tone(700) + silence(1000)
        whole = SpeechGate(RATE).feed(audio)[-1].utterance
        piecemeal = SpeechGate(RATE)
        out = []
        for i in range(0, len(audio), 37):  # deliberately not a frame multiple
            out.extend(piecemeal.feed(audio[i:i + 37]))
        self.assertEqual(out[-1].utterance.pcm, whole.pcm)

    def test_a_monologue_is_cut_rather_than_buffered(self) -> None:
        gate = SpeechGate(RATE, max_speech_ms=1000)
        events = gate.feed(silence(300) + tone(3000))
        ends = [e for e in events if e.kind == SPEECH_END]
        self.assertTrue(ends)
        self.assertEqual(ends[0].utterance.reason, "max_length")

    def test_opening_mid_speech_costs_one_utterance_then_recovers(self) -> None:
        """The documented cost of tracking the floor instead of measuring it.

        A gate whose very first frame is already speech takes that level as the
        background and stays deaf until the speaker pauses. It is asserted here
        rather than left to be discovered: the first utterance is lost, the
        pause resets the floor, and everything after it is heard normally.
        """
        gate = SpeechGate(RATE)
        self.assertEqual(kinds(gate.feed(tone(900))), [])      # lost
        gate.feed(silence(900))                                # the floor resets
        self.assertEqual(kinds(gate.feed(tone(800) + silence(900))),
                         [SPEECH_START, SPEECH_END])           # heard

    def test_flush_closes_what_the_socket_cut_off(self) -> None:
        gate = SpeechGate(RATE)
        gate.feed(silence(200) + tone(800))
        self.assertTrue(gate.speaking)
        events = gate.flush()
        self.assertEqual(kinds(events), [SPEECH_END])
        self.assertEqual(events[0].utterance.reason, "flush")
        # And it invents nothing when there was no speech in progress.
        self.assertEqual(SpeechGate(RATE).flush(), [])

    def test_threshold_adapts_to_a_noisy_room(self) -> None:
        """Room tone must not be a turn, and speech over it still must be."""
        gate = SpeechGate(RATE)
        self.assertEqual(kinds(gate.feed(noise(2000))), [])
        self.assertGreater(gate.floor_db, -90.0)  # it heard the room
        events = gate.feed(tone(900) + noise(1200))
        self.assertEqual(kinds(events), [SPEECH_START, SPEECH_END])

    def test_two_turns_are_two_utterances(self) -> None:
        gate = SpeechGate(RATE)
        audio = (silence(300) + tone(700) + silence(900)
                 + tone(700) + silence(900))
        ends = [e for e in gate.feed(audio) if e.kind == SPEECH_END]
        self.assertEqual(len(ends), 2)
        self.assertLess(ends[0].utterance.ended_at_s, ends[1].utterance.started_at_s)


class UtteranceInProgressTests(unittest.TestCase):
    """The read-only view a speculative turn transcribes from.

    Every assertion here is also an assertion that LOOKING is free: the views
    report the buffer the gate was already keeping, and a caller that polls them
    on every chunk must get the same turn boundaries as one that never does.
    """

    def test_nothing_is_in_progress_before_a_turn_starts(self) -> None:
        gate = SpeechGate(RATE)
        gate.feed(silence(400))
        self.assertEqual(gate.partial_pcm(), b"")
        self.assertEqual(gate.voiced_ms, 0)
        self.assertFalse(gate.in_hangover)

    def test_the_utterance_so_far_grows_while_it_is_being_spoken(self) -> None:
        gate = SpeechGate(RATE)
        gate.feed(silence(300) + tone(400))
        first = gate.partial_pcm()
        self.assertTrue(first)
        self.assertEqual(len(first), int(gate.voiced_ms * RATE / 1000) * 2)
        gate.feed(tone(400))
        self.assertGreater(len(gate.partial_pcm()), len(first))
        self.assertTrue(gate.partial_pcm().startswith(first))  # nothing rewritten

    def test_hangover_is_speaking_but_quiet(self) -> None:
        """The window a speculation is allowed to think in."""
        gate = SpeechGate(RATE)
        gate.feed(silence(300) + tone(600))
        self.assertTrue(gate.speaking)
        self.assertFalse(gate.in_hangover)
        gate.feed(silence(100))          # quiet, but not yet long enough to end
        self.assertTrue(gate.speaking)
        self.assertTrue(gate.in_hangover)
        gate.feed(silence(1000))         # the turn ends
        self.assertFalse(gate.speaking)
        self.assertFalse(gate.in_hangover)

    def test_the_completed_utterance_is_what_was_being_watched(self) -> None:
        gate = SpeechGate(RATE)
        gate.feed(silence(300) + tone(700))
        watched = gate.partial_pcm()
        utt = gate.feed(silence(1000))[-1].utterance
        # The final utterance is the same audio with the trailing silence (the
        # end SIGNAL) trimmed — so a partial decode really did see the words.
        self.assertTrue(watched.startswith(utt.pcm[:len(watched)]))
        self.assertEqual(gate.partial_pcm(), b"")

    def test_polling_the_views_does_not_move_a_boundary(self) -> None:
        audio = silence(300) + tone(700) + silence(1000)
        quiet = SpeechGate(RATE).feed(audio)[-1].utterance
        polled = SpeechGate(RATE)
        events = []
        for i in range(0, len(audio), 640):
            events.extend(polled.feed(audio[i:i + 640]))
            polled.partial_pcm(), polled.voiced_ms, polled.in_hangover
        self.assertEqual(events[-1].utterance.pcm, quiet.pcm)


class EchoReferenceTests(unittest.TestCase):
    """Not mistaking our own output, heard back through an open mic, for a turn.

    A "quiet" tone here stands in for the echo: loud enough to clear the gate's
    threshold (which is what makes this a real problem) but well below the level
    we declared sending, which is what marks it as a leak rather than a person.
    """

    ECHO_LEVEL_DB = -24.0   # what we sent, roughly tone(amp=3000)

    def _ready(self) -> SpeechGate:
        gate = SpeechGate(RATE)
        gate.feed(silence(400))          # let the floor settle first
        return gate

    def test_without_a_reference_our_own_echo_takes_the_floor(self) -> None:
        """The problem, asserted first: this is what happens today."""
        gate = self._ready()
        self.assertEqual(kinds(gate.feed(tone(600, amp=400) + silence(1000))),
                         [SPEECH_START, SPEECH_END])

    def test_a_declared_window_suppresses_an_echo_level_onset(self) -> None:
        gate = self._ready()
        gate.expect_echo(self.ECHO_LEVEL_DB, 1.0)
        self.assertTrue(gate.echo_active)
        self.assertEqual(kinds(gate.feed(tone(600, amp=400) + silence(1000))), [])
        self.assertGreater(gate.suppressed_onsets, 0)

    def test_a_caller_clearly_louder_than_the_leak_still_barges_in(self) -> None:
        """Suppression is a level test, not deafness. Losing a real interruption
        is worse than hearing an echo, so the benefit of the doubt goes to the
        person."""
        gate = self._ready()
        gate.expect_echo(self.ECHO_LEVEL_DB, 1.0)
        self.assertEqual(kinds(gate.feed(tone(600, amp=3000) + silence(1000))),
                         [SPEECH_START, SPEECH_END])

    def test_a_caller_who_already_has_the_floor_is_never_re_judged(self) -> None:
        gate = self._ready()
        gate.feed(tone(500))                       # they are speaking
        self.assertTrue(gate.speaking)
        gate.expect_echo(self.ECHO_LEVEL_DB, 1.0)  # and now we speak too
        events = gate.feed(tone(400) + silence(1000))
        self.assertEqual(kinds(events), [SPEECH_END])
        self.assertEqual(events[0].utterance.reason, "silence")

    def test_the_window_is_spent_by_the_audio_that_follows_it(self) -> None:
        gate = self._ready()
        gate.expect_echo(self.ECHO_LEVEL_DB, 0.2)  # 200 ms + the lag allowance
        gate.feed(silence(1000))
        self.assertFalse(gate.echo_active)
        # ...and the gate is its normal self again afterwards.
        self.assertEqual(kinds(gate.feed(tone(600, amp=400) + silence(1000))),
                         [SPEECH_START, SPEECH_END])

    def test_overlapping_windows_are_judged_by_their_loudest_part(self) -> None:
        gate = self._ready()
        gate.expect_echo(-60.0, 1.0)                # a near-silent chunk
        gate.expect_echo(self.ECHO_LEVEL_DB, 1.0)   # then a loud one
        self.assertEqual(kinds(gate.feed(tone(600, amp=400) + silence(1000))), [])

    def test_declaring_nothing_opens_no_window(self) -> None:
        gate = self._ready()
        gate.expect_echo(self.ECHO_LEVEL_DB, 0.0, lag_ms=0)
        self.assertFalse(gate.echo_active)


if __name__ == "__main__":
    unittest.main()
