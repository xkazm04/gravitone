#!/usr/bin/env bash
# Gravitone benchmark — one command to characterize this Arm64 box.
# Runs on a fresh Graviton (Ubuntu/Debian arm64): installs deps, warms the
# model, sweeps in-process (workers x threads) configs, then benchmarks the
# shipped replica topology via `python -m service.replicas`, and prints a
# consolidated summary.
#
#   bash benchmark_arm.sh
#
# Env overrides:
#   ONEDNN_DEFAULT_FPMATH_MODE  (default bf16)  — Neoverse BF16 fast-math
#   VOICE                       (default alba)  — built-in voice = NO HF token
#   REQS                        (default 8)     — requests per level
set -uo pipefail
cd "$(dirname "$0")"
mkdir -p logs results
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

# ---------- 1. setup ----------
echo ">> installing system deps ..."
$SUDO apt-get update -y >/dev/null
$SUDO apt-get install -y python3 python3-venv python3-pip ffmpeg curl psmisc >/dev/null
[ -d .venv ] || python3 -m venv .venv
# shellcheck disable=SC1091
source .venv/bin/activate
pip install -q -U pip
# IMPORTANT: on aarch64, plain PyPI torch is a CUDA (GH200) build that bypasses
# the oneDNN + Arm Compute Library CPU path. Install the CPU wheel explicitly
# FIRST so pocket-tts sees torch already satisfied and we get ACL/KleidiAI.
echo ">> installing CPU-optimized Arm torch (oneDNN+ACL) from the CPU index ..."
pip install -q torch --index-url https://download.pytorch.org/whl/cpu
echo ">> installing remaining deps ..."
pip install -q -r requirements.txt

# ---------- 2. env / sizing ----------
export ONEDNN_DEFAULT_FPMATH_MODE="${ONEDNN_DEFAULT_FPMATH_MODE:-bf16}"
export TTS_HOST=127.0.0.1
VOICE="${VOICE:-alba}"           # built-in voice → tokenless
REQS="${REQS:-8}"
NPROC="$(nproc)"
HALF=$(( NPROC/2 )); [ "$HALF" -lt 1 ] && HALF=1
echo "=========================================================="
echo " gravitone benchmark | cores=$NPROC | fpmath=$ONEDNN_DEFAULT_FPMATH_MODE | voice=$VOICE"
python -c "import torch;print(' torch',torch.__version__,'| default threads',torch.get_num_threads())"
echo "=========================================================="

wait_ready(){ for _ in $(seq 1 60); do [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$1/health" 2>/dev/null)" = 200 ] && return 0; sleep 3; done; return 1; }
stop_port(){ fuser -k "$1/tcp" >/dev/null 2>&1 || true; sleep 2; }

# ---------- 3. warm model (one-time download) ----------
echo ">> warming model (first run downloads weights) ..."
stop_port 8080
TTS_WORKERS=1 TTS_TORCH_THREADS="$NPROC" TTS_PORT=8080 python -m service.app >logs/warm.log 2>&1 &
wait_ready 8080 || { echo "!! warmup failed"; tail -30 logs/warm.log; exit 1; }
curl -s -X POST "http://127.0.0.1:8080/v1/text-to-speech/$VOICE?output_format=wav_24000" \
  -H 'Content-Type: application/json' -d '{"text":"warmup sentence."}' -o /dev/null
stop_port 8080

# ---------- 4. in-process sweep ----------
run_cfg(){ # name workers threads levels
  local name="$1" w="$2" t="$3" levels="$4"
  echo ">> in-process cfg $name : workers=$w threads=$t"
  stop_port 8080
  TTS_WORKERS="$w" TTS_TORCH_THREADS="$t" TTS_PORT=8080 PYTHONUNBUFFERED=1 \
    python -m service.app >"logs/svc_$name.log" 2>&1 &
  local svc_pid=$!
  wait_ready 8080 || { echo "!! cfg $name failed"; tail -20 "logs/svc_$name.log"; return 1; }
  # --server-pid = the app we just launched: its process-tree CPU is measured
  # apart from the co-located load generator (honest server_cpu_* vs driver_cpu_*).
  python -m service.loadtest --url http://127.0.0.1:8080 --voice "$VOICE" \
    --server-pid "$svc_pid" \
    --levels "$levels" --requests "$REQS" --out "results/inproc_$name.json" | tee "logs/lt_$name.log"
  stop_port 8080
}
run_cfg "1xAll"  1        "$NPROC" "1,2,3"
run_cfg "2xHalf" 2        "$HALF"  "1,2,4"
run_cfg "NxT2"   "$HALF"  2        "1,2,4,$NPROC"

# ---------- 5. shipped topology: the real replica launcher ----------
# Benchmark the SAME process the sizing advisor recommends: `service.replicas`.
# loadtest --replicas starts/stops the launcher itself, polls /health for
# readiness, and scrapes the aggregated metrics side port per level. This
# replaces the old hand-rolled `service.app`-on-ports-8080+i scaling that was
# never the thing we actually ship.
echo ">> replica sweep: python -m service.replicas (the real launcher) at 1,2,4 replicas"
stop_port 8080
for R in 1 2 4; do
  [ "$R" -gt "$NPROC" ] && { echo "   skip R=$R (> $NPROC cores)"; continue; }
  echo ">> replicas=$R"
  python -m service.loadtest --replicas "$R" --port 8080 --voice "$VOICE" \
    --levels "1,2,4" --requests "$REQS" --out "results/replicas_$R.json" \
    | tee "logs/lt_replicas_$R.log"
done
python - <<'PY'
import json,glob
print("  replica-topology throughput (aud/s at top level):")
for f in sorted(glob.glob("results/replicas_*.json")):
    d=json.load(open(f)); r=(d.get("topology") or {}).get("replicas")
    l=d["levels"][-1]; a=l["audio_s_per_wall_s"]
    print(f"    replicas={r}  conc={l['concurrency']}  aud/s={a}  p95_s={l['lat_p95_s']}")
PY

# ---------- 6. summary ----------
echo ""
echo "================= SUMMARY (this box) ====================="
python - <<'PY'
import json,glob
print(f"{'config':>10} {'conc':>4} {'aud/s':>7} {'p95_s':>8} {'srtf':>6} {'cpu%':>6}")
for f in sorted(glob.glob("results/inproc_*.json")):
    d=json.load(open(f)); name=f.split('inproc_')[1].split('.json')[0]
    for l in d["levels"]:
        print(f"{name:>10} {l['concurrency']:>4} {str(l['audio_s_per_wall_s']):>7} "
              f"{str(l['lat_p95_s']):>8} {str(l['server_rtf_mean']):>6} {str(l['cpu_mean_pct']):>6}")
PY
echo "========================================================="
echo "raw JSON in results/ , logs in logs/ . BENCHMARK COMPLETE"
