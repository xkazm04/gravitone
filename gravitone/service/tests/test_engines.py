"""The engine plane: the registry, the resolution rule, and GET /v1/engines.

``service/tests/engine_conformance.py`` is about what an ADAPTER does. This is
about the plane around them: that the four rules moved without changing a
letter of what they decide or of what they say when they refuse, that the
registry describes engines from live sources rather than a hardcoded list, that
convai's `_resolve_voice` is now a re-export of the same rule, and that
/v1/engines separates what an engine claims from what it has proven.

``test_piper.VoiceResolutionTests`` remains the router's specification and runs
unmodified through convai; the point of the overlap here is that the rule is
also correct when addressed DIRECTLY, by language, with no agent in sight --
which is how a third engine (or a per-language policy) would ask it.

The router is mounted on a bare FastAPI app on purpose: this suite must not
depend on service/app.py's wiring, ownership or auth dependencies.
"""
from __future__ import annotations

import dataclasses
import json
import tempfile
import unittest
from pathlib import Path

from service.tests import fake_engine  # installs shims — must precede app import

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from service import convai, dialog, engines, piper  # noqa: E402

CS_VOICE = "cs_CZ-jirka-medium"


class _PlaneCase(unittest.TestCase):
    """An empty voices directory, so "installed" is something a test chooses."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self._settings = piper.SETTINGS
        piper.SETTINGS = dataclasses.replace(piper.SETTINGS,
                                             piper_voices_dir=self._tmp.name)
        piper._CACHE.clear()

    def tearDown(self) -> None:
        piper.SETTINGS = self._settings
        piper._CACHE.clear()
        self._tmp.cleanup()

    def add_voice(self, name: str = CS_VOICE, rate: int | None = 22050) -> None:
        d = Path(self._tmp.name)
        (d / f"{name}.onnx").write_bytes(b"onnx")
        config = {"audio": {"sample_rate": rate}} if rate else {}
        (d / f"{name}.onnx.json").write_text(json.dumps(config), "utf-8")


class ResolutionTests(_PlaneCase):
    """The four rules, addressed by language instead of by agent."""

    def test_an_explicit_piper_voice_wins(self) -> None:
        self.add_voice()
        self.assertEqual(engines.resolve("en", CS_VOICE),
                         (engines.PIPER, CS_VOICE))

    def test_any_other_explicit_voice_goes_to_pocket(self) -> None:
        self.assertEqual(engines.resolve("en", "vera"), (engines.POCKET, "vera"))

    def test_a_language_pocket_cannot_speak_finds_a_piper_voice(self) -> None:
        self.add_voice()
        self.assertEqual(engines.resolve("cs"), (engines.PIPER, CS_VOICE))

    def test_a_regional_tag_is_understood(self) -> None:
        self.add_voice()
        self.assertEqual(engines.resolve("cs-CZ").engine_id, engines.PIPER)

    def test_a_speakable_language_takes_the_default_voice(self) -> None:
        for language in ("en", "fr", "", "EN-GB"):
            with self.subTest(language=language):
                resolved = engines.resolve(language)
                self.assertEqual(resolved.engine_id, engines.POCKET)
                self.assertEqual(resolved.voice_id,
                                 engines.SETTINGS.default_voice)

    def test_an_unspeakable_language_refuses_with_the_authored_text(self) -> None:
        """Word for word: this message is the only place the fix is written."""
        with self.assertRaises(engines.VoiceUnavailable) as caught:
            engines.resolve("cs", agent_id="local-interviewer-cs")
        message = str(caught.exception)
        self.assertTrue(message.startswith(
            "agent 'local-interviewer-cs' speaks 'cs', which Pocket TTS "
            "cannot synthesize (it speaks ['en', 'fr'])"), message)
        self.assertIn("download_voices", message)
        self.assertIn(self._tmp.name, message)
        self.assertIn("explicit voice_id", message)

    def test_a_refusal_without_an_agent_still_says_what_to_do(self) -> None:
        """Resolution is a capability question; an agent is not required."""
        with self.assertRaises(engines.VoiceUnavailable) as caught:
            engines.resolve("cs")
        message = str(caught.exception)
        self.assertTrue(message.startswith("this replica speaks 'cs'"), message)
        self.assertIn("download_voices", message)

    def test_the_resolution_is_a_named_pair(self) -> None:
        resolved = engines.resolve("en")
        self.assertEqual(resolved.engine_id, engines.POCKET)
        self.assertEqual(resolved.voice_id, resolved[1])


class ConvaiReExportTests(_PlaneCase):
    """convai keeps its names; the rule behind them moved."""

    @staticmethod
    def agent(**kwargs) -> dialog.Agent:
        return dialog.Agent(**({"agent_id": "a", "name": "A", "prompt": "p"}
                               | kwargs))

    def test_the_exception_is_the_same_class_object(self) -> None:
        """Every `except VoiceUnavailable` in convai must catch what the plane
        raises -- a same-named copy would silently stop catching."""
        self.assertIs(convai.VoiceUnavailable, engines.VoiceUnavailable)

    def test_the_pocket_language_set_is_the_same_object(self) -> None:
        self.assertIs(convai._POCKET_LANGUAGES, engines.POCKET_LANGUAGES)

    def test_the_shim_returns_the_is_piper_boolean_callers_expect(self) -> None:
        self.add_voice()
        self.assertEqual(convai._resolve_voice(self.agent(language="cs")),
                         (CS_VOICE, True))
        self.assertEqual(convai._resolve_voice(self.agent(language="en")),
                         (engines.SETTINGS.default_voice, False))

    def test_the_shim_names_the_agent_in_its_refusal(self) -> None:
        with self.assertRaises(convai.VoiceUnavailable) as caught:
            convai._resolve_voice(self.agent(agent_id="poly", language="cs"))
        self.assertIn("agent 'poly'", str(caught.exception))


class RegistryTests(_PlaneCase):
    def test_exactly_the_two_engines_that_exist(self) -> None:
        self.assertEqual(sorted(engines.engines()), [engines.PIPER, engines.POCKET])
        self.assertIsNone(engines.get("kokoro"))

    def test_pocket_declares_the_things_only_it_can_do(self) -> None:
        caps = engines.get(engines.POCKET).capabilities()
        self.assertTrue(caps.clones)
        self.assertTrue(caps.emotions)
        self.assertEqual(caps.languages, ("en", "fr"))
        # Not a guess dressed up as a measurement: the model owns the rate.
        self.assertIsNone(caps.native_rate)

    def test_piper_declares_the_opposite_and_reads_disk_to_do_it(self) -> None:
        piper_engine = engines.get(engines.PIPER)
        self.assertEqual(piper_engine.capabilities().languages, ())
        self.add_voice()
        caps = piper_engine.capabilities()
        self.assertEqual(caps.languages, ("cs",))
        self.assertFalse(caps.clones)
        self.assertFalse(caps.emotions)
        self.assertEqual(caps.license, "MIT")
        self.assertEqual(caps.native_rate, 22050)

    def test_a_voice_config_without_a_rate_declares_none(self) -> None:
        """Half a manifest is not a rate. Absent beats invented."""
        self.add_voice(rate=None)
        self.assertIsNone(engines.get(engines.PIPER).capabilities().native_rate)

    def test_capabilities_are_frozen(self) -> None:
        caps = engines.get(engines.PIPER).capabilities()
        with self.assertRaises(dataclasses.FrozenInstanceError):
            caps.engine_id = "kokoro"   # type: ignore[misc]

    def test_the_registry_cannot_be_edited_through_a_copy(self) -> None:
        engines.engines().pop(engines.PIPER)
        self.assertIn(engines.PIPER, engines.engines())


class BootConformanceTests(_PlaneCase):
    def test_every_engine_had_its_declaration_checked_at_import(self) -> None:
        for engine_id in engines.engines():
            with self.subTest(engine=engine_id):
                report = engines.conformance(engine_id)
                self.assertIsNotNone(report)
                self.assertEqual(report.level, "declaration")
                self.assertTrue(report.passed, report.problems)
                self.assertGreater(report.checked, 0)

    def test_a_malformed_declaration_is_a_finding_not_a_crash(self) -> None:
        class Liar:
            engine_id = "liar"

            def capabilities(self):
                return engines.EngineCapabilities(
                    engine_id="liar", languages=("Czech",), clones=False,
                    emotions=False, native_rate=0, license="", install_hint="",
                    concurrency=0)

            def list_voices(self):
                return []

        checked, problems = engines.check_declaration(Liar())
        self.assertGreater(checked, 0)
        self.assertEqual(len(problems), 5)
        self.assertTrue(any("language tag" in p for p in problems))
        self.assertTrue(any("licence" in p for p in problems))


class EnginesRouteTests(_PlaneCase):
    """GET /v1/engines, on the plane's own router."""

    def setUp(self) -> None:
        super().setUp()
        app = FastAPI()
        app.include_router(engines.router)
        self.client = TestClient(app)

    def get(self) -> dict:
        res = self.client.get("/v1/engines")
        self.assertEqual(res.status_code, 200, res.text)
        return res.json()

    def _engine(self, body: dict, engine_id: str) -> dict:
        return next(e for e in body["engines"]
                    if e["capabilities"]["engine_id"] == engine_id)

    def test_it_reports_both_engines(self) -> None:
        body = self.get()
        self.assertEqual([e["capabilities"]["engine_id"] for e in body["engines"]],
                         [engines.PIPER, engines.POCKET])

    def test_it_reports_the_rule_so_a_refusal_can_be_understood(self) -> None:
        body = self.get()
        self.assertEqual(body["resolution"]["pocket_languages"], ["en", "fr"])
        self.assertEqual(body["resolution"]["default_voice"],
                         engines.SETTINGS.default_voice)
        self.assertEqual(len(body["resolution"]["rules"]), 4)

    def test_installing_a_voice_changes_the_surface_with_no_restart(self) -> None:
        self.assertEqual(self._engine(self.get(), engines.PIPER)["voices"], [])
        self.add_voice()
        described = self._engine(self.get(), engines.PIPER)
        self.assertEqual(described["voices"], [CS_VOICE])
        self.assertEqual(described["capabilities"]["languages"], ["cs"])

    def test_declared_and_proven_are_reported_separately(self) -> None:
        described = self._engine(self.get(), engines.POCKET)
        self.assertIsNone(described["capabilities"]["native_rate"])
        self.assertIn("sample_rate", described["proven"])

    def test_it_says_which_conformance_an_engine_has_passed(self) -> None:
        described = self._engine(self.get(), engines.PIPER)
        self.assertEqual(described["conformance"]["level"], "declaration")
        self.assertTrue(described["conformance"]["passed"])

    def test_a_behavioural_result_shows_up_when_one_has_been_recorded(self) -> None:
        previous = engines.conformance(engines.PIPER)
        engines.record_conformance(engines.PIPER, level="behavioural",
                                   passed=True, checked=9)
        try:
            described = self._engine(self.get(), engines.PIPER)
            self.assertEqual(described["conformance"]["level"], "behavioural")
        finally:
            engines._CONFORMANCE[engines.PIPER] = previous

    def test_the_pocket_voice_roster_is_the_real_registry(self) -> None:
        """Not a hardcoded list: the premade characters really are there."""
        self.assertIn("alba", self._engine(self.get(), engines.POCKET)["voices"])


if __name__ == "__main__":
    unittest.main()
