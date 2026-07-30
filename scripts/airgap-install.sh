#!/usr/bin/env bash
# Install Gravitone from a USB stick. No registry, no internet, no git clone.
#
# The disconnected delivery form of the sealed appliance: one `docker save`
# tarball plus this script. It loads the image, registers THE SAME systemd unit
# deploy/bootstrap.sh writes (both source deploy/gravitone-unit.sh — the unit
# text exists once), starts it, and then asks the running box what it is via
# GET /v1/appliance, so the last line of an air-gapped install is either
# "sealed" or a named list of what is missing.
#
# ON THE CONNECTED BUILD BOX (Arm64):
#   docker build -t gravitone:1.0 .
#   scripts/airgap-install.sh save gravitone:1.0 gravitone-1.0.tar
#     -> gravitone-1.0.tar + gravitone-1.0.tar.sha256 + gravitone-1.0.manifest.json
#
# ON THE AIR-GAPPED BOX (Arm64, as root):
#   ./airgap-install.sh install gravitone-1.0.tar
#
# Windows/Git-Bash note (repo convention, see deploy/aws-oneclick.sh): MSYS
# rewrites anything that looks like a Unix path in a docker argument, which
# mangles image refs and -v mounts. The `save` half may legitimately be run
# from Git Bash on a Windows build box, so it exports the same escape hatch.
# The `install` half is Linux-only by construction (systemd).
set -euo pipefail

export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

ENV_FILE="${ENV_FILE:-/etc/gravitone.env}"
PORT="${PORT:-8080}"
IMAGE_TAG="${IMAGE_TAG:-gravitone}"

usage() {
  cat <<'USAGE'
usage:
  airgap-install.sh save <image[:tag]> [out.tar]   # on the connected build box
  airgap-install.sh install <in.tar> [image[:tag]] # on the air-gapped box (root)
  airgap-install.sh verify <in.tar>                # check the tarball's sha256

env: ENV_FILE=/etc/gravitone.env  PORT=8080  TTS_API_KEY=<key to install>
     NO_START=1   load + write the unit, do not start it
USAGE
}

# deploy/gravitone-unit.sh sits next to this script's repo checkout; on the
# target box it may instead have travelled in /opt/gravitone. Look in both
# rather than duplicating the unit here, which is the whole point.
locate_lib() {
  local here candidate
  here="$(cd "$(dirname "$0")" && pwd)"
  for candidate in "$here/../deploy/gravitone-unit.sh" \
                   "$here/deploy/gravitone-unit.sh" \
                   "$here/gravitone-unit.sh" \
                   "/opt/gravitone/deploy/gravitone-unit.sh"; do
    if [ -f "$candidate" ]; then echo "$candidate"; return 0; fi
  done
  echo "!! cannot find deploy/gravitone-unit.sh (the shared systemd unit)." >&2
  echo "   Copy it onto this box beside the tarball and re-run." >&2
  return 1
}

# --- save (connected box) ----------------------------------------------------
do_save() {
  local image="${1:?image ref required}"
  local out="${2:-gravitone-airgap.tar}"
  command -v docker >/dev/null || { echo "!! docker not found"; exit 1; }

  echo "== saving $image -> $out"
  docker save "$image" -o "$out"
  # A tarball crossing an air gap on removable media has no TLS behind it, so
  # it carries its own checksum. The IMAGE's integrity is separately provable
  # from the manifest below (per-file sha256 of every baked weight).
  sha256sum "$out" > "$out.sha256"

  # Extract the appliance manifest from the image itself, so the operator on
  # the far side has something to diff the running box against BEFORE trusting
  # it. --network none: even generating the handover document must not need
  # egress, and if it did we would want to know.
  local manifest="${out%.tar}.manifest.json"
  if docker run --rm --network none "$image" \
       python -m service.appliance > "$manifest" 2>/dev/null; then
    echo "== manifest: $manifest"
  else
    echo "-- could not extract an appliance manifest from $image (older image?)"
    rm -f "$manifest"
  fi
  echo "== done: $out $out.sha256"
}

# --- verify ------------------------------------------------------------------
do_verify() {
  local tar="${1:?tarball required}"
  [ -f "$tar.sha256" ] || { echo "!! no $tar.sha256 beside the tarball"; exit 1; }
  ( cd "$(dirname "$tar")" && sha256sum -c "$(basename "$tar").sha256" )
}

# --- install (air-gapped box) ------------------------------------------------
do_install() {
  local tar="${1:?tarball required}"
  local image="${2:-$IMAGE_TAG}"
  [ -f "$tar" ] || { echo "!! no such tarball: $tar"; exit 1; }
  [ "$(id -u)" = "0" ] || { echo "!! run as root (writes $ENV_FILE and a systemd unit)"; exit 1; }
  [ "$(uname -m)" = "aarch64" ] || { echo "!! this image is Arm64-only (got $(uname -m))"; exit 1; }
  command -v docker >/dev/null || {
    echo "!! docker is not installed. An air-gapped box needs it pre-installed"
    echo "   (or the .deb packages on the same stick): this script deliberately"
    echo "   never reaches for a package mirror."; exit 1; }
  command -v systemctl >/dev/null || { echo "!! systemd is required"; exit 1; }

  if [ -f "$tar.sha256" ]; then
    echo "== verifying $tar"
    do_verify "$tar"
  else
    echo "-- no $tar.sha256 beside the tarball; skipping the integrity check"
  fi

  echo "== loading the image (this is the only step that touches the daemon)"
  docker load -i "$tar"
  docker image inspect "$image" >/dev/null 2>&1 || {
    echo "!! the tarball loaded but no image is tagged '$image'."
    echo "   Loaded tags:"; docker images --format '     {{.Repository}}:{{.Tag}}' | head -20
    echo "   Re-run: $0 install $tar <the-right-tag>"; exit 1; }

  local lib; lib="$(locate_lib)"
  # shellcheck source=deploy/gravitone-unit.sh
  . "$lib"

  gravitone_write_env_file "$ENV_FILE"
  gravitone_write_unit "$image" "$ENV_FILE" "$PORT"

  if [ -n "${NO_START:-}" ]; then
    echo "== unit written to $GRAVITONE_UNIT_PATH (NO_START set; not starting)"
    return 0
  fi
  gravitone_start

  echo "== waiting for /health on :$PORT"
  gravitone_wait_healthy "$PORT" 60 \
    || { echo "!! never became healthy — journalctl -u gravitone"; exit 1; }

  local key; key="$(gravitone_existing_key "$ENV_FILE")"
  gravitone_report_seal "$PORT" "$key"

  cat <<DONE

============================================================
Gravitone is installed from local media. Nothing was downloaded.

  Base URL   : http://$(hostname -I | awk '{print $1}'):$PORT
  xi-api-key : $key

Verify the box against the manifest that shipped with the tarball:
  curl -s -H "xi-api-key: $key" localhost:$PORT/v1/appliance > running.json
  diff <(python3 -m json.tool gravitone-*.manifest.json) \\
       <(python3 -m json.tool running.json)
(the generated_at line differs by design; the model hashes must not)
============================================================
DONE
}

case "${1:-}" in
  save)    shift; do_save "$@" ;;
  install) shift; do_install "$@" ;;
  verify)  shift; do_verify "$@" ;;
  -h|--help|"") usage ;;
  *) echo "!! unknown command: $1"; usage; exit 2 ;;
esac
