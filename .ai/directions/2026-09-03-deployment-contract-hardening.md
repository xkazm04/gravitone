---
subject: software-engineering/deployment-contract
project: gravitone
raised_by: intake intake-kube-0903
source: librarian/sources/2026-09-03-kube-rs.md (peer study points 7, 8; the same finding kp measured this run)
stage: deploy/helm/gravitone/templates - a PodDisruptionBudget and a secret checksum annotation on the pod template
size: 2 files / ~40 lines / S
status: accepted
---

## Why the scope implies it

The scope says capacity is "a measured fact" and the chart "autoscales on queue depth". Two
platform-level facts undo that at the worst moment: a node drain removes every replica at once
(no PodDisruptionBudget), and a rotated root key never reaches running pods (the key arrives via
`envFrom: secretRef`, and the pod template does not change when the secret does). kp measured the
second this run: a byte-identical pod template across rotation.

## What the first context contains

`templates/pdb.yaml` with `minAvailable: 1` gated on a values flag, and a
`checksum/secret` annotation on the pod template computed from the rendered secret (skipped when
`apiKey.existingSecret` is set, since the chart does not render that secret). Both rules join the
policy gate of the sibling proposal when it lands. It must NOT absorb key rotation itself
(`service/keys.py` owns issued keys; this is only the root key the chart renders).

## The measurable

Rendering with `apiKey.value=a` and `=b`: pod templates byte-identical today, different after.
Drain: `kubectl drain` on a one-replica install succeeds silently today, refused loudly after.
Policies with a must-fail fixture: +2 when the gate exists.

## What would make this wrong

If every install uses `existingSecret` with an external rotation operator that restarts pods, the
checksum is redundant. `values.yaml` defaults `existingSecret` to empty, so the rendered secret is
the common case; the direction stands.
