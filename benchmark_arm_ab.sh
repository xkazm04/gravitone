#!/usr/bin/env bash
# A/B the Arm inference-path settings, ONE knob at a time.
#
# Every setting added by the Arm pass is individually revertible from the
# environment (see service/config.py). This script turns them all OFF to get a
# baseline, then re-enables exactly one per run, and reports the realtime
# factor each one actually bought ON THIS BOX. No numbers are baked into the
# repo: whatever this prints is the only speedup claim anyone may make.
#
#   bash benchmark_arm_ab.sh
#
# Env overrides:
#   VOICE   (default alba)  — built-in voice = no HF token
#   REQS    (default 6)     — requests per variant
#   THREADS (default nproc) — torch intra-op threads for every variant
#   ONLY    (default all)   — space-separated subset of variant names
#
# It deliberately does NOT define its own measurement: it drives the existing
# harness (`python -m service.loadtest`, which service/certify.py consumes) at
# concurrency 1 and reads `server_rtf_mean` out of the result JSON. Requires
# the deps benchmark_arm.sh installs; run that first on a fresh box.
set -uo pipefail
cd "$(dirname "$0")"
mkdir -p logs results
[ -d .venv ] && { # shellcheck disable=SC1091
  source .venv/bin/activate; }

VOICE="${VOICE:-alba}"
REQS="${REQS:-6}"
THREADS="${THREADS:-$( (nproc 2>/dev/null) || echo 4 )}"
PORT=8080

# name : env assignments applied ON TOP of the all-off baseline.
# The baseline reverts EVERY knob to its pre-Arm-pass behaviour, so each row
# below isolates exactly one change. "shipped" is what the defaults actually do.
VARIANTS=(
  "baseline:"
  "inference_mode:TTS_INFERENCE_MODE=1"
  "flush_denormal:TTS_FLUSH_DENORMAL=1"
  "interop1:TTS_TORCH_INTEROP_THREADS=1"
  "fpmath_bf16:ONEDNN_DEFAULT_FPMATH_MODE=bf16"
  "quantize:TTS_QUANTIZE=1 TTS_QUANTIZED_ENGINE=auto"
  "shipped:TTS_INFERENCE_MODE=1 TTS_FLUSH_DENORMAL=1 TTS_TORCH_INTEROP_THREADS=1 ONEDNN_DEFAULT_FPMATH_MODE=bf16"
  # ffmpeg's thread cap only shows up when the response is actually encoded, so
  # this pair runs with mp3 output (see FORMAT_FOR below).
  "mp3_ffmpeg_uncapped:TTS_FFMPEG_THREADS=0"
  "mp3_ffmpeg_capped:TTS_FFMPEG_THREADS=1"
)

FORMAT_FOR() { case "$1" in mp3_*) echo "mp3_24000_128";; *) echo "wav_24000";; esac; }

wait_ready(){ for _ in $(seq 1 60); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health" 2>/dev/null)" = 200 ] && return 0
  sleep 3; done; return 1; }
stop_port(){ fuser -k "$PORT/tcp" >/dev/null 2>&1 || true; sleep 2; }

echo "=========================================================="
echo " gravitone Arm A/B | threads=$THREADS | voice=$VOICE | reqs=$REQS"
python -c "import torch,platform;print(' torch',torch.__version__,'|',platform.machine())" 2>/dev/null \
  || echo " !! torch not importable — this box cannot produce numbers"
echo "=========================================================="

run_variant(){
  local name="$1" extra="$2"
  local fmt; fmt="$(FORMAT_FOR "$name")"
  echo ">> variant $name  [$extra]  format=$fmt"
  stop_port
  # All-off baseline, then the variant's own assignments override it.
  env TTS_INFERENCE_MODE=0 TTS_FLUSH_DENORMAL=0 TTS_TORCH_INTEROP_THREADS=0 \
      TTS_QUANTIZE=0 TTS_FFMPEG_THREADS=0 ONEDNN_DEFAULT_FPMATH_MODE=any \
      TTS_WORKERS=1 TTS_TORCH_THREADS="$THREADS" TTS_PORT="$PORT" \
      TTS_HOST=127.0.0.1 PYTHONUNBUFFERED=1 \
      $extra \
      python -m service.app >"logs/ab_$name.log" 2>&1 &
  local pid=$!
  if ! wait_ready; then
    echo "   !! variant $name failed to start; see logs/ab_$name.log"
    tail -20 "logs/ab_$name.log"; stop_port; return 1
  fi
  # Record what the server says ACTUALLY took effect (set_flush_denormal can
  # refuse, interop can be too late, inference_mode can demote itself) so the
  # table never credits a setting the process didn't get.
  curl -s "http://127.0.0.1:$PORT/metrics" -o "results/ab_${name}_metrics.json"
  python -m service.loadtest --url "http://127.0.0.1:$PORT" --voice "$VOICE" \
    --format "$fmt" --server-pid "$pid" --levels 1 --requests "$REQS" \
    --out "results/ab_$name.json" >"logs/lt_ab_$name.log" 2>&1 \
    || echo "   !! loadtest failed for $name (see logs/lt_ab_$name.log)"
  stop_port
}

for entry in "${VARIANTS[@]}"; do
  name="${entry%%:*}"; extra="${entry#*:}"
  if [ -n "${ONLY:-}" ] && ! printf '%s\n' $ONLY | grep -qx "$name"; then continue; fi
  run_variant "$name" "$extra"
done

echo ""
echo "================= ARM A/B (this box) ====================="
python - <<'PY'
import json, os, glob

def load(p):
    try:
        with open(p) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None

rows, base = [], None
order = [os.path.basename(p)[3:-5] for p in sorted(glob.glob("results/ab_*.json"))
         if not p.endswith("_metrics.json")]
for name in order:
    d = load(f"results/ab_{name}.json")
    if not d or not d.get("levels"):
        rows.append((name, None, None, None, "no result")); continue
    lvl = d["levels"][0]
    rtf = lvl.get("server_rtf_mean")
    m = load(f"results/ab_{name}_metrics.json") or {}
    tuning = (m.get("config") or {}).get("tuning") or {}
    applied = ",".join(f"{k}={v}" for k, v in tuning.items()
                       if k in ("inference_mode", "flush_denormal",
                                "torch_interop_threads", "quantized_engine"))
    if name == "baseline":
        base = rtf
    rows.append((name, rtf, lvl.get("lat_p95_s"), lvl.get("errors"), applied))

print(f"{'variant':>20} {'srtf':>7} {'vs base':>8} {'p95_s':>8}  applied")
for name, rtf, p95, err, applied in rows:
    delta = "-"
    if base and rtf:
        delta = f"{(rtf/base - 1) * 100:+.1f}%"
    print(f"{name:>20} {str(rtf):>7} {delta:>8} {str(p95):>8}  {applied}")
print()
print("srtf = server-reported realtime factor at concurrency 1 (higher is better).")
print("A row with no result means that variant could not run on this box — say so")
print("rather than quoting a number from another one.")
PY
echo "=========================================================="
echo "raw JSON in results/ab_*.json , logs in logs/ . A/B COMPLETE"
