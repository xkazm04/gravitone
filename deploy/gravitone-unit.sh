# shellcheck shell=bash
# The ONE definition of how Gravitone runs as a service on a box.
#
# Sourced, never executed: defining the unit in two places (deploy/bootstrap.sh
# for the connected install, scripts/airgap-install.sh for the USB-stick one)
# is how the two installs quietly diverge — and the parts most worth getting
# right are exactly the ones nobody re-derives by hand: the stop grace period
# that must exceed TTS_DRAIN_TIMEOUT_S, the named volumes that make cloned
# voices and durable ingest jobs survive an image rebuild, and the 0600 env file
# holding the root API key.
#
#   . "$(dirname "$0")/gravitone-unit.sh"     # or "$APP_DIR/deploy/..."
#   gravitone_write_env_file /etc/gravitone.env
#   gravitone_write_unit gravitone            # image tag
#   gravitone_start
#   gravitone_wait_healthy 8080
#
# Every function is idempotent and takes its inputs as arguments, so nothing
# here depends on which installer sourced it.

GRAVITONE_ENV_FILE_DEFAULT=/etc/gravitone.env
GRAVITONE_UNIT_PATH=/etc/systemd/system/gravitone.service

# Print the root API key of an existing env file (empty if there is none).
gravitone_existing_key() {
  local env_file="${1:-$GRAVITONE_ENV_FILE_DEFAULT}"
  [ -f "$env_file" ] || return 0
  grep '^TTS_API_KEY=' "$env_file" | cut -d= -f2- || true
}

# Write the env file if it does not exist. Never overwrites: re-running an
# installer must not rotate the key out from under every client already using it.
# TTS_API_KEY from the environment wins; otherwise one is generated.
gravitone_write_env_file() {
  local env_file="${1:-$GRAVITONE_ENV_FILE_DEFAULT}"
  if [ -f "$env_file" ]; then
    echo "-- keeping the existing $env_file (key unchanged)"
    return 0
  fi
  local key cores threads
  key="${TTS_API_KEY:-gvt_root_$(head -c24 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
  cores="$(nproc)"
  threads=$(( cores > 4 ? 4 : cores ))
  {
    echo "TTS_API_KEY=$key"
    echo "TTS_WORKERS=1"                # scale by replica, not in-process workers
    echo "TTS_TORCH_THREADS=$threads"
    echo "OMP_NUM_THREADS=$threads"
    echo "TTS_QUEUE_MAX=32"
  } > "$env_file"
  chmod 600 "$env_file"
}

# Write (and overwrite — this one IS derived from the installer's inputs) the
# systemd unit. $1 = image tag, $2 = env file, $3 = host port.
gravitone_write_unit() {
  local image="${1:-gravitone}"
  local env_file="${2:-$GRAVITONE_ENV_FILE_DEFAULT}"
  local port="${3:-8080}"
  # Named volumes: docker populates gravitone-voices from the image's
  # /app/voices on first use, so built-in voices ship and cloned voices survive
  # image rebuilds; ingest jobs are durable by design and need the same.
  #
  # -t 30 must exceed TTS_DRAIN_TIMEOUT_S (20s): docker's 10s default SIGKILLs
  # the service mid-drain, so in-flight generations die and a commit can be cut
  # between registering a voice and recording it in the job state.
  cat > "$GRAVITONE_UNIT_PATH" <<UNIT
[Unit]
Description=Gravitone TTS (Private ElevenLabs)
After=docker.service
Requires=docker.service

[Service]
Restart=always
RestartSec=5
ExecStartPre=-/usr/bin/docker rm -f gravitone
ExecStart=/usr/bin/docker run --name gravitone --env-file $env_file \\
  -p $port:8080 -v gravitone-voices:/app/voices \\
  -v gravitone-ingest:/app/ingest_jobs $image
ExecStop=/usr/bin/docker stop -t 30 gravitone
TimeoutStopSec=40

[Install]
WantedBy=multi-user.target
UNIT
}

gravitone_start() {
  systemctl daemon-reload
  systemctl enable --now gravitone
}

# Wait for /health. $1 = port, $2 = attempts (5s apart). Returns non-zero on
# timeout so a caller can say something more useful than nothing.
gravitone_wait_healthy() {
  local port="${1:-8080}" tries="${2:-120}" i
  for i in $(seq 1 "$tries"); do
    curl -sf "localhost:$port/health" >/dev/null 2>&1 && return 0
    sleep 5
  done
  return 1
}

# Ask the running box what it is (see service/appliance.py). Prints the seal
# line and any missing component. Never fatal: on an older image the route
# simply is not there yet.
gravitone_report_seal() {
  local port="${1:-8080}" key="${2:-}" body
  body="$(curl -sf -m 10 -H "xi-api-key: $key" "localhost:$port/v1/appliance" 2>/dev/null || true)"
  if [ -z "$body" ]; then
    echo "-- /v1/appliance did not answer (older image, or the route is not wired)"
    return 0
  fi
  python3 - "$body" <<'PY' 2>/dev/null || echo "$body"
import json, sys
m = json.loads(sys.argv[1])
print(f"-- appliance: {m.get('seal')} ({m.get('model_bytes', 0) / 2**20:.0f} MiB of models, "
      f"offline_enforced={m.get('offline_enforced')})")
for entry in m.get("missing") or []:
    print(f"   !! missing {entry['component']}: {entry['why']}")
    print(f"      fix: {entry['remedy']}")
caps = m.get("capabilities") or {}
print("   capabilities: " + ", ".join(k for k, v in sorted(caps.items()) if v) or "none")
PY
}
