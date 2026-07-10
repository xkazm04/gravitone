#!/usr/bin/env bash
# One-command "Private ElevenLabs" on AWS Graviton — launches an Arm box,
# bootstraps the Gravitone TTS service via UserData, opens port 8080 to your
# CIDR, and prints the ready-to-use base URL + API key.
#
# Usage:
#   deploy/aws-oneclick.sh up         # launch + bootstrap + print endpoint
#   deploy/aws-oneclick.sh status     # instance state + endpoint + key
#   deploy/aws-oneclick.sh stop       # stop compute (~$0, keeps disk/voices)
#   deploy/aws-oneclick.sh terminate  # delete everything (incl. cloned voices)
#
# Env:
#   PROFILE (default gravitone)   REGION (default us-east-1)
#   TYPE    (default t4g.small — free-tier demo; c8g.2xlarge for production)
#   CIDR    (default <your ip>/32)   SG (reuse an existing security group id)
#   REPO    (default https://github.com/xkazm04/gravitone.git)
#
# Extra IAM needed beyond aws/iam-policy.json: ec2:CreateSecurityGroup,
# ec2:AuthorizeSecurityGroupIngress (or pass SG= to skip creation).
set -uo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
PROFILE="${PROFILE:-gravitone}"
REGION="${REGION:-us-east-1}"
TYPE="${TYPE:-t4g.small}"
REPO="${REPO:-https://github.com/xkazm04/gravitone.git}"
TAG="gravitone-tts"
KEY_FILE=".gravitone-deploy-key"
AWS=(aws --profile "$PROFILE" --region "$REGION")

find_instance() {
  "${AWS[@]}" ec2 describe-instances \
    --filters "Name=tag:Name,Values=$TAG" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[0].InstanceId' --output text 2>/dev/null | tr -d '[:space:]'
}

instance_ip() {
  "${AWS[@]}" ec2 describe-instances --instance-ids "$1" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' --output text
}

api_key() { # persisted locally on first launch so status can re-print it
  if [ -f "$KEY_FILE" ]; then cat "$KEY_FILE"; else
    local k="gvt_root_$(openssl rand -hex 24 2>/dev/null || head -c24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    printf '%s' "$k" > "$KEY_FILE"; chmod 600 "$KEY_FILE" 2>/dev/null || true
    printf '%s' "$k"
  fi
}

ensure_sg() {
  if [ -n "${SG:-}" ]; then printf '%s' "$SG"; return; fi
  local existing
  existing="$("${AWS[@]}" ec2 describe-security-groups \
    --filters "Name=group-name,Values=$TAG" \
    --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null | tr -d '[:space:]')"
  if [ -n "$existing" ] && [ "$existing" != "None" ]; then printf '%s' "$existing"; return; fi
  local cidr="${CIDR:-$(curl -sf https://checkip.amazonaws.com | tr -d '[:space:]')/32}"
  local sgid
  sgid="$("${AWS[@]}" ec2 create-security-group --group-name "$TAG" \
    --description "Gravitone TTS API (8080)" --query 'GroupId' --output text)"
  "${AWS[@]}" ec2 authorize-security-group-ingress --group-id "$sgid" \
    --protocol tcp --port 8080 --cidr "$cidr" >/dev/null
  echo "created security group $sgid (8080 open to $cidr)" >&2
  printf '%s' "$sgid"
}

cmd_up() {
  local id; id="$(find_instance)"
  local key; key="$(api_key)"
  if [ -n "$id" ] && [ "$id" != "None" ]; then
    echo "instance exists: $id (starting if stopped)"
    "${AWS[@]}" ec2 start-instances --instance-ids "$id" >/dev/null || true
  else
    local sgid; sgid="$(ensure_sg)"
    local ami; ami="$("${AWS[@]}" ec2 describe-images --owners 099720109477 \
      --filters "Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*" "Name=state,Values=available" \
      --query 'reverse(sort_by(Images,&CreationDate))[0].ImageId' --output text)"
    local userdata
    userdata="$(printf '#!/bin/bash\nset -e\nexport TTS_API_KEY=%s\ncurl -sL %s | bash\n' \
      "$key" "https://raw.githubusercontent.com/xkazm04/gravitone/main/deploy/bootstrap.sh" | base64 -w0 2>/dev/null || \
      printf '#!/bin/bash\nset -e\nexport TTS_API_KEY=%s\ncurl -sL %s | bash\n' \
      "$key" "https://raw.githubusercontent.com/xkazm04/gravitone/main/deploy/bootstrap.sh" | base64)"
    echo "launching $TYPE from $ami ..."
    id="$("${AWS[@]}" ec2 run-instances \
      --image-id "$ami" --instance-type "$TYPE" \
      --security-group-ids "$sgid" \
      --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=20,VolumeType=gp3}' \
      --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$TAG}]" \
      --metadata-options 'HttpTokens=required' \
      --user-data "$userdata" \
      --query 'Instances[0].InstanceId' --output text)"
    echo "launched $id"
  fi

  local ip=""; echo "waiting for public IP ..."
  for _ in $(seq 1 30); do
    ip="$(instance_ip "$id")"; [ -n "$ip" ] && [ "$ip" != "None" ] && break; sleep 5
  done
  echo "waiting for the service (docker build + model load, usually 4-8 min) ..."
  for _ in $(seq 1 120); do
    curl -sf -m 5 "http://$ip:8080/health" >/dev/null 2>&1 && break
    sleep 10
  done

  cat <<DONE

============================================================
Your Private ElevenLabs:

  Base URL   : http://$ip:8080
  xi-api-key : $key

  curl -X POST "http://$ip:8080/v1/text-to-speech/alba" \\
    -H "xi-api-key: $key" -H "Content-Type: application/json" \\
    -d '{"text":"My own voice cloud, on one Arm box."}' --output hello.wav

Stop compute when idle:  deploy/aws-oneclick.sh stop
============================================================
DONE
}

cmd_status() {
  local id; id="$(find_instance)"; [ -z "$id" ] && { echo "no instance"; return 0; }
  "${AWS[@]}" ec2 describe-instances --instance-ids "$id" \
    --query 'Reservations[0].Instances[0].{Id:InstanceId,State:State.Name,Type:InstanceType,IP:PublicIpAddress}' --output table
  [ -f "$KEY_FILE" ] && echo "xi-api-key: $(cat "$KEY_FILE")"
}

cmd_stop()      { local id; id="$(find_instance)"; "${AWS[@]}" ec2 stop-instances --instance-ids "$id" --query 'StoppingInstances[0].CurrentState.Name' --output text; }
cmd_terminate() { local id; id="$(find_instance)"; "${AWS[@]}" ec2 terminate-instances --instance-ids "$id" --query 'TerminatingInstances[0].CurrentState.Name' --output text; }

case "${1:-status}" in
  up) cmd_up ;;
  status) cmd_status ;;
  stop) cmd_stop ;;
  terminate) cmd_terminate ;;
  *) echo "usage: $0 {up|status|stop|terminate}"; exit 1 ;;
esac
