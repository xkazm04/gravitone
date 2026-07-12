# Gravitone Helm chart — the fleet tier

Runs the CPU-only TTS service as N single-worker replicas on Arm nodes,
encoding the measured scaling law from the benchmark study:

1. **Scale by replica, never by in-process workers.** The model is
   GIL-bound; `TTS_WORKERS` is pinned to 1 in the template. Capacity =
   replicas × per-replica throughput.
2. **Per-replica CPU pinning.** `resources.requests.cpu` should equal
   `tts.torchThreads` (default 2); replicas × threads ≈ node vCPU.
3. **Queue depth is the autoscaling signal.** The admission queue fills
   before any 429 is returned — `autoscaling.mode: keda` polls
   `metrics.queued` from the JSON `/metrics` endpoint via KEDA's
   metrics-api scaler (no Prometheus needed). `mode: cpu` gives a plain
   HPA fallback that works on any cluster.

## Install

```bash
# build + push the image from the repo Dockerfile (arm64), then:
helm install voice deploy/helm/gravitone \
  --set image.repository=YOUR_REGISTRY/gravitone \
  --set apiKey.value=gvt_root_$(openssl rand -hex 24) \
  --set nodeSelector."kubernetes\.io/arch"=arm64

# queue-driven autoscaling (requires KEDA: https://keda.sh):
helm upgrade voice deploy/helm/gravitone --reuse-values \
  --set autoscaling.mode=keda --set autoscaling.maxReplicas=12
```

## Sizing presets (from the measured benchmarks)

| Node | replicas × threads | ~capacity |
|---|---|---|
| c8g.2xlarge (8 vCPU Graviton4) | 4 × 2 | ~10.9 aud-s/s ≈ 650 audio-min/hour |
| c7g.xlarge (4 vCPU Graviton3) | 2 × 2 | ~4 aud-s/s |

Run `python -m service.loadtest --plan` (or the studio's /benchmarks
capacity planner) to size from your own measured knee.

## Voices across the fleet

Cloned voices are files. With `persistence.enabled=true` and a
ReadWriteMany storage class (EFS / Filestore), all replicas share one voice
store; without it, replicas serve built-in voices only and clones don't
survive restarts. Fine-grained embedding sync/replication is part of the
supported fleet tier roadmap.

## Fleet tier

The chart is free (MIT, like the repo). The **supported fleet tier** wraps
it with an SLA, upgrade path, hardware certification (see
`docs/SUPPORTED_HARDWARE.md` and `python -m service.certify`), and
multi-replica voice-embedding sync.
