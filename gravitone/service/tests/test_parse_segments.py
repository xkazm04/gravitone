"""The metatag parser — the one function that decides what gets SPOKEN.

``parse_segments`` sits under /v1/speak, /v1/performance, narration and
re-perform, and until now it had no test of its own: every emotion test in this
suite exercised ``resolve`` and handed it segments directly. That matters
because the parser's failure mode is silent and loud at the same time — a run of
text the tag regex does not match is not an error, it is CONTENT, and the engine
reads it out. `[excited` (unclosed bracket), `[x[/x]` (the shape a backspace
used to leave behind) and `[2fast]` are all "spoken out loud", not "rejected".

So these pin the grammar as the docstring at the top of emotions.py states it,
including the parts that surprise people: the grammar does NOT nest, an unclosed
tag runs to the next tag, and unknown names are accepted here and resolved
later.
"""
from __future__ import annotations

import unittest

from service import emotions as em


def segs(text: str) -> list[tuple[str, str]]:
    """(text, requested-emotion) pairs — the shape assertions read best in."""
    return [(s.text, s.emotion) for s in em.parse_segments(text)]


class GrammarTests(unittest.TestCase):
    def test_plain_text_is_one_baseline_segment(self) -> None:
        self.assertEqual(segs("Hello there."), [("Hello there.", "baseline")])

    def test_empty_text_still_yields_a_segment(self) -> None:
        # Callers index [0]; an empty list here would be an IndexError upstream.
        self.assertEqual(segs(""), [("", "baseline")])

    def test_tagged_span_splits_three_ways(self) -> None:
        self.assertEqual(
            segs("Hello. [excited]This is amazing![/excited] Bye."),
            [("Hello.", "baseline"),
             ("This is amazing!", "excited"),
             ("Bye.", "baseline")],
        )

    def test_unclosed_tag_runs_to_the_end(self) -> None:
        self.assertEqual(
            segs("Calm. [sad]And then everything went wrong."),
            [("Calm.", "baseline"), ("And then everything went wrong.", "sad")],
        )

    def test_unclosed_tag_stops_at_the_next_tag(self) -> None:
        self.assertEqual(
            segs("a[sad]b[happy]c"),
            [("a", "baseline"), ("b", "sad"), ("c", "happy")],
        )

    def test_pseudo_nesting_does_not_nest(self) -> None:
        # `[/b]` returns to BASELINE, not to the enclosing `a` — which is why
        # the studio refuses overlapping regions rather than drawing them.
        self.assertEqual(
            segs("[a]x[b]y[/b]z[/a]"),
            [("x", "a"), ("y", "b"), ("z", "baseline")],
        )

    def test_bare_close_and_empty_tag_both_return_to_baseline(self) -> None:
        self.assertEqual(segs("[sad]a[/]b"), [("a", "sad"), ("b", "baseline")])
        self.assertEqual(segs("[sad]a[]b"), [("a", "sad"), ("b", "baseline")])
        self.assertEqual(segs("[sad]a[/anything]b"), [("a", "sad"), ("b", "baseline")])

    def test_empty_spans_produce_no_segment(self) -> None:
        self.assertEqual(segs("[sad][/sad]hello"), [("hello", "baseline")])
        self.assertEqual(segs("[sad][happy]hi[/happy]"), [("hi", "happy")])

    def test_a_whitespace_only_span_is_not_a_segment(self) -> None:
        # push() strips, and a chunk that strips to nothing is dropped: there is
        # no audio in "   ", so a Voice must not be selected for it.
        self.assertEqual(segs("one[sad]   [/sad]two"),
                         [("one", "baseline"), ("two", "baseline")])

    def test_surrounding_whitespace_is_stripped_per_segment(self) -> None:
        self.assertEqual(
            segs("  one  [sad]  two  [/sad]  three  "),
            [("one", "baseline"), ("two", "sad"), ("three", "baseline")],
        )

    def test_tag_names_are_lowercased(self) -> None:
        self.assertEqual(segs("[EXCITED]hi[/EXCITED]"), [("hi", "excited")])
        self.assertEqual(segs("[ExCiTeD]hi"), [("hi", "excited")])

    def test_baseline_written_as_a_tag_is_just_baseline(self) -> None:
        self.assertEqual(segs("[baseline]hi[/baseline]"), [("hi", "baseline")])

    def test_unknown_name_is_carried_through_for_resolve_to_answer(self) -> None:
        # The parser does not know the scale and must not guess: `excitedd` is a
        # well-shaped tag, so it is REQUESTED, and resolve() is what falls back.
        self.assertEqual(segs("[excitedd]hi[/excitedd]"), [("hi", "excitedd")])
        self.assertEqual(
            em.resolve("excitedd", {"baseline": "b"}), ("b", "baseline", True))


class MalformedTagTests(unittest.TestCase):
    """Anything the regex does not match is TEXT, and text is spoken."""

    def test_unclosed_bracket_is_spoken(self) -> None:
        self.assertEqual(segs("say [excited this"), [("say [excited this", "baseline")])

    def test_the_backspaced_pair_is_spoken(self) -> None:
        # `[x[/x]` — what the old web-side `wrapWithTag` left after one
        # backspace. The `[/x]` half still matches, so the broken opener is
        # spoken as part of the line.
        self.assertEqual(segs("[x[/x]hi"), [("[x", "baseline"), ("hi", "baseline")])

    def test_a_name_opening_with_a_digit_is_not_a_tag(self) -> None:
        # normalize_emotion refuses this slug too, so both grammars agree that
        # `[2fast]` is words.
        self.assertEqual(segs("[2fast]hi[/2fast]"),
                         [("[2fast]hi[/2fast]", "baseline")])
        with self.assertRaises(ValueError):
            em.normalize_emotion("2fast")

    def test_a_hyphenated_name_is_not_a_tag(self) -> None:
        self.assertEqual(segs("[battle-cry]charge"), [("[battle-cry]charge", "baseline")])


class DigitGrammarTests(unittest.TestCase):
    """The asymmetry this batch closed: a legal slug you could not address."""

    def test_a_digit_bearing_slug_is_addressable_inline(self) -> None:
        self.assertEqual(em.normalize_emotion("mode2"), "mode2")
        self.assertEqual(segs("[mode2]hi[/mode2]"), [("hi", "mode2")])

    def test_digits_anywhere_after_the_first_character(self) -> None:
        self.assertEqual(segs("[v2]a[/v2][take_3]b[/take_3]"),
                         [("a", "v2"), ("b", "take_3")])

    def test_every_name_the_old_grammar_carried_still_parses(self) -> None:
        for name in ("excited", "battle_cry", "_private", "X", "a"):
            with self.subTest(name=name):
                self.assertEqual(segs(f"[{name}]hi[/{name}]"), [("hi", name.lower())])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
