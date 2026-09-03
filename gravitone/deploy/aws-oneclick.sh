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

# Every AWS call below used to run unchecked under `set -uo pipefail` (note the
# absent -e). A missing profile, an expired session or a denied permission left
# each capture EMPTY, and the script sailed on to print a fully-formed
# "Your Private ElevenLabs" banner reading `http://:8080` — after 20 minutes of
# waiting for an instance that was never launched. Confirmed empirically during
# the 2026-08-05 deploy rehearsal; see docs/DEPLOY_REHEARSAL.md. A deploy script
# that cannot fail cannot be trusted when it succeeds.
die() { printf '\n!! %s\n' "$*" >&2; exit 1; }

require() { # require <value> <what failed>
  [ -n "${1:-}" ] && [ "$1" != "None" ] || die "$2"
}

preflight() {
  local who
  who="$("${AWS[@]}" sts get-caller-identity --query 'Account' --output text 2>&1)" \
    || die "cannot authenticate to AWS with profile \"$PROFILE\" in $REGION:
   $who
   Set up the profile first (see aws/README.md step 3: aws configure --profile $PROFILE),
   or point at an existing one:  PROFILE=default deploy/aws-oneclick.sh $1"
  echo "account $who · region $REGION · profile $PROFILE"
}

find_instance() {
  # Reservations[].Instances[0] can yield SEVERAL ids across reservations; the
  # old `tr -d '[:space:]'` glued them into one nonsense id. Take the first.
  "${AWS[@]}" ec2 describe-instances \
    --filters "Name=tag:Name,Values=$TAG" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[].InstanceId' --output text 2>/dev/null \
    | tr '\t' '\n' | grep -v '^$' | head -1 | tr -d '[:space:]'
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
  [ -n "$cidr" ] && [ "$cidr" != "/32" ] || die "could not determine your public IP for the security-group rule; pass CIDR=x.x.x.x/32"
  sgid="$("${AWS[@]}" ec2 create-security-group --group-name "$TAG" \
    --description "Gravitone TTS API (8080)" --query 'GroupId' --output text)" \
    || die "ec2:CreateSecurityGroup failed (needs ec2:CreateSecurityGroup, or pass SG=sg-... to reuse one)"
  require "$sgid" "ec2:CreateSecurityGroup returned no group id"
  "${AWS[@]}" ec2 authorize-security-group-ingress --group-id "$sgid" \
    --protocol tcp --port 8080 --cidr "$cidr" >/dev/null \
    || die "ec2:AuthorizeSecurityGroupIngress failed on $sgid — the group exists but port 8080 is CLOSED.
   Note aws/iam-policy.json grants AuthorizeSecurityGroupEGRESS, not Ingress. Add it.
   Clean up the half-made group with: deploy/rollback.sh cloud --yes"
  echo "created security group $sgid (8080 open to $cidr)" >&2
  printf '%s' "$sgid"
}

cmd_up() {
  preflight up
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
    require "$ami" "could not resolve an Ubuntu 24.04 arm64 AMI in $REGION (ec2:DescribeImages denied, or no match)"
    local userdata
    userdata="$(printf '#!/bin/bash\nset -e\nexport TTS_API_KEY=%s\ncurl -sL %s | bash\n' \
      "$key" "https://raw.githubusercontent.com/xkazm04/gravitone/main/gravitone/deploy/bootstrap.sh" | base64 -w0 2>/dev/null || \
      printf '#!/bin/bash\nset -e\nexport TTS_API_KEY=%s\ncurl -sL %s | bash\n' \
      "$key" "https://raw.githubusercontent.com/xkazm04/gravitone/main/gravitone/deploy/bootstrap.sh" | base64)"
    echo "launching $TYPE from $ami ..."
    id="$("${AWS[@]}" ec2 run-instances \
      --image-id "$ami" --instance-type "$TYPE" \
      --security-group-ids "$sgid" \
      --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=20,VolumeType=gp3}' \
      --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$TAG}]" \
      --metadata-options 'HttpTokens=required' \
      --user-data "$userdata" \
      --query 'Instances[0].InstanceId' --output text)" \
      || die "ec2:RunInstances failed. If this is a FREE-tier account, $TYPE may not be
   free-tier eligible (see aws/README.md). Nothing to clean up unless a security
   group was just created — check: deploy/rollback.sh verify"
    require "$id" "ec2:RunInstances returned no instance id"
    echo "launched $id"
  fi

  local ip=""; echo "waiting for public IP ..."
  for _ in $(seq 1 30); do
    ip="$(instance_ip "$id")"; [ -n "$ip" ] && [ "$ip" != "None" ] && break; sleep 5
  done
  require "$ip" "instance $id never got a public IP after 150s.
   It IS running and IS billable. Inspect it, or tear it down:
     deploy/rollback.sh verify
     deploy/rollback.sh cloud --yes"

  echo "waiting for the service (docker build + model load, usually 4-8 min) ..."
  local healthy=0
  for _ in $(seq 1 120); do
    if curl -sf -m 5 "http://$ip:8080/health" >/dev/null 2>&1; then healthy=1; break; fi
    sleep 10
  done
  if [ "$healthy" != 1 ]; then
    cat >&2 <<FAIL

!! Instance $id ($ip) is up, but /health never answered in 20 minutes.
   The box is RUNNING AND BILLABLE. The bootstrap probably failed. Look at it:
     ssh/SSM onto the box, then: journalctl -u gravitone -e
     cloud-init log:            /var/log/cloud-init-output.log
   (Note: this script attaches NO key pair and NO SSM instance profile, so
   neither may be reachable — that is a known gap, see docs/DEPLOY_REHEARSAL.md.)
   Tear it down when done:  deploy/rollback.sh cloud --yes
FAIL
    exit 1
  fi

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
  preflight status
  local id; id="$(find_instance)"; [ -z "$id" ] && { echo "no instance"; return 0; }
  "${AWS[@]}" ec2 describe-instances --instance-ids "$id" \
    --query 'Reservations[0].Instances[0].{Id:InstanceId,State:State.Name,Type:InstanceType,IP:PublicIpAddress}' --output table
  [ -f "$KEY_FILE" ] && echo "xi-api-key: $(cat "$KEY_FILE")"
}

cmd_stop() {
  preflight stop
  local id; id="$(find_instance)"
  require "$id" "no instance tagged $TAG in $REGION — nothing to stop"
  "${AWS[@]}" ec2 stop-instances --instance-ids "$id" --query 'StoppingInstances[0].CurrentState.Name' --output text \
    || die "ec2:StopInstances failed on $id — it may STILL BE RUNNING and billable"
}

# `terminate` kills the instance ONLY. The security group, any orphaned volume
# and the local root-key file survive it. deploy/rollback.sh is the complete
# teardown; this stays for muscle memory and points at it.
cmd_terminate() {
  preflight terminate
  local id; id="$(find_instance)"
  require "$id" "no instance tagged $TAG in $REGION — nothing to terminate"
  "${AWS[@]}" ec2 terminate-instances --instance-ids "$id" --query 'TerminatingInstances[0].CurrentState.Name' --output text \
    || die "ec2:TerminateInstances failed on $id — IT IS STILL RUNNING AND BILLABLE in $REGION"
  cat <<NOTE

Instance $id terminated. NOT removed: the "$TAG" security group, any orphaned
volume, and $KEY_FILE (which holds this deployment's root API key).
Complete the teardown with:
  deploy/rollback.sh cloud --yes     # removes all of the above, then verifies
NOTE
}

case "${1:-status}" in
  up) cmd_up ;;
  status) cmd_status ;;
  stop) cmd_stop ;;
  terminate) cmd_terminate ;;
  rollback|down) echo "use: deploy/rollback.sh cloud --yes  (full teardown + verification)"; exit 1 ;;
  *) echo "usage: $0 {up|status|stop|terminate}   (teardown: deploy/rollback.sh)"; exit 1 ;;
esac
