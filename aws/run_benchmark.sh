#!/usr/bin/env bash
# Local driver (run from YOUR machine) that launches a Graviton instance,
# runs the gravitone benchmark on it via SSM (no SSH), fetches the results,
# and stops/terminates the box. Idempotent-ish; tags everything "gravitone".
#
# Prereqs (one-time, see aws/README.md):
#   - AWS CLI v2 configured with a profile that has aws/iam-policy.json
#   - An SSM instance profile named gravitone-ssm-profile
#
# Usage:
#   aws/run_benchmark.sh up        # launch + wait for SSM
#   aws/run_benchmark.sh bench     # run benchmark_arm.sh on the box, fetch results
#   aws/run_benchmark.sh stop      # stop the instance (keeps disk, ~$0 compute)
#   aws/run_benchmark.sh terminate # delete the instance entirely
#   aws/run_benchmark.sh status
#
# Env:
#   PROFILE (default gravitone)  REGION (default us-east-1)
#   TYPE (default c8g.2xlarge)   REPO (default https://github.com/xkazm04/gravitone.git)
set -uo pipefail
PROFILE="${PROFILE:-gravitone}"
REGION="${REGION:-us-east-1}"
TYPE="${TYPE:-c8g.2xlarge}"
REPO="${REPO:-https://github.com/xkazm04/gravitone.git}"
PROFILE_NAME="gravitone-ssm-profile"
TAG="gravitone-bench"
AWS=(aws --profile "$PROFILE" --region "$REGION")

find_instance() {
  "${AWS[@]}" ec2 describe-instances \
    --filters "Name=tag:Name,Values=$TAG" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[0].InstanceId' --output text 2>/dev/null | tr -d '[:space:]'
}

cmd_up() {
  local existing; existing="$(find_instance)"
  if [ -n "$existing" ] && [ "$existing" != "None" ]; then
    echo "instance exists: $existing (starting if stopped)"; "${AWS[@]}" ec2 start-instances --instance-ids "$existing" >/dev/null || true
  else
    # Latest Ubuntu 24.04 arm64 AMI from Canonical's public SSM parameter.
    local ami; ami="$("${AWS[@]}" ssm get-parameter \
      --name /aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id \
      --query 'Parameter.Value' --output text)"
    echo "launching $TYPE from $ami ..."
    local id; id="$("${AWS[@]}" ec2 run-instances \
      --image-id "$ami" --instance-type "$TYPE" \
      --iam-instance-profile "Name=$PROFILE_NAME" \
      --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=20,VolumeType=gp3}' \
      --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$TAG}]" \
      --metadata-options 'HttpTokens=required' \
      --query 'Instances[0].InstanceId' --output text)"
    echo "launched $id"
  fi
  local id; id="$(find_instance)"
  echo "waiting for SSM registration (usually 1-3 min) ..."
  for _ in $(seq 1 60); do
    reg="$("${AWS[@]}" ssm describe-instance-information \
      --filters "Key=InstanceIds,Values=$id" \
      --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || true)"
    [ "$reg" = "Online" ] && { echo "SSM online: $id"; return 0; }
    sleep 5
  done
  echo "!! SSM did not come online for $id"; return 1
}

_send() { # runs a shell command on the box via SSM, waits, prints output
  local id="$1" script="$2"
  local cid; cid="$("${AWS[@]}" ssm send-command \
    --instance-ids "$id" --document-name "AWS-RunShellScript" \
    --timeout-seconds 3600 \
    --parameters "commands=[$script]" \
    --query 'Command.CommandId' --output text)"
  echo "ssm command: $cid (waiting ...)"
  for _ in $(seq 1 480); do   # up to ~40 min
    st="$("${AWS[@]}" ssm get-command-invocation --command-id "$cid" --instance-id "$id" \
      --query 'Status' --output text 2>/dev/null || echo Pending)"
    case "$st" in
      Success) break ;;
      Failed|Cancelled|TimedOut) echo "!! command $st"; ;;
    esac
    [ "$st" = "Success" ] && break
    sleep 5
  done
  "${AWS[@]}" ssm get-command-invocation --command-id "$cid" --instance-id "$id" \
    --query 'StandardOutputContent' --output text
  echo "----- stderr (tail) -----"
  "${AWS[@]}" ssm get-command-invocation --command-id "$cid" --instance-id "$id" \
    --query 'StandardErrorContent' --output text | tail -20
}

cmd_bench() {
  local id; id="$(find_instance)"; [ -z "$id" ] && { echo "no instance; run 'up' first"; return 1; }
  # clone (or pull) + run benchmark as ubuntu user; tail the summary.
  _send "$id" "'set -e; sudo -u ubuntu bash -lc \"cd ~ && (git -C gravitone pull -q || git clone -q $REPO) && cd gravitone && bash benchmark_arm.sh 2>&1 | tail -c 20000\"'"
}

cmd_status() {
  local id; id="$(find_instance)"; [ -z "$id" ] && { echo "no instance"; return 0; }
  "${AWS[@]}" ec2 describe-instances --instance-ids "$id" \
    --query 'Reservations[0].Instances[0].{Id:InstanceId,State:State.Name,Type:InstanceType,IP:PublicIpAddress}' --output table
}

cmd_stop()      { local id; id="$(find_instance)"; "${AWS[@]}" ec2 stop-instances --instance-ids "$id" --query 'StoppingInstances[0].CurrentState.Name' --output text; }
cmd_terminate() { local id; id="$(find_instance)"; "${AWS[@]}" ec2 terminate-instances --instance-ids "$id" --query 'TerminatingInstances[0].CurrentState.Name' --output text; }

case "${1:-status}" in
  up) cmd_up ;;
  bench) cmd_bench ;;
  stop) cmd_stop ;;
  terminate) cmd_terminate ;;
  status) cmd_status ;;
  *) echo "usage: $0 {up|bench|stop|terminate|status}"; exit 1 ;;
esac
