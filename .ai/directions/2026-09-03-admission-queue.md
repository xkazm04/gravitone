---
subject: software-engineering/admission-queue
project: gravitone
raised_by: intake intake-kube-0903
source: librarian/sources/2026-09-03-kube-rs.md (design record entry B2 - a replica is correct only under stated properties of its source; peer study point 9)
stage: the /metrics endpoint service/app.py exposes and the KEDA trigger in deploy/helm/gravitone/templates/keda-scaledobject.yaml
size: 3 files / ~120 lines / M
status: proposed
---

## Why the scope implies it

The scope says the project autoscales "on queue depth". The scaler reads `metrics.queued` from
`http://<service>:<port>/metrics`, a ClusterIP that hands each poll to one pod, and KEDA applies
that one pod's queue as the fleet's per-replica average. `values.yaml:70-71` argues keda mode is
sound because each pod's queue is real; it is real, and it is one arbitrary pod's. The registry's
rule from this run: a replica of a remote fact is correct only under stated properties of its
source, and a random sample has none of them.

## What the first context contains

A fleet-wide reading of the admission queue for the scaler: either `/metrics` gains a
`fleet.queued` value aggregated over peers discovered through a headless Service (sum, and the
count of pods that answered), or the trigger switches to the scaler's per-pod mode over a headless
Service so every replica is read each poll. The values comment is rewritten to state which, and the
`single_replica_sample` marker the replica launcher already emits is honoured by the scaler
(refuse, not sample). It must NOT absorb the admission decision itself (`service/engine.py` owns
the 429) or the plan compiler.

## The measurable

Two pods, one loaded: ten polls through the Service today return a queued value that flips between
0 and N with the balancer's pick; after, ten polls return the same fleet number. Second number:
scale-up decisions per minute under a steady load, today noisy (each poll a coin flip), after
monotone until the target is met.

## What would make this wrong

If every production install runs `autoscaling.mode=cpu` and keda mode is a demo path, the fix is a
comment saying so. `service/plan.py` emits keda mode for Deployment topologies, so keda is the
planned path; the direction stands.
