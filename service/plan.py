"""Deployment compiler -- the artifact writes its own topology from a measurement.

Every scaling fact this project learned the hard way is currently prose or a
default someone must remember to change: ``deploy/bootstrap.sh`` pins one
container with ``TTS_TORCH_THREADS=min(4, cores)`` (so a c8g.2xlarge is
deliberately 4x underused), ``deploy/helm/gravitone/values.yaml`` hardcodes
``replicaCount: 4`` for ONE instance shape, and ``deploy/README.md`` warns in
English that ingest is replica-affine and will 404 behind round-robin. All
three are computable from a certificate the box already produces.

    python -m service.plan certification.json                # deployment-plan.json
    python -m service.plan certification.json --emit helm-values
    python -m service.plan certification.json --emit compose

The plan is DERIVED, never invented. Three rules follow from that, and they
are the whole reason this module refuses more than it emits:

  * **A failing certificate plans nothing.** A wrong plan is worse than a
    conservative default: the operator would deploy numbers that carry the
    authority of a measurement without one behind them. Exit 2, named reason.
  * **A predicted rate plans nothing.** ``service.certify`` already refuses to
    SIGN a fitted/extrapolated envelope ("a certificate may only promise
    arrivals that actually happened"); a topology compiled from one would
    launder the same hypothesis into a replica count. Same refusal, same voice.
  * **Floors and ceilings are named constants, and every clamp that binds says
    so** in ``plan["notes"]``. A plan that silently halved itself to fit memory
    is a plan nobody can debug.

Reads v2 and v3 certificates. When a v3 ``capacity_contract`` is present it is
PREFERRED as the sizing basis -- it is an open-loop measurement of arrivals
that actually happened at a latency SLO, which is the question a deployment
asks; v2's closed-loop concurrency ramp answers a different one and is the
fallback. The plan says which basis it used.

Integrity verification is NOT re-implemented here: ``--verify`` calls
``service.certify.verify_certificate``, and the plan carries ``cert_sha`` in
its provenance so an emitted artifact can always be tied back to the exact
certificate it came from.

Pure stdlib. No network, no torch, no live service -- a plan is a pure function
of a certificate plus this file's constants.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

from service import certify

PLAN_VERSION = "gravitone-plan/1"

# --- floors and ceilings ----------------------------------------------------
# Named, because "a wrong plan is worse than a conservative default": these are
# the guard rails on numbers that come from a measurement taken on someone
# else's box, and every one of them reports itself when it binds.
MIN_REPLICAS = 1
MAX_REPLICAS = 32              # beyond this a single box is not the unit anymore
MIN_TORCH_THREADS = 1
MAX_TORCH_THREADS = 8          # past this the GIL-bound model stops gaining
MIN_QUEUE_MAX = 8
MAX_QUEUE_MAX = 256
QUEUE_PER_REPLICA = 4          # service.certify's own formula: ~4x cap waiting

# Per-replica memory, taken from the shipped chart's measured c8g.2xlarge
# preset (requests 3Gi / limits 4Gi at 2 threads).
MEMORY_REQUEST_GI = 3
MEMORY_LIMIT_HEADROOM_GI = 1
MIN_MEMORY_REQUEST_GI = 2      # below this the model does not load at all
HOST_RESERVED_MEMORY_GB = 1.0  # kernel, docker, the launcher itself

# Autoscaling envelope around the measured replica count.
CPU_TARGET_PERCENT = 70
KEDA_QUEUED_TARGET = 4
AUTOSCALE_MIN_FRACTION = 2     # minReplicas = replicas / this
AUTOSCALE_MAX_MULTIPLE = 3     # maxReplicas = replicas * this
AUTOSCALE_MIN_REPLICAS_FOR_HPA = 2   # a 1-replica box scales by resizing, not HPA

# Below this the roles share every replica: splitting a 3-replica box into
# three single-replica roles spends the whole box on isolation.
ROLE_SPLIT_MIN_REPLICAS = 4
CONVERSE_REPLICA_FRACTION = 4  # 1 converse replica per this many total
INGEST_REPLICAS = 1            # replica-affine BY DESIGN -- see deploy/README.md

DEFAULT_PORT = 8080
DEFAULT_IMAGE = "gravitone:latest"

# --- named refusal reasons --------------------------------------------------
REFUSE_MALFORMED = "malformed-certificate"
REFUSE_UNSUPPORTED_VERSION = "unsupported-certificate-version"
REFUSE_FAILED_VERDICT = "failing-certificate"
REFUSE_UNMEASURED = "unmeasured-certificate"
REFUSE_PREDICTED_ONLY = "predicted-only-certificate"
REFUSE_INTEGRITY = "certificate-integrity"

EMITTERS = ("plan", "helm-values", "compose")
DEFAULT_OUT = {
    "plan": "deployment-plan.json",
    "helm-values": "gravitone-values.yaml",
    "compose": "docker-compose.yml",
}


class PlanRefused(Exception):
    """This certificate cannot substantiate a topology. Carries a named
    ``reason`` so the exit is diagnosable without reading the message."""

    def __init__(self, reason: str, detail: str) -> None:
        super().__init__(f"{reason}: {detail}")
        self.reason = reason
        self.detail = detail


# ---------------------------------------------------------------------------
# Admission: what a certificate must be before it may become a topology
# ---------------------------------------------------------------------------
def admit(cert: dict, verify_secret: str = "", verify: bool = False) -> None:
    """Raise ``PlanRefused`` unless this certificate may be planned from."""
    if not isinstance(cert, dict) or not cert.get("version"):
        raise PlanRefused(REFUSE_MALFORMED,
                          "not a Gravitone certificate (no version field) -- "
                          "run 'python -m service.certify' to produce one")
    version = cert["version"]
    if version not in certify.SUPPORTED_CERT_VERSIONS:
        raise PlanRefused(
            REFUSE_UNSUPPORTED_VERSION,
            f"{version} is not one of {', '.join(certify.SUPPORTED_CERT_VERSIONS)}. "
            f"v1 certificates were issued before the harness could tell a "
            f"synthesis from a cache hit -- re-run the load test and re-certify")
    if verify and not certify.verify_certificate(cert, verify_secret):
        raise PlanRefused(REFUSE_INTEGRITY,
                          "the certificate's hash/HMAC does not check out -- it "
                          "has been edited since it was issued")

    verdict = cert.get("verdict")
    if verdict != "certified":
        failed = [c.get("check") for c in cert.get("checks") or []
                  if not c.get("pass")]
        raise PlanRefused(
            REFUSE_FAILED_VERDICT,
            f"verdict={verdict!r}"
            + (f" (failed: {', '.join(str(f) for f in failed)})" if failed else "")
            + " -- a topology compiled from a failing box would carry the "
              "authority of a measurement without one behind it")

    slo = cert.get("slo") or {}
    if slo.get("declared") and slo.get("predicted"):
        raise PlanRefused(
            REFUSE_PREDICTED_ONLY,
            "the certificate's rate is PREDICTED (fitted/extrapolated), not "
            "measured -- service.certify refuses to sign it and this refuses to "
            "size from it: re-run the open-loop load test without extrapolation")

    measurement = cert.get("measurement") or {}
    if measurement and not measurement.get("measures_synthesis", True):
        raise PlanRefused(
            REFUSE_UNMEASURED,
            "; ".join(measurement.get("reasons") or ["the run did not measure synthesis"]))

    cap = (cert.get("capacity") or {}).get("recommended_cap")
    if not isinstance(cap, int) or cap < 1:
        raise PlanRefused(REFUSE_UNMEASURED,
                          "no healthy concurrency cap in capacity.recommended_cap")


# ---------------------------------------------------------------------------
# Pure sizing helpers
# ---------------------------------------------------------------------------
def _clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, value))


def hardware_fingerprint(hardware: dict) -> str:
    """A short, stable id for "this class of box" -- so a plan can be told
    apart from one generated on different silicon without carrying the whole
    hardware block around."""
    payload = json.dumps(hardware or {}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


def sizing_basis(cert: dict) -> dict:
    """Which measurement this plan sizes from, and the replica count it wants
    BEFORE any floor or ceiling is applied.

    A v3 capacity contract wins when present: it is an open-loop measurement of
    arrivals that actually happened at a latency SLO. Little's law turns that
    promise into concurrency -- ``in-flight = rate x latency`` -- and we use the
    SLO's p95 as the latency term, which overestimates service time and so errs
    toward MORE replicas rather than a fleet that misses its own SLO.

    Otherwise: the v2 closed-loop concurrency ramp's recommended cap, which is
    already a count of simultaneous streams the box served cleanly.
    """
    contract = cert.get("capacity_contract") or {}
    rate = contract.get("max_rate_rps")
    p95 = (contract.get("slo") or {}).get("p95_s")
    cap = int((cert.get("capacity") or {}).get("recommended_cap") or 1)
    if isinstance(rate, (int, float)) and rate > 0 and isinstance(p95, (int, float)) and p95 > 0:
        wanted = int(math.ceil(rate * p95))
        return {
            "basis": "capacity_contract",
            "wanted_replicas": max(wanted, MIN_REPLICAS),
            "explanation": (
                f"Little's law on the measured contract: {rate} req/s x the "
                f"{p95}s p95 SLO = {wanted} requests in flight, one replica each. "
                f"p95 is an upper bound on service time, so this errs toward "
                f"spare capacity."),
            "concurrent_users": contract.get("concurrent_users"),
            "max_rate_rps": rate,
        }
    return {
        "basis": "concurrency_cap",
        "wanted_replicas": max(cap, MIN_REPLICAS),
        "explanation": (
            f"closed-loop concurrency ramp: {cap} simultaneous streams served "
            f"with zero errors. This certificate declares no arrival rate, so "
            f"the plan promises none either."),
        "concurrent_users": None,
        "max_rate_rps": None,
    }


def autoscaling_for(replicas: int, topology: dict) -> dict:
    """Pick the autoscaling metric the measured topology can actually serve.

    THE CAVEAT THAT DECIDES THIS: under ``SO_REUSEPORT`` (the shipped Linux
    topology) the replicas share one port and are not individually addressable,
    so ``/metrics`` is explicitly ``single_replica_sample`` with ``totals:
    null`` -- see ``service/replicas.py``. KEDA's metrics-api scaler reads
    ``metrics.queued`` from that endpoint, so on a SO_REUSEPORT fleet it would
    scale the whole deployment off one arbitrary replica's queue depth. That is
    not a tuning wart; it is scaling on a number that does not mean what the
    scaler thinks it means. So queue-depth scaling is emitted ONLY for
    sequential-port topologies (``pool_aggregate_available``), and CPU
    utilization -- which the kubelet measures per pod, independent of our
    counters -- everywhere else.
    """
    if replicas < AUTOSCALE_MIN_REPLICAS_FOR_HPA:
        return {"mode": "off", "target": None,
                "why": (f"{replicas} replica: below the {AUTOSCALE_MIN_REPLICAS_FOR_HPA}-replica "
                        f"floor for autoscaling -- this box scales by resizing, not by count")}
    if topology.get("pool_aggregate_available"):
        return {"mode": "keda", "target": KEDA_QUEUED_TARGET,
                "why": ("sequential-port topology: every replica is individually "
                        "addressable, so aggregated /metrics is a real pool total "
                        "and queue depth (the pre-429 signal) is scalable-on")}
    scope = topology.get("server_metrics_scope") or "unknown"
    return {"mode": "cpu", "target": CPU_TARGET_PERCENT,
            "why": (f"server_metrics_scope={scope}: the replicas are not "
                    f"individually addressable (SO_REUSEPORT shares one port), so "
                    f"/metrics is a single-replica SAMPLE and KEDA on queue depth "
                    f"would scale the fleet off one arbitrary replica. Use CPU, or "
                    f"run the launcher with --no-reuse-port for a real pool total")}


def roles_for(replicas: int) -> dict:
    """Place the three roles the service actually has.

    ``ingest`` is replica-affine BY DESIGN -- jobs live in the creating
    process's memory (``JOBS`` in ``service/ingest_api.py``) and are only
    rehydrated from disk at startup, so a round-robined follow-up GET answers
    404 ``{"status": "expired"}``. The plan states that as a field
    (``affine: true``) rather than as a paragraph somebody may not read.

    Role-scoped IMAGES are the Dockerfile's existing build args, not a new
    build: ``MODELS_STAGE``, ``BAKE_STT_MODEL``, ``BAKE_PIPER_VOICES``. Note
    that the image's capability gate imports all four capability modules, so
    the roles differ in baked WEIGHTS (image size), not in installed code.
    """
    if replicas < ROLE_SPLIT_MIN_REPLICAS:
        synth = converse = ingest = replicas
        colocated = True
    else:
        ingest = INGEST_REPLICAS
        converse = max(1, replicas // CONVERSE_REPLICA_FRACTION)
        synth = max(1, replicas - ingest - converse)
        colocated = False
    return {
        "colocated": colocated,
        "colocated_why": (
            f"below {ROLE_SPLIT_MIN_REPLICAS} replicas every role shares every "
            f"replica: splitting this box would spend all of it on isolation"
            if colocated else
            f"{replicas} replicas split into dedicated role pools"),
        "synth": {
            "replicas": synth,
            "affine": False,
            "endpoints": ["/v1/text-to-speech", "/v1/speak", "/v1/performance"],
            "why": "stateless: scales across replicas freely",
            "image_build_args": {"BAKE_STT_MODEL": "tiny", "BAKE_PIPER_VOICES": ""},
            "image_note": ("smallest sealed image for a pure-TTS pool. No build arg "
                           "drops whisper/sherpa entirely -- the capability gate "
                           "imports them -- so tiny is the floor, and an empty "
                           "Piper set means English/French only"),
        },
        "converse": {
            "replicas": converse,
            "affine": False,
            "endpoints": ["/v1/convai", "/v1/speech-to-text"],
            "why": ("needs STT + VAD + TTS co-resident and holds a latency budget: "
                    "never split the turn across pods"),
            "image_build_args": {"MODELS_STAGE": "bake"},
            "image_note": "the full sealed image: every capability in one layer",
        },
        "ingest": {
            "replicas": ingest,
            "affine": True,
            "endpoints": ["/v1/ingest"],
            "why": ("REPLICA-AFFINE: jobs live in the creating process's memory and "
                    "are rehydrated only at startup, so a round-robined GET "
                    "/v1/ingest/{job} hits a replica that never heard of it and "
                    "answers 404 expired. Run one replica, or sticky sessions"),
            "image_build_args": {"MODELS_STAGE": "bake"},
            "image_note": "the full sealed image: cloning needs the whole pipeline",
        },
    }


# ---------------------------------------------------------------------------
# The plan
# ---------------------------------------------------------------------------
def build_plan(cert: dict, verify_secret: str = "", verify: bool = False) -> dict:
    """Compile a certificate into a deployment topology. Raises
    ``PlanRefused`` for anything this certificate cannot substantiate."""
    admit(cert, verify_secret=verify_secret, verify=verify)

    hardware = cert.get("hardware") or {}
    topology = cert.get("topology") or {}
    cores = int(hardware.get("cpu_count") or 1)
    memory_gb = hardware.get("memory_gb")

    basis = sizing_basis(cert)
    wanted = basis["wanted_replicas"]
    notes: list[str] = []

    replicas = wanted
    if replicas > cores:
        notes.append(
            f"CPU ceiling: {wanted} replicas wanted, {cores} cores available -- "
            f"capped at {cores} so every replica keeps at least "
            f"{MIN_TORCH_THREADS} thread")
        replicas = cores

    memory_capped = None
    if isinstance(memory_gb, (int, float)) and memory_gb > 0:
        usable = memory_gb - HOST_RESERVED_MEMORY_GB
        memory_capped = int(usable // MEMORY_REQUEST_GI)
        if memory_capped < replicas:
            notes.append(
                f"memory ceiling: {memory_gb} GB minus {HOST_RESERVED_MEMORY_GB} GB "
                f"reserved fits {max(memory_capped, 0)} replica(s) at the "
                f"{MEMORY_REQUEST_GI}Gi per-replica request, not {replicas}")
            replicas = max(memory_capped, MIN_REPLICAS)

    clamped = _clamp(replicas, MIN_REPLICAS, MAX_REPLICAS)
    if clamped != replicas:
        notes.append(f"replica floor/ceiling [{MIN_REPLICAS}, {MAX_REPLICAS}] "
                     f"bound: {replicas} -> {clamped}")
        replicas = clamped

    raw_threads = cores // replicas
    torch_threads = _clamp(raw_threads, MIN_TORCH_THREADS, MAX_TORCH_THREADS)
    if torch_threads != raw_threads:
        notes.append(f"thread floor/ceiling [{MIN_TORCH_THREADS}, "
                     f"{MAX_TORCH_THREADS}] bound: {raw_threads} -> {torch_threads} "
                     f"per replica")

    queue_max = _clamp(QUEUE_PER_REPLICA * replicas, MIN_QUEUE_MAX, MAX_QUEUE_MAX)

    memory_request = MEMORY_REQUEST_GI
    if isinstance(memory_gb, (int, float)) and memory_gb > 0:
        fits = int((memory_gb - HOST_RESERVED_MEMORY_GB) // replicas)
        if fits < MEMORY_REQUEST_GI:
            memory_request = max(fits, MIN_MEMORY_REQUEST_GI)
            notes.append(
                f"per-replica memory request lowered to {memory_request}Gi: this "
                f"box has {memory_gb} GB, below the {MEMORY_REQUEST_GI}Gi the "
                f"certified reference preset requests. Watch for OOM under load")

    autoscaling = autoscaling_for(replicas, topology)

    plan = {
        "plan_version": PLAN_VERSION,
        "replicas": replicas,
        "torch_threads": torch_threads,
        "queue_max": queue_max,
        "resources": {
            "cpu": str(torch_threads),
            "memory": f"{memory_request}Gi",
            "cpu_limit": str(torch_threads),
            "memory_limit": f"{memory_request + MEMORY_LIMIT_HEADROOM_GI}Gi",
        },
        "autoscaling": {
            "mode": autoscaling["mode"],
            "target": autoscaling["target"],
            "min_replicas": max(MIN_REPLICAS, replicas // AUTOSCALE_MIN_FRACTION),
            "max_replicas": min(MAX_REPLICAS, replicas * AUTOSCALE_MAX_MULTIPLE),
            "why": autoscaling["why"],
        },
        "roles": roles_for(replicas),
        "launcher": {
            "command": ["python", "-m", "service.replicas",
                        "--replicas", str(replicas), "--port", str(DEFAULT_PORT)],
            "single_container": replicas == 1,
            "why": ("one replica needs no supervisor: the container's own uvicorn "
                    "is the topology" if replicas == 1 else
                    "the supervisor pins per-replica threads, restarts on death and "
                    "shares the port via SO_REUSEPORT on Linux"),
        },
        "sizing": {
            "basis": basis["basis"],
            "explanation": basis["explanation"],
            "wanted_replicas": wanted,
            "cores": cores,
            "memory_gb": memory_gb,
            "concurrent_users": basis["concurrent_users"],
            "max_rate_rps": basis["max_rate_rps"],
        },
        "notes": notes,
        "provenance": {
            "cert_sha": cert.get("sha256"),
            "cert_version": cert.get("version"),
            "cert_issued": cert.get("issued"),
            "hw_fingerprint": hardware_fingerprint(hardware),
            "hardware": {
                "machine": hardware.get("machine"),
                "cpu_model": hardware.get("cpu_model") or hardware.get("processor"),
                "cpu_count": cores,
                "memory_gb": memory_gb,
            },
            "plan_version": PLAN_VERSION,
            "generator": "python -m service.plan",
        },
    }
    return plan


# ---------------------------------------------------------------------------
# Emitters -- one plan, three renderings
# ---------------------------------------------------------------------------
def _provenance_header(plan: dict, comment: str = "#") -> list[str]:
    p = plan["provenance"]
    hw = p["hardware"]
    return [
        f"{comment} GENERATED by {p['generator']} -- do not hand-edit.",
        f"{comment} Regenerate instead: every number below is derived from one",
        f"{comment} certificate, and an edited copy silently stops being a measurement.",
        f"{comment}",
        f"{comment}   certificate : {p['cert_version']} sha256={str(p['cert_sha'])[:16]}"
        f" issued={p['cert_issued']}",
        f"{comment}   box         : {hw['cpu_model'] or hw['machine']} "
        f"({hw['cpu_count']} cores, {hw['memory_gb'] or '?'} GB) "
        f"fingerprint={p['hw_fingerprint']}",
        f"{comment}   sizing      : {plan['sizing']['basis']} -- {plan['sizing']['explanation']}",
        f"{comment}   plan        : {p['plan_version']}",
    ]


def emit_helm_values(plan: dict) -> str:
    """A values OVERLAY for deploy/helm/gravitone -- `helm install -f` it on top
    of values.yaml. Only the measured keys are set; everything else (image,
    persistence, nodeSelector, service) stays the chart's business."""
    a = plan["autoscaling"]
    r = plan["resources"]
    roles = plan["roles"]
    lines = _provenance_header(plan)
    for note in plan["notes"]:
        lines.append(f"# NOTE {note}")
    lines += [
        "",
        f"replicaCount: {plan['replicas']}",
        "",
        "tts:",
        f"  torchThreads: {plan['torch_threads']}",
        f"  queueMax: {plan['queue_max']}",
        "",
        "# cpu request stays EQUAL to tts.torchThreads: the per-replica thread",
        "# budget and the per-pod CPU request are the same fact stated twice.",
        "resources:",
        "  requests:",
        f'    cpu: "{r["cpu"]}"',
        f"    memory: {r['memory']}",
        "  limits:",
        f'    cpu: "{r["cpu_limit"]}"',
        f"    memory: {r['memory_limit']}",
        "",
        "autoscaling:",
        f"  # {a['why']}",
        f'  mode: "{a["mode"]}"',
        f"  minReplicas: {a['min_replicas']}",
        f"  maxReplicas: {a['max_replicas']}",
        f"  cpuTargetPercent: {CPU_TARGET_PERCENT}",
        "  keda:",
        f'    queuedTarget: "{KEDA_QUEUED_TARGET}"',
        "    pollingInterval: 15",
    ]
    if a["mode"] != "keda":
        lines += [
            "  # The keda block above is inert at this mode and is kept only so a",
            "  # deliberate switch has values to switch to. Read autoscaling.why in",
            "  # deployment-plan.json before flipping it: queue depth is only a pool",
            "  # figure when the replicas have separate ports.",
        ]
    ingest = roles["ingest"]
    lines += [
        "",
        f"# ROLES ({roles['colocated_why']})",
        f"#   synth    x{roles['synth']['replicas']} -- {roles['synth']['why']}",
        f"#   converse x{roles['converse']['replicas']} -- {roles['converse']['why']}",
        f"#   ingest   x{ingest['replicas']} (affine) -- {ingest['why']}",
        "# The chart templates ONE deployment. To honour ingest affinity, install a",
        "# second release with replicaCount: 1 and autoscaling.mode: \"off\" and route",
        "# /v1/ingest to it (or use sticky sessions).",
    ]
    return "\n".join(lines) + "\n"


def emit_compose(plan: dict, image: str = DEFAULT_IMAGE,
                 port: int = DEFAULT_PORT) -> str:
    """A docker-compose file that runs exactly the planned topology on one box.

    Multi-replica plans run ``service.replicas`` INSIDE the container -- the
    supervisor already does per-replica thread pinning, restart-on-death and
    SO_REUSEPORT port sharing, so compose's own ``deploy.replicas`` (which would
    fight it for the published port) is not used.
    """
    lines = _provenance_header(plan)
    for note in plan["notes"]:
        lines.append(f"# NOTE {note}")
    lines += [
        "",
        "services:",
        "  gravitone:",
        f"    image: {image}",
        "    restart: always",
        "    environment:",
        "      # The scaling law: capacity comes from replicas, never from",
        "      # in-process workers (the model is GIL-bound). Do not raise this.",
        '      TTS_WORKERS: "1"',
        f'      TTS_TORCH_THREADS: "{plan["torch_threads"]}"',
        f'      OMP_NUM_THREADS: "{plan["torch_threads"]}"',
        f'      TTS_QUEUE_MAX: "{plan["queue_max"]}"',
        '      TTS_DRAIN_TIMEOUT_S: "20"',
        '      TTS_HOST: "0.0.0.0"',
        "    # The root API key lives outside this file. Uncomment once the env",
        "    # file exists -- compose FAILS on a missing env_file, so it is not",
        "    # emitted live: a generated artifact must not break `compose up` on a",
        "    # box that has not run the bootstrap.",
        "    # env_file:",
        "    #   - /etc/gravitone.env",
    ]
    if plan["launcher"]["single_container"]:
        lines.append(f"    # {plan['launcher']['why']}")
    else:
        lines += [
            f"    # {plan['launcher']['why']}",
            "    command: [" + ", ".join(f'"{c}"' for c in plan["launcher"]["command"]) + "]",
        ]
    lines += [
        "    ports:",
        f'      - "{port}:{port}"',
        "    volumes:",
        "      - gravitone-voices:/app/voices",
        "      # Ingest jobs are durable BY DESIGN: rehydrated on restart, which",
        "      # only works if the directory outlives the container.",
        "      - gravitone-ingest:/app/ingest_jobs",
        "    # Must exceed TTS_DRAIN_TIMEOUT_S (20s) or in-flight generations are",
        "    # SIGKILLed mid-drain. Docker's 10s default is too short.",
        "    stop_grace_period: 30s",
        "",
        "volumes:",
        "  gravitone-voices:",
        "  gravitone-ingest:",
    ]
    ingest = plan["roles"]["ingest"]
    if not plan["roles"]["colocated"]:
        lines += [
            "",
            "# ROLE SPLIT: this plan wants dedicated pools",
            f"#   synth x{plan['roles']['synth']['replicas']}, "
            f"converse x{plan['roles']['converse']['replicas']}, "
            f"ingest x{ingest['replicas']} (affine).",
            "# Compose runs ONE box, so the service above is the whole fleet. Split",
            "# the roles with the Helm chart or one compose service per role behind a",
            "# proxy that routes /v1/ingest to a single replica.",
        ]
    return "\n".join(lines) + "\n"


def render(plan: dict, emit: str) -> str:
    if emit == "plan":
        return json.dumps(plan, indent=2) + "\n"
    if emit == "helm-values":
        return emit_helm_values(plan)
    if emit == "compose":
        return emit_compose(plan)
    raise ValueError(f"unknown emitter {emit!r} (want one of {', '.join(EMITTERS)})")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _summarize(plan: dict) -> None:
    p = plan["provenance"]
    hw = p["hardware"]
    a = plan["autoscaling"]
    print("-" * 60)
    print("Gravitone deployment plan")
    print("-" * 60)
    print(f"Box: {hw['cpu_model'] or hw['machine']} ({hw['cpu_count']} cores, "
          f"{hw['memory_gb'] or '?'} GB)  [{p['hw_fingerprint']}]")
    print(f"Sizing basis: {plan['sizing']['basis']}")
    print(f"  {plan['sizing']['explanation']}")
    print(f"Topology: {plan['replicas']} replica(s) x "
          f"TTS_TORCH_THREADS={plan['torch_threads']}, "
          f"TTS_QUEUE_MAX={plan['queue_max']}")
    print(f"Resources/replica: cpu={plan['resources']['cpu']} "
          f"memory={plan['resources']['memory']} "
          f"(limit {plan['resources']['memory_limit']})")
    print(f"Autoscaling: {a['mode']}"
          + (f" @ {a['target']}" if a["target"] is not None else "")
          + f" [{a['min_replicas']}..{a['max_replicas']}]")
    print(f"  {a['why']}")
    roles = plan["roles"]
    print(f"Roles: synth x{roles['synth']['replicas']}, "
          f"converse x{roles['converse']['replicas']}, "
          f"ingest x{roles['ingest']['replicas']} (affine)")
    for note in plan["notes"]:
        print(f"  ! {note}")
    if not plan["launcher"]["single_container"]:
        print("Run it: " + " ".join(plan["launcher"]["command"]))


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(
        prog="python -m service.plan",
        description="Compile a hardware certificate into a deployment topology.")
    ap.add_argument("cert", nargs="?", default="certification.json",
                    help="certification.json from 'python -m service.certify'")
    ap.add_argument("--emit", choices=EMITTERS, default="plan",
                    help="what to render from the plan (default: plan)")
    ap.add_argument("--out", default=None,
                    help="output file (default: per --emit)")
    ap.add_argument("--verify", action="store_true",
                    help="verify the certificate's hash/HMAC before planning "
                         "(GRAVITONE_CERT_SECRET for the HMAC)")
    ap.add_argument("--quiet", action="store_true", help="write the file, say nothing")
    a = ap.parse_args(argv)

    try:
        cert = json.loads(Path(a.cert).read_text("utf-8"))
    except FileNotFoundError:
        print(f"{a.cert} not found -- run 'python -m service.certify' first")
        raise SystemExit(1)
    except ValueError as exc:
        print(f"{a.cert} is not JSON: {exc}")
        raise SystemExit(1)

    try:
        plan = build_plan(cert, verify_secret=certify.CERT_SECRET, verify=a.verify)
    except PlanRefused as refused:
        # Named reason on stderr, exit 2 -- service.certify's ergonomics: a
        # refusal is a RESULT, not a crash, and the caller can branch on it.
        print(f"REFUSED [{refused.reason}] {refused.detail}", file=sys.stderr)
        raise SystemExit(2)

    out = Path(a.out or DEFAULT_OUT[a.emit])
    out.write_text(render(plan, a.emit), "utf-8")
    if not a.quiet:
        if a.emit == "plan":
            _summarize(plan)
        print(f"wrote {out}")
        if a.emit == "plan":
            print("Deploy it: put it beside the unit as "
                  "/etc/gravitone/deployment-plan.json (or PLAN=<file>) and run "
                  "deploy/bootstrap.sh")
    raise SystemExit(0)


if __name__ == "__main__":
    main()
