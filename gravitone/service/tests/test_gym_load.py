"""What a busy box does to a replay, and how the artifact says so.

`test_gym::SuiteTests::test_baselines_make_the_second_run_a_comparison` failed
once during a heavily loaded full-suite run and passed in isolation. This file
is the characterisation of that flake, kept as a regression test.

The mechanism is NOT the pacing check (`wire.pace` is the float argument passed
to `replay()`, identical in both runs of a suite, bit-identical under any
load). It is the polite driver's three wall-clock deadlines. The server calls a
barge-in whenever the caller's next utterance starts while the agent's turn is
still pending (`convai._on_speech_start`); politeness is what keeps that race
from firing, and when a deadline expires on a slow box the driver feeds ON TOP
of the agent and manufactures the interruption itself. What fails downstream is
`interruptions_stable` / `agent_text_stable` / `turn_count_stable`.

Reproducing it by starving a real box was tried first and did not work: 20 busy
processes on 12 cores stretched the suite ~3x and never came near the 20 s / 10 s
deadlines. So these cases reproduce the same race by moving the OTHER side of
the same inequality - `patience` scales the deadlines below what this box's
agent actually takes - which is the identical condition (deadline < the time
the agent needs) reached in seconds instead of by luck.
"""
from __future__ import annotations

import json
import shutil
import unittest

from service.tests import fake_engine  # installs shims - must precede app import

import service.app as appmod  # noqa: E402
from service import gym  # noqa: E402
from service.tests.test_gym import FIXTURES, _GymCase, make_golden  # noqa: E402

# Small enough that the deadlines (20 s floor / 10 s ear / 3 s opening) land
# well under the ~1 s this case's engine needs to answer.
STARVED = 0.02


class StarvedDriverTests(_GymCase):
    def slow_engine(self, delay: float = 1.0) -> None:
        self.engine.close()
        self.engine = fake_engine.FakeEngine(workers=2, delay=delay)
        appmod.ENGINE = self.engine

    def test_a_driver_that_runs_out_of_patience_says_so(self) -> None:
        """The failure mode, named. Before this, the driver knew it had given
        up and the artifact did not - so the manufactured barge-in arrived
        downstream looking exactly like an agent that grew one."""
        self.slow_engine()
        run = self.replay(self.golden(), patience=STARVED)

        manners = run["politeness"]
        self.assertTrue(manners["gave_up"])
        self.assertGreaterEqual(manners["floor_timeouts"], 1)
        self.assertEqual(manners["patience"], STARVED)
        self.assertAlmostEqual(manners["deadlines_s"]["floor"],
                               gym.POLITE_MAX_WAIT_S * STARVED, places=3)
        # NOT asserted: that this run also grew an interruption. Measured, and
        # it is the second half of why the original flake was intermittent - a
        # floor timeout only RISKS a barge-in. After one it resumes feeding
        # frame by frame, each frame preceded by another (now expired) floor
        # wait, so the caller's next utterance may still finish arriving after
        # the agent's turn ended. Whether it converts depends on how the
        # remaining frames line up against the reply, which is exactly the coin
        # flip a suite must not be asked to score. `gave_up` is the part that
        # is deterministic, which is why it is the part compare() checks.
        self.assertIn(run["totals"]["interruptions"], (0, 1, 2))

    def test_a_healthy_replay_reports_its_headroom(self) -> None:
        """The same numbers on a box that kept up: no timeouts, and the longest
        wait is the margin the deadlines actually had. This is the measurement
        that told us CPU load alone was nowhere near enough to flake."""
        run = self.replay(self.golden())
        manners = run["politeness"]
        self.assertFalse(manners["gave_up"])
        self.assertEqual(manners["floor_timeouts"], 0)
        self.assertEqual(manners["reply_timeouts"], 0)
        self.assertLess(manners["longest_floor_wait_s"],
                        manners["deadlines_s"]["floor"])
        self.assertEqual(run["totals"]["interruptions"], 0)

    def test_compare_blames_the_box_and_not_the_agent(self) -> None:
        """The point of the whole direction. A starved run still fails - it
        SHOULD, the structure really did change - but the report leads with the
        driver having run out of patience rather than with an agent that
        suddenly grew an interruption."""
        golden = self.golden()
        healthy = self.replay(golden)
        self.slow_engine()
        starved = self.replay(golden, patience=STARVED)

        result = gym.compare(healthy, starved)
        self.assertEqual(result["verdict"], "fail")
        failed = [c for c in result["checks"] if not c["pass"]]
        self.assertEqual(failed[0]["check"], "polite_replay_intact")
        self.assertIn("b=True", failed[0]["got"])

    def test_patience_buys_the_margin_back_without_moving_a_threshold(self) -> None:
        """The fix for a shared runner: the same slow engine, the same product
        thresholds, a driver told to wait longer. Nothing about the bar moved."""
        self.slow_engine()
        run = self.replay(self.golden(), patience=1.0)
        self.assertFalse(run["politeness"]["gave_up"])
        self.assertEqual(run["totals"]["interruptions"], 0)
        self.assertEqual(gym.THRESHOLDS["interruption_delta_max"], 0)

    def test_an_older_artifact_without_the_block_is_not_read_as_a_give_up(self) -> None:
        """`politeness` is new. Absent means "not measured", never "it
        happened" - or every comparison against a pre-existing run would fail."""
        self.assertFalse(gym._gave_up({"schema": gym.RUN_SCHEMA}))


class SuitePatienceTests(_GymCase):
    def test_a_suite_can_declare_the_patience_its_runner_needs(self) -> None:
        """A suite checked in for CI meets a slower box than it was authored
        on. `patience` is how it says so - per suite, per case, or per run."""
        root = self.tmp / "suite"
        shutil.copytree(FIXTURES / "basic", root)
        make_golden(root / "recordings" / "two-turns")
        suite = json.loads((root / "suite.json").read_text("utf-8"))
        suite["cases"] = [dict(suite["cases"][0], patience=3.0)]
        (root / "suite.json").write_text(json.dumps(suite), "utf-8")

        result = gym.run_suite(root, app=appmod.app, work_dir=self.runs)
        self.assertEqual(result["verdict"], "pass", result["cases"])
        self.assertEqual(
            result["cases"][0]["run"]["politeness"]["patience"], 3.0)
        self.assertAlmostEqual(
            result["cases"][0]["run"]["politeness"]["deadlines_s"]["ear"],
            gym.POLITE_EAR_WAIT_S * 3.0, places=3)


if __name__ == "__main__":
    unittest.main()
