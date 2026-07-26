"""Structural guard: blocking handlers must not run on the event loop.

FastAPI runs `def` path operations and `def` dependencies in the anyio
threadpool, and `async def` ones directly on the single event loop. Four upload
handlers were once `async def` purely because they needed `await file.read()`,
which put multi-second subprocesses (pocket_tts export-voice, ffprobe), 50 MB
writes and attacker-sized zip work on the loop — stalling every concurrent
synthesis response, stream chunk and admission decision.

These asserts fail if any of them (or the auth dependencies, which read the key
store from disk per request) regress to a coroutine.
"""
from __future__ import annotations

import inspect
import unittest

from service.tests import fake_engine  # installs shims — must precede app import

import service.app as appmod
import service.auth as auth
import service.ingest_api as ingest_api
import service.packs as packs
import service.takes as takes
import service.voices as voices


class BlockingHandlersRunOffLoopTests(unittest.TestCase):
    BLOCKING = [
        (voices.create_voice, "clone: ffmpeg + pocket_tts export-voice subprocess"),
        (ingest_api.start_scan, "ingest scan: 50MB write + ffprobe + sha256"),
        (takes.create_take, "take create: 25MB write + 500-file evict"),
        (packs.import_pack, "pack import: zip decompress + per-blob sha256"),
    ]

    def test_upload_handlers_are_sync(self) -> None:
        for fn, why in self.BLOCKING:
            with self.subTest(handler=fn.__name__):
                self.assertFalse(
                    inspect.iscoroutinefunction(fn),
                    f"{fn.__name__} must stay `def` so FastAPI threadpools it "
                    f"({why}); as `async def` it blocks the event loop")

    def test_auth_dependencies_are_sync(self) -> None:
        # Both factories return the dependency callable FastAPI will invoke.
        for factory, dep in (("require_scope", auth.require_scope("tts")),
                             ("require_read_write",
                              auth.require_read_write("tts", "voices"))):
            with self.subTest(factory=factory):
                self.assertFalse(
                    inspect.iscoroutinefunction(dep),
                    f"{factory}'s dependency must stay `def`: validate_key "
                    f"reads api_keys.json from disk on EVERY authenticated "
                    f"request, which must not happen on the event loop")


class HotPathOffloadTests(unittest.TestCase):
    """The synthesis path's remaining CPU/disk work goes through an executor."""

    def test_await_result_still_uses_wrap_future(self) -> None:
        # Guard the inverse rule: waiting must NOT park an executor thread.
        # (test_parallel asserts this behaviourally; this keeps the source
        # intent visible next to the offload asserts.)
        src = inspect.getsource(appmod._await_result)
        # Strip the docstring: it MENTIONS run_in_executor to explain what this
        # function deliberately does not do.
        body = src.split('"""')[2]
        self.assertIn("wrap_future", body)
        self.assertNotIn("run_in_executor", body)

    def test_concat_and_fallback_recording_are_offloaded(self) -> None:
        for fn in (appmod.speak, appmod.performance):
            with self.subTest(route=fn.__name__):
                src = inspect.getsource(fn)
                self.assertIn("_offload(concat_wavs", src,
                              "concat_wavs must run in an executor")
                self.assertNotIn("record_fallback(", src,
                                 "fallback recording must be batched through "
                                 "_offload(_record_fallbacks, ...)")


if __name__ == "__main__":
    unittest.main()
