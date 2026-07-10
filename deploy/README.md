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

## What the bootstrap sets up

- `TTS_API_KEY` enforced on every endpoint (see `service/auth.py`) — the
  printed root key, or scoped keys minted via `/v1/keys`.
- Tuning from the measured scaling law: `TTS_WORKERS=1`,
  `TTS_TORCH_THREADS=min(4, cores)`, bf16 via the image's oneDNN/ACL torch.
  For multi-replica fleets (full utilization of big boxes) see the
  production-fleet follow-up in `docs/harness/`.
- `docker volume gravitone-voices` — persisted voices; the service survives
  reboots via systemd `Restart=always`.

## Operating it

```bash
curl http://<ip>:8080/health                    # ready + live metrics
journalctl -u gravitone -f                      # service logs (on the box)
sudo systemctl restart gravitone                # restart
curl -sL .../bootstrap.sh | sudo -E bash        # upgrade to latest main
```
