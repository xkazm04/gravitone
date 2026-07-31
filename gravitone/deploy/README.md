# Deploy — your Private ElevenLabs in minutes

Three ways to get a running, key-protected, ElevenLabs-compatible TTS
endpoint on an Arm box. All of them end the same way: a base URL + an
`xi-api-key`, and any existing ElevenLabs client migrates with one env change.

Instance presets come from the measured benchmarks (`/benchmarks` in the
studio, or README "Measured performance"):

| Preset | Instance | Why |
|---|---|---|
| Demo | `t4g.small` | free-tier eligible, 1.33× realtime — personal use |
| Production | `c8g.2xlarge` | 4.26× realtime single stream, ~650 audio-min/hour |

## 1. One command (AWS CLI)

```bash
# uses profile "gravitone" (see aws/README.md); TYPE=c8g.2xlarge for production
deploy/aws-oneclick.sh up
# → prints Base URL + xi-api-key when /health answers (4-8 min first boot)
deploy/aws-oneclick.sh stop        # park it (~$0 compute, voices kept)
```

Needs `ec2:CreateSecurityGroup` + `ec2:AuthorizeSecurityGroupIngress` on top
of `aws/iam-policy.json`, or pass `SG=sg-...` to reuse an existing group.
Port 8080 is opened only to your current IP by default (`CIDR=` to override).

## 2. CloudFormation (the marketplace-shaped path)

```bash
aws cloudformation deploy \
  --template-file deploy/cloudformation.yaml \
  --stack-name gravitone \
  --parameter-overrides \
      ApiKey=gvt_root_$(openssl rand -hex 24) \
      AllowedCidr=$(curl -s https://checkip.amazonaws.com)/32 \
      InstanceType=t4g.small
aws cloudformation describe-stacks --stack-name gravitone \
  --query 'Stacks[0].Outputs'   # BaseUrl / HealthCheck / TryIt
```

This template is exactly what an AWS Marketplace / quick-launch listing
wraps: parameterized instance size, your key, your CIDR, latest Ubuntu Arm64
AMI resolved automatically. GCP (Axion) and Azure (Cobalt) equivalents reuse
`deploy/bootstrap.sh` unchanged — only the launch wrapper differs.

## 3. Any Arm box you already have

```bash
export TTS_API_KEY=gvt_root_...   # optional; generated if unset
curl -sL https://raw.githubusercontent.com/xkazm04/gravitone/main/gravitone/deploy/bootstrap.sh | sudo -E bash
```

Works on Graviton, Axion, Ampere, or an Arm devboard. Installs docker,
builds the Arm-tuned image, and registers a systemd service (`gravitone`)
with a named volume so cloned voices survive rebuilds.

## 4. Air-gapped (USB stick, no registry, no internet)

The image bakes every model weight at build time (Dockerfile `bake` stage), so
a disconnected box needs no egress at all — not even on first boot.

```bash
# on a connected Arm64 build box
docker build -t gravitone:1.0 .
scripts/airgap-install.sh save gravitone:1.0 gravitone-1.0.tar
#   -> gravitone-1.0.tar + .sha256 + gravitone-1.0.manifest.json

# carry all three across, then on the air-gapped box (root, Arm64):
./airgap-install.sh install gravitone-1.0.tar
```

`airgap-install.sh` and `bootstrap.sh` register the SAME systemd unit — both
source `deploy/gravitone-unit.sh`, which is the only place that unit exists.
Copy `gravitone-unit.sh` onto the stick beside the tarball (the installer looks
for it next to itself, in `./deploy/`, and in `/opt/gravitone/gravitone/deploy/`
— `bootstrap.sh` clones the repo to `/opt/gravitone`, and the application root
is the `gravitone/` directory inside it).

**Sealed vs slim.** The default build is sealed. For a fast build on a
connected box:

```bash
docker build --build-arg MODELS_STAGE=nobake --build-arg HF_HUB_OFFLINE=0 -t gravitone:slim .
BUILD_ARGS="--build-arg MODELS_STAGE=nobake --build-arg HF_HUB_OFFLINE=0" ./bootstrap.sh
```

A slim image downloads weights on first use exactly as the old image did. You
never have to guess which one a box got:

```bash
curl -s -H "xi-api-key: $KEY" localhost:8080/v1/appliance | python3 -m json.tool
```

`GET /v1/appliance` (service/appliance.py) reports `seal: sealed|unsealed`, every
baked model file with its sha256 and upstream provenance, the locales and
capabilities that follow, and — when unsealed — the NAME of each missing
component with the command that fetches it. Set `TTS_APPLIANCE_SECRET` (or
reuse `TTS_PACK_SECRET`) and the manifest is HMAC-signed, so the document that
shipped with the tarball can be diffed against the running box.

Which Piper locales are baked in is a build-time decision (image size grows with
each voice): `--build-arg BAKE_PIPER_VOICES="cs_CZ-jirka-medium pl_PL-darkman-medium"`.
Whisper size likewise: `--build-arg BAKE_STT_MODEL=base`.

> Model licences for redistribution INSIDE an image are still an open legal
> review (Piper is MIT; the Whisper/CTranslate2 and sherpa-onnx model releases
> need confirming). The manifest says so in band as `license_review`.

## 5. Measure → plan → deploy (the deployment compiler)

"What should I set for my box?" is not a question anyone should answer from a
README. Measure the box once, and it writes its own topology:

```bash
bash benchmark_arm.sh                     # ramp concurrency, find the knee
python -m service.certify                 # → certification.json (+ verdict)
python -m service.plan certification.json # → deployment-plan.json
```

`deployment-plan.json` carries `replicas`, `torch_threads`, `queue_max`,
per-replica `resources`, an `autoscaling` mode with the reason it was chosen,
the three `roles`, and `provenance` (certificate sha256 + hardware fingerprint)
so any artifact can be traced back to the measurement it came from.

**It refuses more than it emits.** A failing certificate, a cache-contaminated
run, a v1 certificate, or a v3 whose rate was *predicted* rather than measured
all exit `2` with a named reason and write nothing — a wrong plan is worse than
a conservative default, and `service.certify` already refuses to sign a curve
fit for the same reason. `--verify` additionally checks the certificate's
hash/HMAC before planning.

Render the same plan into whatever runs it:

```bash
python -m service.plan certification.json --emit helm-values  # → gravitone-values.yaml
python -m service.plan certification.json --emit compose      # → docker-compose.yml
```

On a box (bootstrap path), drop the plan where the unit looks for it:

```bash
sudo install -D -m644 deployment-plan.json /etc/gravitone/deployment-plan.json
sudo -E bash deploy/bootstrap.sh        # or PLAN=/path/to/plan.json sudo -E bash ...
```

`bootstrap.sh` then takes `TTS_TORCH_THREADS`/`TTS_QUEUE_MAX` from the plan and,
when `replicas > 1`, runs `python -m service.replicas --replicas N` inside the
container — the supervisor that does SO_REUSEPORT port sharing, per-replica
thread pinning and restart-on-death. **With no plan present nothing changes**:
one container, `TTS_TORCH_THREADS=min(4, cores)`, `TTS_QUEUE_MAX=32`, exactly as
before. A plan is an upgrade to a measured box, never a prerequisite, and the
`PLAN=` override exists so a first boot never has to probe.

### Which autoscaling metric, and why it is not always queue depth

The plan picks `autoscaling.mode` from the *measured topology*, not preference:

| Topology | Mode | Why |
|---|---|---|
| 1 replica | `off` | a single-replica box scales by resizing, not by count |
| SO_REUSEPORT (shared port) | `cpu` | aggregated `/metrics` is a `single_replica_sample` with `totals: null` — KEDA on `metrics.queued` would size the fleet from one arbitrary replica |
| sequential ports / k8s pods | `keda` | every replica is individually addressable, so queue depth (the pre-429 signal) is a real pool figure |

### Roles

The plan places three roles rather than one do-everything pod: `synth`
(stateless, scales freely), `converse` (needs STT+VAD+TTS co-resident and holds
a latency budget) and `ingest` — which is `affine: true` **as a field**, so the
404 footgun documented below is a machine-readable placement constraint instead
of a paragraph somebody may not read. Below 4 replicas the roles are colocated
and the plan says so (`roles.colocated`).

Role-scoped images are the Dockerfile's existing build args, not a new build:
each role carries `image_build_args` (`MODELS_STAGE`, `BAKE_STT_MODEL`,
`BAKE_PIPER_VOICES`). Note the image's capability gate imports all four
capability modules, so roles differ in baked **weights** (image size), not in
installed code.

## What the bootstrap sets up

- `TTS_API_KEY` enforced on every endpoint (see `service/auth.py`) — the
  printed root key, or scoped keys minted via `/v1/keys`.
- Tuning from the measured scaling law: `TTS_WORKERS=1`,
  `TTS_TORCH_THREADS=min(4, cores)`, bf16 via the image's oneDNN/ACL torch.
  These are the no-plan defaults; with a `deployment-plan.json` present the
  thread budget, queue depth and replica count come from the measurement
  instead (section 5) — that is how a big box stops being deliberately
  underused.
- `docker volume gravitone-voices` — persisted voices; the service survives
  reboots via systemd `Restart=always`.
- `docker volume gravitone-ingest` — ingest job workdirs + `state.json`.
  Required for durability: jobs are rehydrated on restart, which only works
  if the directory outlives the container.

## Shutdown budget

Three timeouts must stay ordered, longest last:

| Setting | Default | Where |
|---|---|---|
| `TTS_DRAIN_TIMEOUT_S` | 20s | how long `engine.stop()` waits for in-flight generations |
| `docker stop -t` / `terminationGracePeriodSeconds` | 30s / 45s | when the orchestrator SIGKILLs |
| `TTS_REQUEST_TIMEOUT_S` | 120s | the caller's own ceiling (independent) |

If the stop grace is shorter than the drain budget the process is killed
mid-drain — in-flight generations die and a clone commit can be cut between
registering a voice and recording it in the job state. `docker stop`'s 10s
default is too short; `bootstrap.sh` passes `-t 30`.

During the drain `/health` returns 503 `{"status": "draining"}` so a load
balancer stops sending new work; liveness is a TCP probe, so failing readiness
does not get the pod killed mid-drain.

## Ingest is replica-affine

Ingest jobs live in the creating process's memory (`JOBS` in
`service/ingest_api.py`) and are only rehydrated from disk at startup. A
multi-replica fleet behind `SO_REUSEPORT` (or a k8s Service) will round-robin
the follow-up `GET /v1/ingest/{job}` to a replica that has never heard of the
job and answer 404 `{"status": "expired"}`.

So: run the **voice-creation flow against a single replica** (sticky sessions,
a dedicated ingest pod, or `replicaCount: 1` while cloning). Synthesis
(`/v1/text-to-speech`, `/v1/speak`, `/v1/performance`) has no such constraint —
it is stateless and scales across replicas freely. The registry itself is safe
either way: `mutate_meta` takes a cross-process file lock, so concurrent clones
on different replicas cannot drop each other's voices.

## Operating it

```bash
curl http://<ip>:8080/health                    # ready + live metrics
journalctl -u gravitone -f                      # service logs (on the box)
sudo systemctl restart gravitone                # restart
curl -sL .../bootstrap.sh | sudo -E bash        # upgrade to latest main
```
