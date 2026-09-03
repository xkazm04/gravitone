"""The fleet block sums every pod, counts the ones that answered, and never
reports a missing pod as zero.

The direction this closes: the scaler read ONE pod's queue through the ClusterIP
balancer and KEDA applied it as the fleet average. Ten polls through a Service in
front of two pods, one of them loaded, flipped between 0 and N with the pod the
balancer picked. With the fleet block every pod answers the same total.
"""
from __future__ import annotations

import unittest

from service.tests import fake_engine  # noqa: F401 - installs shims before app import

from service import fleet


def _peer_docs(by_ip: dict[str, dict | None]):
    calls: list[str] = []

    def fetch(ip: str, port: int, api_key: str, timeout: float):
        calls.append(ip)
        return by_ip.get(ip)

    return fetch, calls


class FleetAggregation(unittest.TestCase):
    def test_every_pod_is_read_and_the_total_is_the_same_from_any_pod(self):
        # Two pods, one loaded: the sample the balancer used to hand the scaler
        # was either 0 or 7. The fleet total is 7 from either pod.
        docs = {
            "10.0.0.1": {"metrics": {"queued": 7, "in_flight": 2, "rejected_429": 1}},
            "10.0.0.2": {"metrics": {"queued": 0, "in_flight": 0, "rejected_429": 0}},
        }
        fetch, calls = _peer_docs(docs)
        out = fleet.aggregate(["10.0.0.1", "10.0.0.2"], 8080, "k", fetch=fetch)
        self.assertEqual(sorted(calls), ["10.0.0.1", "10.0.0.2"], "every peer is read, not one")
        self.assertEqual(out["queued"], 7)
        self.assertEqual(out["in_flight"], 2)
        self.assertEqual(out["pods_resolved"], 2)
        self.assertEqual(out["pods_answered"], 2)
        self.assertTrue(out["complete"])
        self.assertEqual(out["scope"], fleet.SCOPE_FLEET_TOTAL)
        # The ten-poll flip, as a unit fact: the number does not depend on which
        # pod the caller reached, because every pod computes the same sum.
        again = fleet.aggregate(["10.0.0.2", "10.0.0.1"], 8080, "k", fetch=fetch)
        self.assertEqual(again["queued"], out["queued"])

    def test_a_pod_that_does_not_answer_is_missing_not_zero(self):
        docs = {"10.0.0.1": {"metrics": {"queued": 5}}, "10.0.0.2": None}
        fetch, _ = _peer_docs(docs)
        out = fleet.aggregate(["10.0.0.1", "10.0.0.2"], 8080, "k", fetch=fetch)
        self.assertEqual(out["queued"], 5)
        self.assertEqual(out["pods_answered"], 1)
        self.assertEqual(out["pods_resolved"], 2)
        self.assertFalse(out["complete"], "a partial total says so instead of posing as the fleet")

    def test_no_peers_is_an_empty_fleet_not_an_error(self):
        out = fleet.aggregate([], 8080, "k", fetch=lambda *a: None)
        self.assertEqual(out["pods_resolved"], 0)
        self.assertEqual(out["queued"], 0)
        self.assertFalse(out["complete"])

    def test_snapshot_resolves_then_aggregates(self):
        fetch, calls = _peer_docs({"10.1.0.9": {"metrics": {"queued": 3}}})
        out = fleet.snapshot(
            "gravitone-peers.default.svc", 8080, "k",
            resolve=lambda host, port: ["10.1.0.9"], fetch=fetch,
        )
        self.assertEqual(calls, ["10.1.0.9"])
        self.assertEqual(out["queued"], 3)

    def test_unresolvable_address_book_is_an_empty_fleet(self):
        self.assertEqual(fleet.resolve_peers("no-such-host.invalid.", 8080), [])
        self.assertEqual(fleet.resolve_peers("", 8080), [])


if __name__ == "__main__":
    unittest.main()
