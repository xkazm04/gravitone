---
peer: github:kube-rs/kube @ 7a4641d4cc2f693b2dee97b9fc15fadb96d7f62e
project: gravitone
raised_by: intake intake-kube-0903 (director pass, after onboarding; the worker lane was unavailable)
source: librarian/sources/2026-09-03-kube-rs.md
dimension: b - cluster operations (the fleet's most advanced cluster surface; language craft is out of dimension, the peer is Rust and this tree is Python)
points: 14
verdicts: adopt 4 / adapt 3 / keep ours 5 / different forces 2
---

# gravitone x kube-rs - what a control-plane client library says about the fleet's one autoscaled chart

The peer is a client of the control plane, not a workload on it, so the comparison is between
what it expects of a well-behaved workload and what this chart declares. Every anchor below was
opened this pass.

## Keep ours (5)

1. **Readiness and liveness are already two answers.** `templates/deployment.yaml` points readiness
   at `/health` (the config and metrics rollup, `service/app.py:10`) and liveness at a socket probe,
   with a 20 s initial delay and a 30-probe failure threshold covering model load. The registry's
   `health-checks` rule "one process, two answers" was landed this run from kp and the peer; this
   chart already obeys it. kp's did not.
2. **Capacity comes from replicas, never from in-process workers.** `TTS_WORKERS` is pinned to 1 in
   the template and the comment at `values.yaml:1-6` states the measured law (GIL-bound model). The
   peer's runner has the same shape one level up: a global cap over per-key slots.
3. **The scaling signal is the pre-429 signal.** KEDA reads `metrics.queued` (`keda-scaledobject.yaml`),
   the depth of the admission queue that precedes every 429. The peer's scheduler exposes no such
   number in production (its deviation 3); this tree does, and scales on it.
4. **The unsound topology is refused at plan time.** `values.yaml:68-76` states the SO_REUSEPORT
   caveat and `service/plan.py` applies it (autoscaling.mode=cpu for shared-port topologies). A rule
   stated where the choice is made, which is what the peer's docs do with the debounce hazard.
5. **Drain is bounded twice.** `TTS_DRAIN_TIMEOUT_S=20` inside `terminationGracePeriodSeconds: 45`,
   so the derived queue is abandoned before the kubelet kills the process. The peer's `drain-a-derived-queue`
   technique says exactly this.

## Adopt (4)

6. **A chart policy gate with must-fail fixtures.** Nothing reads `deploy/helm/gravitone/` in any
   gate; `sealed.yml` proves the image, not the chart. kp and tracklight both gained a text-level
   checker this run (kp: 16 policies, tracklight: 10) where the first run found six reds. Proposal:
   `2026-09-03-deployment-contract.md`.
7. **The pod rolls when the secret rotates.** The root key arrives via `envFrom: secretRef`
   (`deployment.yaml`), so a rotated `TTS_API_KEY` leaves running pods on the old value with no
   signal. kp measured this: a byte-identical pod template across rotation. Proposal:
   `2026-09-03-deployment-contract-hardening.md` (with 8).
8. **A drain refuses loudly.** No PodDisruptionBudget: a node drain takes every replica of a
   single-instance install at once. Same proposal as 7.
9. **The scaler must see the fleet, not one pod.** The metrics-api scaler polls
   `http://<service>:<port>/metrics` - a ClusterIP that load-balances to ONE pod per poll - and KEDA
   applies the value as the per-replica average. The comment at `values.yaml:70-71` argues keda mode
   is sound because each pod's queue is real; it is real, and it is one arbitrary pod's. The peer's
   watch subject says a replica is correct only under stated properties of its source; the source
   here is a random sample. Proposal: `2026-09-03-admission-queue.md`.

## Adapt (3)

10. **The health rollup names its red member.** `/health` today answers config and metrics; when
    the model pool is not loaded, the answer should name that member rather than a bare code (the
    registry's health-checks "a red carries its remedy"). Folded into proposal 6 as a policy
    (readiness must observe the pool), not a separate direction.
11. **Resource requests equal thread count, checked.** `values.yaml:38-40` says requests.cpu must
    equal `tts.torchThreads`; nothing checks it. A policy in proposal 6.
12. **The chart's defaults are one box's numbers.** The plan compiler emits an overlay carrying the
    certificate hash; the gate should refuse an install whose values carry no certificate header
    unless `allowUncertified` is set. A policy in proposal 6.

## Different forces (2)

13. **No finalizers, no owner references.** The chart owns no custom resources; deletion is the
    deployment's own. The peer's `declarative-resource-lifecycle` subject does not apply and is not
    proposed.
14. **No watch or replica of the control plane.** The service reads nothing from the API server;
    `watch-cache-and-resync` does not apply.

## Tests worth running first

- Render the chart with `apiKey.value=a` and `=b` and diff the pod template: identical today.
- Run two pods, load one, and poll `/metrics` through the Service ten times: the queued value
  flips between 0 and N with the pod the balancer picked.
- Render with `resources.requests.cpu=4` and `tts.torchThreads=2`: no gate objects today.
