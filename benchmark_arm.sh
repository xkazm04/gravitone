#!/usr/bin/env bash
# Gravitone benchmark — one command to characterize this Arm64 box.
# Runs on a fresh Graviton (Ubuntu/Debian arm64): installs deps, warms the
# model, sweeps in-process (workers x threads) configs, then runs the
# process-scaling test, and prints a consolidated summary.
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
$SUDO apt-get install -y python3 python3-venv python3-pip ffmpeg curl >/dev/null
[ -d .venv ] || python3 -m venv .venv
# shellcheck disable=SC1091
source .venv/bin/activate
pip install -q -U pip
echo ">> installing python deps (pulls Arm-optimized torch) ..."
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
  wait_ready 8080 || { echo "!! cfg $name failed"; tail -20 "logs/svc_$name.log"; return 1; }
  python -m service.loadtest --url http://127.0.0.1:8080 --voice "$VOICE" \
    --levels "$levels" --requests "$REQS" --out "results/inproc_$name.json" | tee "logs/lt_$name.log"
  stop_port 8080
}
run_cfg "1xAll"  1        "$NPROC" "1,2,3"
run_cfg "2xHalf" 2        "$HALF"  "1,2,4"
run_cfg "NxT2"   "$HALF"  2        "1,2,4,$NPROC"

# ---------- 5. process-scaling ----------
echo ">> process-scaling: $HALF single-worker procs x 2 threads (separate GILs)"
for i in $(seq 0 $((HALF-1))); do
  port=$((8080+i)); stop_port "$port"
  TTS_WORKERS=1 TTS_TORCH_THREADS=2 TTS_PORT="$port" PYTHONUNBUFFERED=1 \
    python -m service.app >"logs/proc_$port.log" 2>&1 &
done
for i in $(seq 0 $((HALF-1))); do wait_ready $((8080+i)) || echo "!! proc $((8080+i)) not ready"; done
for i in $(seq 0 $((HALF-1))); do
  port=$((8080+i))
  python -m service.loadtest --url "http://127.0.0.1:$port" --voice "$VOICE" \
    --levels 2 --requests 10 --out "results/proc_$port.json" >"logs/lt_proc_$port.log" 2>&1 &
done
wait
python - <<'PY'
import json,glob
tot=0; rows=[]
for f in sorted(glob.glob("results/proc_80*.json")):
    l=json.load(open(f))["levels"][0]; a=l["audio_s_per_wall_s"] or 0; tot+=a
    rows.append((f.split('/')[-1], a, l["cpu_mean_pct"]))
for name,a,c in rows: print(f"  {name:>22}  aud/s={a:<6} cpu%={c}")
print(f"  AGGREGATE process-scaling throughput: {round(tot,3)} audio-sec/sec")
PY
for i in $(seq 0 $((HALF-1))); do stop_port $((8080+i)); done

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
