"""Tests for the Speech Synthesis API.

The real model stack (pocket-tts / torch) and scipy are NOT installed on the
build box, and even where they are we never want the real model in a unit test.
Importing :mod:`service.tests.fake_engine` FIRST injects lightweight stand-ins
for torch / scipy / pocket_tts into ``sys.modules`` so ``service.app`` and
``service.engine`` import cleanly, then swaps a deterministic fake pool in for
the real engine. Every test module here imports fake_engine before service.app.

Auth must be deterministic regardless of the checkout's local ``.env`` (which
sets TTS_API_KEY on dev/deploy boxes): a real environment variable wins over
``.env``, so pinning TTS_API_KEY to "" here forces open mode for every test.
This runs before any test module imports service.config.
"""

import os

os.environ["TTS_API_KEY"] = ""
