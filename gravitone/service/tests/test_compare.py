"""Comparison refuses the diffs that would invent a regression.

Two load-test results are only subtractable when they measured the same thing:
same schema, same cache mode, same route, same corpus, same Arm fast-math mode,
and both actually exercising the model. Everything else is a refusal with the
mismatched field named - because a "5% regression" attributed to a commit that
merely flipped ONEDNN_DEFAULT_FPMATH_MODE is worse than no gate at all.

Pure over dicts: no server, no torch, no filesystem.
"""
from __future__ import annotations

import unittest

from service import compare as cmp
from service import loadtest as lt


def _level(**over) -> dict:
    row = {"concurrency": 1, "ok": 40, "rejected_429": 0, "errors": 0,
           "timeouts": 0, "server_rtf_mean": 2.5, "audio_s_per_wall_s": 3.0,
           "lat_p95_s": 1.0, "cache_mode": "bypass", "cache_hits": 0,
           "measures_synthesis": True}
    row.update(over)
    return row


def _result(rows=None, *, cache_mode="bypass", schema=lt.SCHEMA_VERSION,
            route="synth", corpus="the default sentence", fpmath="bf16",
            recommended_cap=4) -> dict:
    rows = rows if rows is not None else [_level(), _level(concurrency=4)]
    return {
        "schema_version": schema,
        "route": route,
        "corpus": corpus,
        "cache_mode": cache_mode,
        "onednn_fpmath_mode": fpmath,
        "levels": rows,
        "recommended_cap": recommended_cap,
        "measurement": lt.measurement_block(rows, cache_mode),
    }


class ToleranceParsingTests(unittest.TestCase):
    def test_percent_and_fraction_spellings_agree(self) -> None:
        self.assertAlmostEqual(cmp.parse_tolerance("5%"), 0.05)
        self.assertAlmostEqual(cmp.parse_tolerance("0.05"), 0.05)
        self.assertAlmostEqual(cmp.parse_tolerance(0.05), 0.05)

    def test_a_bare_number_at_or_above_one_is_read_as_percent(self) -> None:
        # The footgun this exists to close: "--fail-on-regress 5" must not
        # silently become a 500% band that can never fail.
        self.assertAlmostEqual(cmp.parse_tolerance("5"), 0.05)
        self.assertAlmostEqual(cmp.parse_tolerance("100"), 1.0)

    def test_nonsense_is_refused(self) -> None:
        for bad in ("five", "-1", "1000%"):
            with self.subTest(spec=bad), self.assertRaises(ValueError):
                cmp.parse_tolerance(bad)


class RefusalMatrixTests(unittest.TestCase):
    """Every basis mismatch refuses, and NAMES the field it refused on."""

    def _refusal(self, **new_over) -> dict:
        return cmp.diff_results(_result(), _result(**new_over))

    def test_identical_basis_is_comparable(self) -> None:
        diff = cmp.diff_results(_result(), _result())
        self.assertTrue(diff["comparable"])
        self.assertEqual(diff["reasons"], [])

    def test_cache_mode_mismatch_is_refused(self) -> None:
        diff = self._refusal(cache_mode="allow")
        self.assertFalse(diff["comparable"])
        self.assertTrue(any("cache_mode" in r for r in diff["reasons"]))

    def test_route_mismatch_is_refused(self) -> None:
        diff = self._refusal(route="stream")
        self.assertFalse(diff["comparable"])
        self.assertTrue(any(r.startswith("route differs") for r in diff["reasons"]))

    def test_corpus_mismatch_is_refused(self) -> None:
        diff = self._refusal(corpus="workload:typical seed=0")
        self.assertFalse(diff["comparable"])
        self.assertTrue(any(r.startswith("corpus differs") for r in diff["reasons"]))

    def test_fpmath_mismatch_is_refused(self) -> None:
        # The biggest perf lever on Neoverse: a diff across it is a
        # configuration difference wearing a regression's clothes.
        diff = self._refusal(fpmath="fp32")
        self.assertFalse(diff["comparable"])
        self.assertTrue(any("onednn_fpmath_mode" in r for r in diff["reasons"]))

    def test_schema_mismatch_is_refused(self) -> None:
        diff = cmp.diff_results(_result(schema=2), _result())
        self.assertFalse(diff["comparable"])
        self.assertTrue(any("schema" in r for r in diff["reasons"]))

    def test_every_mismatch_is_reported_not_just_the_first(self) -> None:
        diff = cmp.diff_results(_result(),
                                _result(route="stream", fpmath="fp32"))
        self.assertGreaterEqual(len(diff["reasons"]), 2)

    def test_refused_diff_reports_no_levels_and_no_verdict(self) -> None:
        diff = self._refusal(fpmath="fp32")
        self.assertEqual(diff["levels"], [])
        self.assertFalse(diff["regressed"])
        self.assertFalse(diff["gateable"])
        passed, why = cmp.gate_verdict(diff)
        self.assertFalse(passed)
        self.assertIn("refused", why)


class MeasuresSynthesisTests(unittest.TestCase):
    def test_a_cache_contaminated_new_run_is_refused(self) -> None:
        dirty = _result([_level(cache_hits=7)])
        diff = cmp.diff_results(_result(), dirty)
        self.assertFalse(diff["comparable"])
        self.assertTrue(any("new run does not measure synthesis" in r
                            for r in diff["reasons"]))

    def test_a_cache_contaminated_baseline_is_refused_too(self) -> None:
        dirty = _result([_level(cache_hits=7)])
        diff = cmp.diff_results(dirty, _result())
        self.assertFalse(diff["comparable"])
        self.assertTrue(any("old run does not measure synthesis" in r
                            for r in diff["reasons"]))

    def test_explicit_false_flag_is_honoured_without_recomputing(self) -> None:
        res = _result()
        res["measurement"]["measures_synthesis"] = False
        ok, why = cmp.measures_synthesis(res)
        self.assertFalse(ok)
        self.assertIn("measures_synthesis is false", why)


class DeltaDirectionTests(unittest.TestCase):
    """A sign error here would report every improvement as a regression."""

    def _one_level(self, old_over, new_over, tolerance=0.05) -> dict:
        old = _result([_level(**old_over)], recommended_cap=1)
        new = _result([_level(**new_over)], recommended_cap=1)
        return cmp.diff_results(old, new, tolerance)

    def test_slower_rtf_regresses(self) -> None:
        diff = self._one_level({"server_rtf_mean": 2.5},
                               {"server_rtf_mean": 2.0})
        entry = diff["levels"][0]["metrics"]["server_rtf_mean"]
        self.assertTrue(entry["regressed"])
        self.assertAlmostEqual(entry["delta_pct"], -20.0)
        self.assertTrue(diff["regressed"])

    def test_faster_rtf_does_not_regress(self) -> None:
        diff = self._one_level({"server_rtf_mean": 2.0},
                               {"server_rtf_mean": 2.5})
        self.assertFalse(diff["levels"][0]["metrics"]["server_rtf_mean"]["regressed"])
        self.assertFalse(diff["regressed"])

    def test_higher_p95_regresses_and_lower_does_not(self) -> None:
        worse = self._one_level({"lat_p95_s": 1.0}, {"lat_p95_s": 1.5})
        better = self._one_level({"lat_p95_s": 1.5}, {"lat_p95_s": 1.0})
        self.assertTrue(worse["levels"][0]["metrics"]["lat_p95_s"]["regressed"])
        self.assertFalse(better["levels"][0]["metrics"]["lat_p95_s"]["regressed"])

    def test_lower_audio_throughput_regresses(self) -> None:
        diff = self._one_level({"audio_s_per_wall_s": 3.0},
                               {"audio_s_per_wall_s": 2.0})
        self.assertTrue(
            diff["levels"][0]["metrics"]["audio_s_per_wall_s"]["regressed"])

    def test_movement_inside_the_band_is_noise_not_a_regression(self) -> None:
        diff = self._one_level({"server_rtf_mean": 2.50},
                               {"server_rtf_mean": 2.44}, tolerance=0.05)
        self.assertFalse(diff["regressed"])
        # ... and the same movement fails a tighter band.
        tight = self._one_level({"server_rtf_mean": 2.50},
                                {"server_rtf_mean": 2.44}, tolerance=0.01)
        self.assertTrue(tight["regressed"])

    def test_a_missing_metric_never_votes(self) -> None:
        diff = self._one_level({"server_rtf_mean": 2.5},
                               {"server_rtf_mean": None})
        entry = diff["levels"][0]["metrics"]["server_rtf_mean"]
        self.assertFalse(entry["regressed"])
        self.assertIsNone(entry["delta_pct"])
        self.assertEqual(entry["note"], "missing on one side")

    def test_a_zero_baseline_yields_no_percentage(self) -> None:
        diff = self._one_level({"server_rtf_mean": 0.0},
                               {"server_rtf_mean": 2.5})
        entry = diff["levels"][0]["metrics"]["server_rtf_mean"]
        self.assertIsNone(entry["delta_pct"])
        self.assertFalse(entry["regressed"])


class CapacityTests(unittest.TestCase):
    def test_a_fallen_cap_is_a_run_level_regression(self) -> None:
        diff = cmp.diff_results(_result(recommended_cap=4),
                                _result(recommended_cap=2))
        self.assertTrue(diff["capacity"]["recommended_cap"]["regressed"])
        self.assertIn("run", [r["scope"] for r in diff["regressions"]])

    def test_a_risen_cap_is_not(self) -> None:
        diff = cmp.diff_results(_result(recommended_cap=2),
                                _result(recommended_cap=4))
        self.assertFalse(diff["regressed"])


class LevelPairingTests(unittest.TestCase):
    def test_levels_pair_by_concurrency_not_by_position(self) -> None:
        old = _result([_level(concurrency=4, server_rtf_mean=1.0),
                       _level(concurrency=1, server_rtf_mean=2.5)])
        new = _result([_level(concurrency=1, server_rtf_mean=2.5),
                       _level(concurrency=4, server_rtf_mean=1.0)])
        diff = cmp.diff_results(old, new)
        # Position-paired, every metric would look like a huge move.
        self.assertFalse(diff["regressed"])
        self.assertEqual([lv["concurrency"] for lv in diff["levels"]], [1, 4])

    def test_unpaired_levels_are_reported_and_not_compared(self) -> None:
        old = _result([_level(concurrency=1), _level(concurrency=2)])
        new = _result([_level(concurrency=1), _level(concurrency=8)])
        diff = cmp.diff_results(old, new)
        self.assertEqual(diff["unpaired"], {"old_only": [2], "new_only": [8]})
        self.assertEqual([lv["concurrency"] for lv in diff["levels"]], [1])


class ExclusionTests(unittest.TestCase):
    """Noisy levels are visible in the report and silent in the verdict."""

    def test_low_confidence_level_is_excluded_by_name(self) -> None:
        old = _result([_level(server_rtf_mean=2.5)], recommended_cap=1)
        new = _result([_level(server_rtf_mean=1.0, low_confidence=True)],
                      recommended_cap=1)
        diff = cmp.diff_results(old, new)
        level = diff["levels"][0]
        self.assertTrue(level["excluded"])
        self.assertTrue(any("low_confidence" in r
                            for r in level["exclusion_reasons"]))
        # The delta is still REPORTED - exclusion hides nothing.
        self.assertAlmostEqual(level["metrics"]["server_rtf_mean"]["delta_pct"],
                               -60.0)
        self.assertFalse(diff["regressed"])

    def test_driver_saturated_level_is_excluded_by_name(self) -> None:
        old = _result([_level(server_rtf_mean=2.5, driver_saturated=True)],
                      recommended_cap=1)
        new = _result([_level(server_rtf_mean=1.0)], recommended_cap=1)
        diff = cmp.diff_results(old, new)
        self.assertTrue(any("driver_saturated" in r for r
                            in diff["levels"][0]["exclusion_reasons"]))
        self.assertFalse(diff["regressed"])

    def test_a_clean_level_still_decides_when_a_sibling_is_excluded(self) -> None:
        old = _result([_level(concurrency=1, server_rtf_mean=2.5),
                       _level(concurrency=4, server_rtf_mean=1.5)],
                      recommended_cap=4)
        new = _result([_level(concurrency=1, server_rtf_mean=2.5,
                              low_confidence=True),
                       _level(concurrency=4, server_rtf_mean=1.0)],
                      recommended_cap=4)
        diff = cmp.diff_results(old, new)
        self.assertTrue(diff["gateable"])
        self.assertTrue(diff["regressed"])
        self.assertEqual({r["scope"] for r in diff["regressions"]},
                         {"concurrency=4"})

    def test_an_all_excluded_diff_cannot_substantiate_a_pass(self) -> None:
        old = _result([_level(low_confidence=True)], recommended_cap=1)
        new = _result([_level(low_confidence=True)], recommended_cap=1)
        diff = cmp.diff_results(old, new)
        self.assertFalse(diff["gateable"])
        passed, why = cmp.gate_verdict(diff)
        self.assertFalse(passed)
        self.assertIn("excluded", why)


class GateVerdictTests(unittest.TestCase):
    def test_a_clean_diff_passes_and_says_what_it_gated_on(self) -> None:
        passed, why = cmp.gate_verdict(cmp.diff_results(_result(), _result()))
        self.assertTrue(passed)
        self.assertIn("gated level", why)

    def test_a_regression_fails_and_names_the_worst_metric(self) -> None:
        old = _result([_level(server_rtf_mean=2.5)], recommended_cap=1)
        new = _result([_level(server_rtf_mean=1.0, lat_p95_s=1.05)],
                      recommended_cap=1)
        passed, why = cmp.gate_verdict(cmp.diff_results(old, new))
        self.assertFalse(passed)
        self.assertIn("server_rtf_mean", why)

    def test_report_renders_ascii_for_both_outcomes(self) -> None:
        for diff in (cmp.diff_results(_result(), _result()),
                     cmp.diff_results(_result(), _result(fpmath="fp32"))):
            text = cmp.format_report(diff)
            text.encode("ascii")     # raises if any non-ASCII crept in
            self.assertIn("Gravitone performance diff", text)


class SymmetryTests(unittest.TestCase):
    """Fixtures in BOTH directions: a diff must not be quietly one-way."""

    def test_reversing_the_arguments_reverses_the_verdict(self) -> None:
        fast = _result([_level(server_rtf_mean=2.5, lat_p95_s=1.0)],
                       recommended_cap=4)
        slow = _result([_level(server_rtf_mean=1.5, lat_p95_s=2.0)],
                       recommended_cap=2)
        self.assertTrue(cmp.diff_results(fast, slow)["regressed"])
        self.assertFalse(cmp.diff_results(slow, fast)["regressed"])

    def test_a_run_compared_with_itself_never_regresses(self) -> None:
        res = _result()
        self.assertFalse(cmp.diff_results(res, res)["regressed"])


class HarnessOutputTests(unittest.TestCase):
    """The real harness's own output shape is comparable without hand-editing."""

    def test_two_build_result_documents_diff_cleanly(self) -> None:
        meta = lt.runtime_metadata()

        def run(rtf):
            rows = [_level(server_rtf_mean=rtf)]
            return lt.build_result(rows, knee=None, recommended=1,
                                   route="synth", fmt="wav_24000",
                                   corpus=lt.TEXT_DEFAULT, service_config={},
                                   meta=meta, cache_mode="bypass")

        diff = cmp.diff_results(run(2.5), run(2.5))
        self.assertTrue(diff["comparable"], diff["reasons"])
        self.assertTrue(diff["gateable"])
        self.assertFalse(diff["regressed"])
        self.assertTrue(cmp.diff_results(run(2.5), run(1.0))["regressed"])


if __name__ == "__main__":
    unittest.main()
