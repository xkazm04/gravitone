---
subject: software-engineering/deployment-contract
project: gravitone
raised_by: intake intake-kube-0903
source: librarian/sources/2026-09-03-kube-rs.md (design record entries E1, A3; peer study points 6, 10-12)
stage: a text-level policy check over deploy/helm/gravitone/, run beside the service test loop and in a CI job, with one must-fail fixture per policy
size: 3 files / ~250 lines / M
status: proposed
---

## Why the scope implies it

The scope says the project *does* "ship as a sealed, air-gapped appliance image and a Helm chart"
and treats capacity as "a measured fact". The image has a proof (`sealed.yml` boots it with no
network); the chart has none: nothing in any gate reads `deploy/helm/gravitone/`. kp and tracklight
gained the same instrument this run and kp's first run found six of nine policies red on a chart
that looked fine.

## What the first context contains

`scripts/check-chart.mjs` (node is already a dependency through `scripts/gravitone-build.mjs`),
reading the rendered templates as text (no helm binary, no cluster) and asserting the rules the
chart already states in comments but nowhere enforces:

- readiness and liveness read different endpoints (they do today; the rule keeps it so);
- readiness observes the model pool: `/health` reports the pool member, not only config;
- `resources.requests.cpu` equals `tts.torchThreads` (`values.yaml:38-40` says so, nothing checks);
- `autoscaling.mode=keda` is refused when the topology shares a port (the `plan.py` rule, at the gate);
- a values overlay carries the certificate header, or `allowUncertified: true` is set explicitly;
- every template under `templates/` is read (no allowlist that a new file can dodge).

Each policy ships with a scratch chart under `scripts/deploy-fixtures/` that trips it, and a test
asserts the fixture fails and the shipped chart passes. It must NOT absorb the plan compiler
(`service/plan.py` owns the topology math) or the sealed-image proof.

## The measurable

Policies red on the shipped chart, first run: predicted 3 of 6 (pool member in /health, certificate
header, requests-vs-threads). Target 0, each fixed in the chart or waived with a reason. Second
number: must-fail fixtures 0 → 6, all failing on their fixture and passing on the chart.

## What would make this wrong

If nobody installs the chart (the appliance ships as an image and a one-click cloud script), a chart
gate guards an artifact with no consumer. Check `deploy/README.md`'s three ways: the Helm way is one
of them and the plan compiler targets it; the direction stands.
