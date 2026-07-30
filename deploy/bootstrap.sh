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

# The env file, the systemd unit and the health wait live in ONE place, shared
# with scripts/airgap-install.sh — two hand-maintained copies of a unit whose
# stop grace period must exceed TTS_DRAIN_TIMEOUT_S is a divergence waiting to
# happen. Sourced after the clone above, which is what puts it on disk (this
# script is normally piped from curl and has no siblings of its own).
# shellcheck source=deploy/gravitone-unit.sh
. "$APP_DIR/deploy/gravitone-unit.sh"

# --- plan: the topology this box measured for itself -------------------------
# A deployment plan (python -m service.plan certification.json) turns the
# certificate's numbers into this install's replica count, thread budget and
# queue depth. It is strictly optional: with no plan the defaults below are the
# single-container ones this script has always used. PLAN=<file> overrides.
PLAN_FILE="$(gravitone_plan_path)"
REPLICAS=1
if [ -n "$PLAN_FILE" ]; then
  REPLICAS="$(gravitone_plan_field "$PLAN_FILE" replicas 1)"
  echo "-- deployment plan: $PLAN_FILE (replicas=$REPLICAS)"
else
  echo "-- no deployment plan found; using single-container defaults."
  echo "   Measure this box and compile one:"
  echo "     bash benchmark_arm.sh && python -m service.certify"
  echo "     python -m service.plan certification.json"
  echo "     sudo install -D -m644 deployment-plan.json /etc/gravitone/deployment-plan.json"
fi

# --- config: root API key + tuning from the measured scaling law -------------
gravitone_write_env_file "$ENV_FILE" "$PLAN_FILE"

# --- image ------------------------------------------------------------------
# The SEALED image bakes every weight at build time (Dockerfile `bake` stage),
# which is slower to build and needs no egress afterwards. For a fast build on
# a connected box that may download weights on first use, add:
#   BUILD_ARGS="--build-arg MODELS_STAGE=nobake --build-arg HF_HUB_OFFLINE=0"
# GET /v1/appliance always says which one this box got.
docker build -q ${BUILD_ARGS:-} -t gravitone "$APP_DIR"

# --- systemd service ----------------------------------------------------------
gravitone_write_unit gravitone "$ENV_FILE" 8080 "$REPLICAS"
gravitone_start

# --- report -----------------------------------------------------------------
echo "waiting for the service to come up (a sealed image loads from disk; an"
echo "unsealed one pulls weights on first boot, 1-3 min) ..."
gravitone_wait_healthy 8080 120 || echo "!! /health never answered — check: journalctl -u gravitone"

IP="$(curl -sf -m 3 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || hostname -I | awk '{print $1}')"
KEY="$(gravitone_existing_key "$ENV_FILE")"
gravitone_report_seal 8080 "$KEY"
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
(web/: GRAVITONE_URL + GRAVITONE_API_KEY).
============================================================
DONE
