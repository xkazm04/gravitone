#!/usr/bin/env bash
# On-box bootstrap: turn a fresh Arm64 Ubuntu instance into a running
# "Private ElevenLabs" — the Gravitone TTS service as a systemd-managed
# docker container on port 8080.
#
# Called by cloud-init / CloudFormation UserData (see deploy/README.md), or
# run it by hand on any Arm box:
#
#   export TTS_API_KEY=gvt_root_...   # optional; generated if unset
#   curl -sL https://raw.githubusercontent.com/xkazm04/gravitone/main/deploy/bootstrap.sh | sudo -E bash
#
# Idempotent: re-running rebuilds the image and restarts the service.
set -euo pipefail

REPO="${REPO:-https://github.com/xkazm04/gravitone.git}"
APP_DIR=/opt/gravitone
ENV_FILE=/etc/gravitone.env

echo "== Private ElevenLabs bootstrap (Arm64) =="
[ "$(uname -m)" = "aarch64" ] || { echo "!! this image is Arm64-only (got $(uname -m))"; exit 1; }

# --- packages ---------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q --no-install-recommends docker.io git curl >/dev/null
systemctl enable --now docker

# --- code -------------------------------------------------------------------
if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" pull -q; else git clone -q "$REPO" "$APP_DIR"; fi

# --- config: root API key + tuning from the measured scaling law -------------
if [ ! -f "$ENV_FILE" ]; then
  KEY="${TTS_API_KEY:-gvt_root_$(head -c24 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
  CORES="$(nproc)"
  THREADS=$(( CORES > 4 ? 4 : CORES ))
  {
    echo "TTS_API_KEY=$KEY"
    echo "TTS_WORKERS=1"                # scale by replica, not in-process workers
    echo "TTS_TORCH_THREADS=$THREADS"
    echo "OMP_NUM_THREADS=$THREADS"
    echo "TTS_QUEUE_MAX=32"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

# --- image ------------------------------------------------------------------
docker build -q -t gravitone "$APP_DIR"

# --- systemd service ----------------------------------------------------------
# Named volume: docker populates it from the image's /app/voices on first use,
# so built-in voices ship and cloned voices survive image rebuilds.
cat > /etc/systemd/system/gravitone.service <<'UNIT'
[Unit]
Description=Gravitone TTS (Private ElevenLabs)
After=docker.service
Requires=docker.service

[Service]
Restart=always
RestartSec=5
ExecStartPre=-/usr/bin/docker rm -f gravitone
ExecStart=/usr/bin/docker run --name gravitone --env-file /etc/gravitone.env \
  -p 8080:8080 -v gravitone-voices:/app/voices gravitone
ExecStop=/usr/bin/docker stop gravitone

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now gravitone

# --- report -----------------------------------------------------------------
echo "waiting for the model to load (first boot pulls weights, 1-3 min) ..."
for _ in $(seq 1 120); do
  curl -sf localhost:8080/health >/dev/null 2>&1 && break
  sleep 5
done

IP="$(curl -sf -m 3 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || hostname -I | awk '{print $1}')"
KEY="$(grep ^TTS_API_KEY= "$ENV_FILE" | cut -d= -f2-)"
cat <<DONE

============================================================
Your Private ElevenLabs is up.

  Base URL   : http://$IP:8080
  xi-api-key : $KEY

Point any ElevenLabs client at it:
  curl -X POST "http://$IP:8080/v1/text-to-speech/alba" \\
    -H "xi-api-key: $KEY" -H "Content-Type: application/json" \\
    -d '{"text":"My own voice cloud, on one Arm box."}' --output hello.wav

Manage keys/voices via the API or point the Gravitone studio at it
(gravitone-web: GRAVITONE_URL + GRAVITONE_API_KEY).
============================================================
DONE
