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


if __name__ == "__main__":
    unittest.main()
