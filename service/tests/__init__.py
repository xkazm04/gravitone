"""Tests for the Speech Synthesis API.

The real model stack (pocket-tts / torch) and scipy are NOT installed on the
build box, and even where they are we never want the real model in a unit test.
Importing :mod:`service.tests.fake_engine` FIRST injects lightweight stand-ins
for torch / scipy / pocket_tts into ``sys.modules`` so ``service.app`` and
``service.engine`` import cleanly, then swaps a deterministic fake pool in for
the real engine. Every test module here imports fake_engine before service.app.
"""
