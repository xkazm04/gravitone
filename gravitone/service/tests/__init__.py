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

Same reason, same place: the durable build-artifact store (service/buildstore.py)
defaults to ``REPO_ROOT/build_store``, and every suite that POSTs to
``/v1/text-to-speech`` publishes its fake audio into it. Under test that would
scatter artifacts through the working tree, so the store is pointed at a
throwaway directory outside the checkout before service.config is imported.
"""

import os
import tempfile

os.environ["TTS_API_KEY"] = ""
# Disarm the app-wired demo per-IP budgets: every suite shares ONE fake client
# address, so a heavy suite would 429 itself on infrastructure it is not
# testing. test_ratelimit proves the limiter on its own instances.
os.environ["GRAVITONE_RATELIMIT_TEST_BYPASS"] = "1"
# Same reasoning as TTS_API_KEY above, and it matters more: a dev or deploy box
# whose ``.env`` names a real SENTRY_DSN would otherwise have `service.app`
# initialize error reporting at import and ship ~2000 tests' worth of
# deliberately-provoked exceptions into a live project. A real environment
# variable beats ``.env``, so pinning it empty here forces reporting OFF for
# every test module. test_observability turns it on explicitly, against a
# capturing transport that never opens a socket.
os.environ["SENTRY_DSN"] = ""
os.environ.setdefault(
    "GRAVITONE_BUILD_STORE_DIR",
    os.path.join(tempfile.gettempdir(), "gravitone-build-store-tests"))
