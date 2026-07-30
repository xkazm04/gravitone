"""Verified speech: the normalizer, the alignment mapper, the fidelity scorer,
and the two routes that expose them.

Two halves, on purpose:

  * ``service/verify.py`` is pure and is tested WITHOUT any model — numerals,
    abbreviations, dropped/extra/mangled words, the confidence floor and the
    character timeline are all deterministic arithmetic over text.
  * the routes are tested with the fake engine plus a STUBBED transcriber (the
    convention every other stt-touching suite uses: monkeypatch
    ``stt.transcribe_pcm``), because faster-whisper's weights are absent on the
    build box.

The load-bearing guard is ``DefaultPathUntouchedTests``: without ``?verify``
the drop-in route must not touch the ear, must not grow a header, and must
return exactly the bytes it returned before any of this existed.
"""
from __future__ import annotations

import base64
import json
import unittest
from dataclasses import dataclass

from service.tests import fake_engine  # installs shims — must precede app import

import service.app as appmod
import service.stt as stt
import service.verify as verify
from fastapi.testclient import TestClient


@dataclass
class ScoredWord:
    """An ASR word that DOES carry a probability (stt.Word does not yet)."""
    text: str
    start: float
    end: float
    probability: float


def words(*specs) -> list:
    """``words(("hello", 0.0, 0.5), ...)`` -> stt.Word list."""
    return [stt.Word(text=t, start=s, end=e) for t, s, e in specs]


def evenly(text: str, duration: float = 2.0) -> list:
    """One stt.Word per whitespace token, spread evenly over ``duration``."""
    parts = text.split()
    step = duration / max(1, len(parts))
    return [stt.Word(text=p, start=round(i * step, 3),
                     end=round((i + 1) * step, 3))
            for i, p in enumerate(parts)]


def transcript(text: str, word_list=None, duration: float = 2.0) -> stt.Transcript:
    return stt.Transcript(text=text, language_code="en",
                          language_probability=0.99, duration_s=duration,
                          transcribe_s=0.01, words=list(word_list or []))


# ---------------------------------------------------------------------------
# The normalizer
# ---------------------------------------------------------------------------
class NormalizerTests(unittest.TestCase):
    def test_case_and_punctuation_fold_away(self) -> None:
        self.assertEqual(verify.canonical_words("Hello, World!"),
                         ["hello", "world"])
        self.assertEqual(verify.canonical_words("Don't -- stop."),
                         ["dont", "stop"])
        # Curly and straight apostrophes are one word, not two spellings.
        self.assertEqual(verify.canonical_words("don’t"),
                         verify.canonical_words("don't"))

    def test_numerals_expand_to_their_spoken_form(self) -> None:
        self.assertEqual(verify.canonical_words("42"), ["forty", "two"])
        self.assertEqual(verify.canonical_words("105"),
                         ["one", "hundred", "five"])
        self.assertEqual(verify.canonical_words("1,200"),
                         ["one", "thousand", "two", "hundred"])
        self.assertEqual(verify.canonical_words("3.5"),
                         ["three", "point", "five"])

    def test_numeral_variants_cover_the_year_readings(self) -> None:
        self.assertIn(["nineteen", "ninety"], verify.numeral_variants("1990"))
        self.assertIn(["nineteen", "oh", "five"], verify.numeral_variants("1905"))
        self.assertIn(["nineteen", "hundred"], verify.numeral_variants("1900"))
        # A leading zero is always read digit by digit — never "seven".
        self.assertEqual(verify.numeral_variants("007"),
                         [["zero", "zero", "seven"]])

    def test_abbreviations_expand_and_ambiguous_ones_do_not(self) -> None:
        self.assertEqual(verify.canonical_words("Dr. Chen"), ["doctor", "chen"])
        self.assertEqual(verify.canonical_words("etc."), ["et", "cetera"])
        self.assertEqual(verify.canonical_words("50% & up"),
                         ["fifty", "percent", "and", "up"])
        # "St." could be Street or Saint; a wrong expansion would manufacture a
        # delta, so it is left alone deliberately.
        self.assertEqual(verify.canonical_words("St. James"), ["st", "james"])

    def test_both_sides_share_one_normalizer(self) -> None:
        # The whole point: written "42" and heard "forty-two" are the same
        # words, in either direction.
        self.assertEqual(verify.canonical_words("Room 42."),
                         verify.canonical_words("room forty-two"))


# ---------------------------------------------------------------------------
# The scorer
# ---------------------------------------------------------------------------
class FidelityTests(unittest.TestCase):
    def test_a_perfect_read_scores_one(self) -> None:
        report = verify.compare("The quick brown fox.",
                                evenly("the quick brown fox"))
        self.assertEqual(report.score, 1.0)
        self.assertEqual(report.deltas, [])
        self.assertEqual(report.matched, 4)

    def test_a_dropped_word_is_named_and_located(self) -> None:
        report = verify.compare("The quick brown fox.",
                                evenly("the quick fox"))
        self.assertLess(report.score, 1.0)
        [delta] = report.rated_deltas
        self.assertEqual(delta.kind, "missing")
        self.assertEqual(delta.expected, "brown")
        self.assertEqual("The quick brown fox."[delta.at:delta.at + 5], "brown")

    def test_a_mangled_word_and_an_invented_one_are_different_kinds(self) -> None:
        wrong = verify.compare("Deploy the react app.",
                               evenly("deploy the rust app"))
        self.assertEqual([d.kind for d in wrong.rated_deltas], ["wrong"])
        extra = verify.compare("Deploy the app.",
                               evenly("deploy the whole app"))
        self.assertEqual([d.kind for d in extra.rated_deltas], ["extra"])

    def test_numerals_read_the_other_way_are_not_errors(self) -> None:
        report = verify.compare("Founded in 1990.",
                                evenly("founded in nineteen ninety"))
        self.assertEqual(report.score, 1.0)
        self.assertEqual(report.rated_deltas, [])

    def test_low_confidence_words_never_indict_the_synthesizer(self) -> None:
        heard = [ScoredWord("deploy", 0.0, 0.5, 0.99),
                 ScoredWord("the", 0.5, 0.7, 0.99),
                 ScoredWord("rust", 0.7, 1.2, 0.10)]  # the EAR fumbled it
        report = verify.compare("Deploy the react.", heard)
        self.assertEqual(report.score, 1.0, "an ASR stumble is not a TTS defect")
        self.assertEqual(report.rated_deltas, [])
        self.assertEqual(report.unrated, 1)
        self.assertEqual(report.confidence_source, "asr")

    def test_a_confident_mismatch_still_counts(self) -> None:
        heard = [ScoredWord("deploy", 0.0, 0.5, 0.99),
                 ScoredWord("the", 0.5, 0.7, 0.99),
                 ScoredWord("rust", 0.7, 1.2, 0.97)]
        report = verify.compare("Deploy the react.", heard)
        self.assertLess(report.score, 1.0)
        self.assertEqual([d.kind for d in report.rated_deltas], ["wrong"])

    def test_confidence_source_says_when_no_floor_was_applied(self) -> None:
        # stt.Word carries no probability today; the report must SAY that
        # rather than imply a floor it never applied.
        report = verify.compare("Hello there.", evenly("hello there"))
        self.assertEqual(report.confidence_source, "unrated")

    def test_absent_is_not_zero(self) -> None:
        report = verify.compare("", [])
        self.assertIsNone(report.score)
        self.assertEqual(verify.score_header(report), "unrated")
        silence = verify.compare("Anybody there?", [])
        # Nothing heard at all IS a failure of the audio, not an unrated clip.
        self.assertEqual(silence.score, 0.0)

    def test_deltas_header_is_base64_json_and_bounded(self) -> None:
        report = verify.compare("one two three four five six.", evenly("one"))
        header = verify.deltas_header(report, limit=1)
        payload = json.loads(base64.b64decode(header).decode("utf-8"))
        self.assertLessEqual(len(payload["deltas"]), 1)
        self.assertIn("score", payload)
        # Non-ASCII words must survive: an HTTP header is latin-1, which is
        # exactly why the evidence is base64 and not plain text.
        czech = verify.compare("Ahoj světe.", evenly("ahoj"))
        json.loads(base64.b64decode(verify.deltas_header(czech)).decode("utf-8"))


# ---------------------------------------------------------------------------
# The alignment mapper
# ---------------------------------------------------------------------------
class AlignmentTests(unittest.TestCase):
    TEXT = "Hello brave world."

    def test_words_carry_source_spans_and_measured_times(self) -> None:
        al = verify.align(self.TEXT, evenly("hello brave world", 3.0),
                          duration_s=3.0)
        self.assertEqual([w.text for w in al.words], ["Hello", "brave", "world"])
        self.assertEqual(self.TEXT[al.words[1].start:al.words[1].end], "brave")
        self.assertTrue(all(w.matched for w in al.words))
        self.assertEqual(al.words[0].start_s, 0.0)
        self.assertEqual(al.anchored, 3)

    def test_an_unheard_word_is_interpolated_and_says_so(self) -> None:
        al = verify.align(self.TEXT, evenly("hello world", 3.0), duration_s=3.0)
        middle = al.words[1]
        self.assertFalse(middle.matched)
        self.assertGreaterEqual(middle.start_s, al.words[0].end_s)
        self.assertLessEqual(middle.end_s, al.words[2].start_s)
        self.assertEqual(al.interpolated, 1)

    def test_the_timeline_is_over_the_request_text_not_the_transcript(self) -> None:
        # The ear heard something else entirely; the caller still gets a
        # timeline over the words it sent.
        al = verify.align(self.TEXT, evenly("goodbye cruel planet", 3.0),
                          duration_s=3.0)
        self.assertEqual([w.text for w in al.words], ["Hello", "brave", "world"])
        self.assertFalse(any(w.matched for w in al.words))

    def test_character_timeline_is_complete_and_monotonic(self) -> None:
        al = verify.align(self.TEXT, evenly("hello brave world", 3.0),
                          duration_s=3.0)
        block = al.characters(self.TEXT)
        self.assertEqual(len(block["characters"]), len(self.TEXT))
        self.assertEqual(len(block["character_start_times_seconds"]),
                         len(self.TEXT))
        starts = block["character_start_times_seconds"]
        ends = block["character_end_times_seconds"]
        self.assertEqual(starts, sorted(starts))
        for s, e in zip(starts, ends):
            self.assertLessEqual(s, e)
        # Punctuation the ear never says still gets a time (the trailing ".").
        self.assertGreater(ends[-1], 0.0)

    def test_normalized_alignment_drops_punctuation(self) -> None:
        al = verify.align(self.TEXT, evenly("hello brave world", 3.0),
                          duration_s=3.0)
        norm = al.normalized()
        self.assertNotIn(".", norm["characters"])
        self.assertEqual("".join(norm["characters"]), "Hello brave world")

    def test_a_numeral_anchors_every_word_it_expands_to(self) -> None:
        al = verify.align("Room 42.", evenly("room forty two", 3.0),
                          duration_s=3.0)
        self.assertEqual([w.text for w in al.words], ["Room", "42"])
        self.assertTrue(al.words[1].matched)
        # The span covers BOTH heard words.
        self.assertGreater(al.words[1].end_s, al.words[1].start_s)


# ---------------------------------------------------------------------------
# The routes
# ---------------------------------------------------------------------------
class _RouteBase(unittest.TestCase):
    HEARD = "Hello world."

    def setUp(self) -> None:
        self._orig_engine = appmod.ENGINE
        self._orig_transcribe = stt.transcribe_pcm
        self._orig_available = stt.available
        appmod.SYNTH_CACHE.clear()
        appmod.ALIGN_CACHE.clear()
        appmod.ENGINE = fake_engine.FakeEngine(workers=2, delay=0.01)
        self.transcriptions = 0
        self.ears = True
        stt.available = lambda: self.ears
        stt.transcribe_pcm = self._transcribe
        self.client = TestClient(appmod.app)

    def _transcribe(self, pcm, **kwargs):
        self.transcriptions += 1
        return transcript(self.HEARD, evenly(self.HEARD))

    def tearDown(self) -> None:
        eng = appmod.ENGINE
        if isinstance(eng, fake_engine.FakeEngine):
            eng.close()
        appmod.ENGINE = self._orig_engine
        stt.transcribe_pcm = self._orig_transcribe
        stt.available = self._orig_available
        appmod.SYNTH_CACHE.clear()
        appmod.ALIGN_CACHE.clear()

    def _post(self, path: str = "", **params):
        return self.client.post(f"/v1/text-to-speech/alba{path}", params=params,
                                json={"text": "Hello world."})


class DefaultPathUntouchedTests(_RouteBase):
    """No ?verify => the hot path is exactly what it was. Pinned, not assumed."""

    def test_no_transcription_and_no_fidelity_headers(self) -> None:
        r = self._post()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.transcriptions, 0,
                         "the default path must never touch the transcriber")
        for header in ("x-fidelity-score", "x-fidelity-deltas",
                       "x-fidelity-retries", "x-alignment-cache"):
            self.assertNotIn(header, r.headers)

    def test_bytes_and_headers_are_identical_with_and_without_the_param(self) -> None:
        # Same request twice (the second served from cache, so the BYTES are
        # comparable at all — the fake engine marks every render differently).
        first = self._post()
        second = self._post(verify="false")
        self.assertEqual(first.content, second.content)
        self.assertEqual(set(first.headers), set(second.headers))
        self.assertEqual(self.transcriptions, 0)

    def test_an_unknown_verify_value_is_a_400_not_a_silent_off(self) -> None:
        r = self._post(verify="maybe")
        self.assertEqual(r.status_code, 400)
        self.assertIn("verify", r.json()["detail"])

    def test_the_streaming_route_has_no_verify_surface(self) -> None:
        # Headers are flushed before synthesis finishes, so a post-hoc verdict
        # cannot ride on them; the parameter must not exist rather than be
        # accepted and ignored.
        route = [r for r in appmod.app.routes
                 if getattr(r, "path", "") == "/v1/text-to-speech/{voice_id}/stream"][0]
        self.assertNotIn("verify", [p.name for p in route.dependant.query_params])


class VerifyQueryTests(_RouteBase):
    def test_verify_true_reports_a_score_and_evidence(self) -> None:
        r = self._post(verify="true")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.transcriptions, 1)
        self.assertEqual(r.headers["x-fidelity-score"], "1.000")
        payload = json.loads(
            base64.b64decode(r.headers["x-fidelity-deltas"]).decode("utf-8"))
        self.assertEqual(payload["deltas"], [])
        self.assertEqual(payload["score"], 1.0)
        # The audio is unchanged by having been listened to.
        self.assertEqual(r.content[:4], b"RIFF")

    def test_a_bad_render_is_reported_not_hidden(self) -> None:
        self.HEARD = "Hello."
        r = self._post(verify="true")
        self.assertEqual(r.status_code, 200)
        self.assertLess(float(r.headers["x-fidelity-score"]), 1.0)
        payload = json.loads(
            base64.b64decode(r.headers["x-fidelity-deltas"]).decode("utf-8"))
        self.assertEqual(payload["deltas"][0]["expected"], "world")

    def test_a_missing_transcriber_is_named_never_a_crash(self) -> None:
        self.ears = False
        r = self._post(verify="true")
        self.assertEqual(r.status_code, 200, "synthesis is not in doubt")
        self.assertEqual(r.headers["x-fidelity-score"], "unavailable")
        self.assertEqual(r.headers["x-fidelity-unavailable"], "stt-model-absent")
        self.assertNotIn("x-fidelity-deltas", r.headers)
        self.assertEqual(self.transcriptions, 0)

    def test_verification_does_not_disturb_the_cache_contract(self) -> None:
        self.assertEqual(self._post(verify="true").headers["x-cache"], "miss")
        self.assertEqual(self._post(verify="true").headers["x-cache"], "hit")


class StrictRetryTests(_RouteBase):
    """verify=strict re-renders ONCE, bounded by ordinary admission."""

    def setUp(self) -> None:
        super().setUp()
        self.heard_sequence = ["Hello.", "Hello world."]

    def _transcribe(self, pcm, **kwargs):
        i = min(self.transcriptions, len(self.heard_sequence) - 1)
        self.transcriptions += 1
        text = self.heard_sequence[i]
        return transcript(text, evenly(text))

    def test_a_bad_first_render_is_retried_and_the_better_one_served(self) -> None:
        r = self._post(verify="strict")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["x-fidelity-retries"], "1")
        self.assertEqual(r.headers["x-fidelity-score"], "1.000")
        self.assertEqual(self.transcriptions, 2)
        # Two renders: the original and the retry.
        self.assertEqual(len(appmod.ENGINE.executed), 2)

    def test_a_good_first_render_never_pays_for_a_retry(self) -> None:
        self.heard_sequence = ["Hello world."]
        r = self._post(verify="strict")
        self.assertEqual(r.headers["x-fidelity-retries"], "0")
        self.assertEqual(len(appmod.ENGINE.executed), 1)

    def test_a_retry_that_is_no_better_keeps_the_first_render(self) -> None:
        self.heard_sequence = ["Hello.", "Hello."]
        r = self._post(verify="strict")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["x-fidelity-retries"], "1")
        self.assertLess(float(r.headers["x-fidelity-score"]), 1.0)

    def test_a_saturated_box_refuses_the_retry_instead_of_queueing(self) -> None:
        appmod.ENGINE.close()
        appmod.ENGINE = fake_engine.FakeEngine(workers=1, delay=0.01, capacity=1)
        r = self._post(verify="strict")
        self.assertEqual(r.status_code, 200)
        # Either the retry got in (1) or admission refused it (0) — never a
        # failed request, and never more than one extra render.
        self.assertIn(r.headers["x-fidelity-retries"], ("0", "1"))
        self.assertLessEqual(len(appmod.ENGINE.executed), 2)


class WithTimestampsTests(_RouteBase):
    def test_elevenlabs_shape(self) -> None:
        r = self._post("/with-timestamps")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        for key in ("audio_base64", "alignment", "normalized_alignment"):
            self.assertIn(key, body)
        audio = base64.b64decode(body["audio_base64"])
        self.assertEqual(audio[:4], b"RIFF")
        block = body["alignment"]
        self.assertEqual(len(block["characters"]), len("Hello world."))
        self.assertEqual(len(block["character_start_times_seconds"]),
                         len(block["characters"]))
        self.assertEqual(len(block["character_end_times_seconds"]),
                         len(block["characters"]))

    def test_it_also_carries_words_a_verdict_and_the_guesswork_count(self) -> None:
        body = self._post("/with-timestamps").json()
        self.assertEqual([w["text"] for w in body["words"]], ["Hello", "world"])
        self.assertTrue(all(w["matched"] for w in body["words"]))
        self.assertEqual(body["fidelity"]["score"], 1.0)
        self.assertEqual(body["anchored_words"], 2)
        self.assertEqual(body["interpolated_words"], 0)

    def test_the_synthesis_headers_are_the_drop_in_route_s(self) -> None:
        r = self._post("/with-timestamps")
        for header in ("x-audio-seconds", "x-synth-seconds", "x-queue-seconds",
                       "x-realtime-factor", "x-cache"):
            self.assertIn(header, r.headers)
        self.assertEqual(r.headers["x-alignment-cache"], "miss")

    def test_the_alignment_is_cached_beside_the_audio(self) -> None:
        first = self._post("/with-timestamps")
        second = self._post("/with-timestamps")
        self.assertEqual(second.headers["x-alignment-cache"], "hit")
        self.assertEqual(second.headers["x-cache"], "hit")
        self.assertEqual(self.transcriptions, 1,
                         "a cached alignment must not re-transcribe")
        self.assertEqual(first.json()["alignment"], second.json()["alignment"])

    def test_the_route_is_part_of_the_cache_key(self) -> None:
        plain = appmod._cache_key("alba", "Hello world.", {}, None)
        self.assertNotEqual(appmod._alignment_key(plain), plain)

    def test_no_transcriber_refuses_by_name_before_synthesizing(self) -> None:
        self.ears = False
        r = self._post("/with-timestamps")
        self.assertEqual(r.status_code, 501)
        self.assertIn("speech-to-text", r.json()["detail"])
        self.assertEqual(len(appmod.ENGINE.jobs), 0,
                         "a request that cannot be answered must not synthesize")

    def test_mp3_is_still_available_here(self) -> None:
        # Unlike /stream, a JSON body carries a whole clip, so mp3 is fine.
        import service.engine as enginemod
        import types as _t
        orig = enginemod.subprocess.run
        enginemod.subprocess.run = lambda *a, **k: _t.SimpleNamespace(
            returncode=0, stdout=b"MP3DATA", stderr=b"")
        self.addCleanup(setattr, enginemod.subprocess, "run", orig)
        body = self._post("/with-timestamps", output_format="mp3_24000_128").json()
        self.assertEqual(base64.b64decode(body["audio_base64"]), b"MP3DATA")
        self.assertEqual(body["content_type"], "audio/mpeg")


if __name__ == "__main__":
    unittest.main()
