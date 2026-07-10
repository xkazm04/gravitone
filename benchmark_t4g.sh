#!/usr/bin/env bash
# Constrained benchmark for a small/burstable box (e.g. free-tier t4g.small,
# 2 vCPU / 2 GB). Single worker only (2 GB won't hold multi-worker), short run
# (burstable CPU credits), + a swapfile so pip/model-load can't OOM.
# For the full sweep + process-scaling use benchmark_arm.sh on a bigger box.
set -uo pipefail
cd "$(dirname "$0")"
mkdir -p logs results
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

# --- swap guard (2 GB RAM box) ---
if ! swapon --show 2>/dev/null | grep -q /swapfile; then
  echo ">> adding 2G swap"
  $SUDO fallocate -l 2G /swapfile && $SUDO chmod 600 /swapfile \
    && $SUDO mkswap /swapfile >/dev/null && $SUDO swapon /swapfile
fi

echo ">> installing deps ..."
$SUDO apt-get update -y >/dev/null
$SUDO apt-get install -y python3 python3-venv python3-pip ffmpeg curl psmisc >/dev/null
[ -d .venv ] || python3 -m venv .venv
# shellcheck disable=SC1091
source .venv/bin/activate
pip install -q -U pip
echo ">> installing python deps (Arm torch) ..."
pip install -q -r requirements.txt

export ONEDNN_DEFAULT_FPMATH_MODE="${ONEDNN_DEFAULT_FPMATH_MODE:-bf16}"
export TTS_HOST=127.0.0.1
VOICE="${VOICE:-alba}"
NPROC="$(nproc)"
echo "=========================================================="
echo " t4g smoke | cores=$NPROC | fpmath=$ONEDNN_DEFAULT_FPMATH_MODE | voice=$VOICE"
python -c "import torch;print(' torch',torch.__version__)"
echo "=========================================================="

wait_ready(){ for _ in $(seq 1 60); do [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/health 2>/dev/null)" = 200 ] && return 0; sleep 3; done; return 1; }
stop_port(){ fuser -k 8080/tcp >/dev/null 2>&1 || true; sleep 2; }

stop_port
TTS_WORKERS=1 TTS_TORCH_THREADS="$NPROC" TTS_PORT=8080 PYTHONUNBUFFERED=1 \
  python -m service.app >logs/svc.log 2>&1 &
wait_ready || { echo "!! service failed"; tail -30 logs/svc.log; exit 1; }
echo ">> warming model (downloads weights once) ..."
curl -s -X POST "http://127.0.0.1:8080/v1/text-to-speech/$VOICE?output_format=wav_24000" \
  -H 'Content-Type: application/json' -d '{"text":"warmup sentence."}' -o /dev/null
echo ">> load test (single worker, short) ..."
python -m service.loadtest --url http://127.0.0.1:8080 --voice "$VOICE" \
  --levels 1,2 --requests 4 --out results/t4g.json
stop_port
echo "T4G SMOKE COMPLETE"
