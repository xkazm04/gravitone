---
name: Load Testing & Benchmarks
type: perfect/context
group: Performance & Deployment
category: test
opportunity: 6
last_proposed: 2026-07-13
cooldown_until: round+2 (round 5)
directions: ["[[benchmark-real-replicas]]", "[[streaming-ttfb]]", "[[comparable-benchmark-results]]", "[[honest-benchmark-accounting]]", "[[one-command-certification]]"]
---
## Current state (scouted 2026-07-13, round 3)
Async ramp harness (levels/semaphore), knee detection (p95 factor / any 429 / CPU ceiling), plaintext table + JSON + sizing advisor; benchmark_arm.sh (Arm torch wheel, bf16, warmup, config sweep, hand-rolled process scaling), benchmark_t4g.sh (2vCPU smoke), aws/run_benchmark.sh (SSM). certify.py consumes the JSON.
Rough: never drives replicas.py or scrapes aggregated metrics (hand-rolls its own scaling, arm:74-101); streaming route unbenchmarked (no TTFB); mp3/pcm never varied; pct() duplicated from engine; two RTF definitions; result JSON not versioned (no SHA/torch/fpmath/config); no in-harness warmup; sample counts differ per level; whole-host CPU conflates driver+server; 504s land in errors; single-voice corpus; p99 over n≤12 is noise; t4g.json consumed by nothing.
## Direction history
2026-07-13 (round 3) — proposed 5: real-replicas ✅ streaming-ttfb ✅ comparable-results ✅ honest-accounting ✅ one-command-certification ❌.
## Shipped
(none)
