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
curl -sL https://raw.githubusercontent.com/xkazm04/gravitone/main/deploy/bootstrap.sh | sudo -E bash
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
for it next to itself, in `./deploy/`, and in `/opt/gravitone/deploy/`).

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

## What the bootstrap sets up

- `TTS_API_KEY` enforced on every endpoint (see `service/auth.py`) — the
  printed root key, or scoped keys minted via `/v1/keys`.
- Tuning from the measured scaling law: `TTS_WORKERS=1`,
  `TTS_TORCH_THREADS=min(4, cores)`, bf16 via the image's oneDNN/ACL torch.
  For multi-replica fleets (full utilization of big boxes) see the
  production-fleet follow-up in `docs/harness/`.
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
