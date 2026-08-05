#!/usr/bin/env bash
# Rollback / teardown for every artifact the Gravitone deploy paths create.
#
# The deploy story had four ways IN (aws-oneclick.sh, cloudformation.yaml,
# bootstrap.sh, airgap-install.sh) and no way OUT: `aws-oneclick.sh terminate`
# kills the instance and leaves the security group, the local root-key file and
# any orphaned volumes behind, and nothing at all undid the on-box install.
# This script is the way out.
#
# Usage:
#   deploy/rollback.sh verify              # read-only: what exists right now
#   deploy/rollback.sh cloud   [--yes]     # undo aws-oneclick.sh (instance+SG+key)
#   deploy/rollback.sh stack   [--yes]     # undo cloudformation.yaml (whole stack)
#   deploy/rollback.sh box     [--yes]     # undo bootstrap.sh ON the box
#   deploy/rollback.sh all     [--yes]     # cloud + stack
#
# Flags:
#   --yes              actually do it. WITHOUT IT NOTHING IS DESTROYED — the
#                      script prints the plan and exits 0. A teardown you can
#                      dry-run is a teardown people actually run.
#   --purge-voices     (box only) also delete the gravitone-voices /
#                      gravitone-ingest named volumes. Cloned voices are
#                      irreplaceable user data, so they SURVIVE by default.
#
# Env: PROFILE (default gravitone)  REGION (default us-east-1)
#      STACK   (default gravitone)  TAG    (default gravitone-tts)
set -uo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

PROFILE="${PROFILE:-gravitone}"
REGION="${REGION:-us-east-1}"
STACK="${STACK:-gravitone}"
TAG="${TAG:-gravitone-tts}"
KEY_FILE=".gravitone-deploy-key"
AWS=(aws --profile "$PROFILE" --region "$REGION")

CONFIRM=0
PURGE_VOICES=0
CMD="${1:-verify}"
shift || true
for arg in "$@"; do
  case "$arg" in
    --yes|-y) CONFIRM=1 ;;
    --purge-voices) PURGE_VOICES=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 1 ;;
  esac
done

say()  { printf '\n== %s\n' "$*"; }
plan() { if [ "$CONFIRM" = 1 ]; then printf '   -> %s\n' "$*"; else printf '   [dry-run] would: %s\n' "$*"; fi; }
run()  { if [ "$CONFIRM" = 1 ]; then "$@"; else return 0; fi; }

# Fail loudly on a broken credential/profile instead of pretending the account
# is empty — an unreachable AWS and an already-clean AWS look identical to a
# describe call that errors, and confusing the two is how a live instance gets
# reported as torn down. (This is the same trap aws-oneclick.sh fell into.)
preflight_aws() {
  local who
  if ! who="$("${AWS[@]}" sts get-caller-identity --query 'Account' --output text 2>&1)"; then
    cat >&2 <<EOF
!! Cannot reach AWS with profile "$PROFILE" in $REGION:
   $who
!! ABORTING. Nothing was inspected and nothing was deleted. Resources may
   still be running and costing money. Fix the credentials and re-run:
       PROFILE=$PROFILE REGION=$REGION deploy/rollback.sh verify
EOF
    exit 2
  fi
  echo "authenticated: account $who, region $REGION, profile $PROFILE"
}

find_instances() {
  "${AWS[@]}" ec2 describe-instances \
    --filters "Name=tag:Name,Values=$TAG" \
              "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[].InstanceId' --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true
}

find_sgs() {
  "${AWS[@]}" ec2 describe-security-groups \
    --filters "Name=group-name,Values=$TAG" \
    --query 'SecurityGroups[].GroupId' --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true
}

find_orphan_volumes() {
  "${AWS[@]}" ec2 describe-volumes \
    --filters "Name=status,Values=available" "Name=tag:Name,Values=$TAG" \
    --query 'Volumes[].VolumeId' --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true
}

# ---------------------------------------------------------------- verify -----
cmd_verify() {
  preflight_aws
  say "EC2 instances tagged Name=$TAG"
  "${AWS[@]}" ec2 describe-instances \
    --filters "Name=tag:Name,Values=$TAG" \
    --query 'Reservations[].Instances[].{Id:InstanceId,State:State.Name,Type:InstanceType,Launched:LaunchTime}' \
    --output table 2>&1 || echo "   (describe failed)"

  say "Security groups named $TAG"
  "${AWS[@]}" ec2 describe-security-groups --filters "Name=group-name,Values=$TAG" \
    --query 'SecurityGroups[].{Id:GroupId,Name:GroupName,Vpc:VpcId}' --output table 2>&1 || echo "   (none)"

  say "Available (unattached) volumes tagged $TAG"
  "${AWS[@]}" ec2 describe-volumes --filters "Name=status,Values=available" "Name=tag:Name,Values=$TAG" \
    --query 'Volumes[].{Id:VolumeId,Size:Size,Created:CreateTime}' --output table 2>&1 || echo "   (none)"

  say "CloudFormation stack $STACK"
  "${AWS[@]}" cloudformation describe-stacks --stack-name "$STACK" \
    --query 'Stacks[].{Name:StackName,Status:StackStatus,Created:CreationTime}' --output table 2>&1 \
    || echo "   (no such stack — fine)"

  say "Local secret material"
  if [ -f "$KEY_FILE" ]; then
    echo "   !! $KEY_FILE EXISTS in $(pwd) and holds the deployment's ROOT API KEY."
    echo "      It is not printed here on purpose. Remove it with: deploy/rollback.sh cloud --yes"
  else
    echo "   clean (no $KEY_FILE)"
  fi
  echo
  echo "Anything listed above is still billable. Nothing was deleted by 'verify'."
}

# ----------------------------------------------------------------- cloud -----
cmd_cloud() {
  preflight_aws
  local ids sgs vols
  ids="$(find_instances)"

  say "instances"
  if [ -z "$ids" ]; then echo "   none tagged $TAG"; else
    echo "$ids" | while read -r id; do plan "terminate $id"; done
    # shellcheck disable=SC2086
    run "${AWS[@]}" ec2 terminate-instances --instance-ids $ids \
      --query 'TerminatingInstances[].{Id:InstanceId,State:CurrentState.Name}' --output table
    if [ "$CONFIRM" = 1 ]; then
      echo "   waiting for termination (a security group cannot be deleted while an ENI holds it) ..."
      # shellcheck disable=SC2086
      "${AWS[@]}" ec2 wait instance-terminated --instance-ids $ids || echo "   !! wait failed; SG delete may fail below"
    fi
  fi

  say "security groups"
  sgs="$(find_sgs)"
  if [ -z "$sgs" ]; then echo "   none named $TAG"; else
    echo "$sgs" | while read -r sg; do
      plan "delete security group $sg"
      if [ "$CONFIRM" = 1 ]; then
        if ! "${AWS[@]}" ec2 delete-security-group --group-id "$sg" 2>&1; then
          echo "   !! could not delete $sg — it is probably still attached, or the"
          echo "      gravitone-agent IAM policy lacks ec2:DeleteSecurityGroup."
          echo "      THIS RESOURCE IS STILL PRESENT in $REGION."
        fi
      fi
    done
  fi

  say "orphaned volumes"
  vols="$(find_orphan_volumes)"
  if [ -z "$vols" ]; then echo "   none available/unattached"; else
    echo "$vols" | while read -r v; do
      plan "delete volume $v"
      run "${AWS[@]}" ec2 delete-volume --volume-id "$v" || echo "   !! $v NOT deleted"
    done
  fi

  say "local root key"
  if [ -f "$KEY_FILE" ]; then
    plan "shred $KEY_FILE (holds the root API key of the deployment just destroyed)"
    if [ "$CONFIRM" = 1 ]; then rm -f "$KEY_FILE" && echo "   removed"; fi
  else echo "   nothing to remove"; fi

  if [ "$CONFIRM" = 1 ]; then say "post-teardown verification"; cmd_verify; else
    echo
    echo "DRY RUN — nothing was deleted. Re-run with --yes to execute."
  fi
}

# ----------------------------------------------------------------- stack -----
cmd_stack() {
  preflight_aws
  if ! "${AWS[@]}" cloudformation describe-stacks --stack-name "$STACK" >/dev/null 2>&1; then
    echo "no stack named $STACK in $REGION — nothing to roll back"; return 0
  fi
  plan "delete CloudFormation stack $STACK (instance + security group go with it)"
  run "${AWS[@]}" cloudformation delete-stack --stack-name "$STACK"
  if [ "$CONFIRM" = 1 ]; then
    echo "   waiting for DELETE_COMPLETE (a few minutes) ..."
    if "${AWS[@]}" cloudformation wait stack-delete-complete --stack-name "$STACK"; then
      echo "   stack deleted"
    else
      echo "!! STACK DELETE DID NOT COMPLETE. The stack $STACK in $REGION may be in"
      echo "   DELETE_FAILED with resources STILL RUNNING AND BILLABLE. Inspect:"
      echo "     aws --profile $PROFILE --region $REGION cloudformation describe-stack-events --stack-name $STACK"
    fi
    say "post-teardown verification"; cmd_verify
  else
    echo; echo "DRY RUN — stack untouched. Re-run with --yes to execute."
  fi
}

# ------------------------------------------------------------------- box -----
# Undo bootstrap.sh / airgap-install.sh on the machine itself.
cmd_box() {
  [ "$(id -u)" = "0" ] || { echo "!! run as root (sudo deploy/rollback.sh box --yes)"; exit 1; }
  say "systemd unit"
  plan "systemctl disable --now gravitone"
  run systemctl disable --now gravitone 2>/dev/null || true
  plan "rm /etc/systemd/system/gravitone.service"
  run rm -f /etc/systemd/system/gravitone.service
  run systemctl daemon-reload

  say "container + image"
  plan "docker rm -f gravitone; docker rmi gravitone"
  run docker rm -f gravitone 2>/dev/null || true
  run docker rmi gravitone 2>/dev/null || true

  say "config"
  plan "rm /etc/gravitone.env (contains the root API key) and /etc/gravitone/"
  run rm -f /etc/gravitone.env
  run rm -rf /etc/gravitone

  say "source tree"
  plan "rm -rf /opt/gravitone"
  run rm -rf /opt/gravitone

  say "named volumes (cloned voices + ingest jobs)"
  if [ "$PURGE_VOICES" = 1 ]; then
    echo "   --purge-voices given: DESTROYING cloned voices. This is not recoverable."
    plan "docker volume rm gravitone-voices gravitone-ingest"
    run docker volume rm gravitone-voices gravitone-ingest 2>/dev/null || true
  else
    echo "   KEPT (gravitone-voices, gravitone-ingest). Cloned voices survive a"
    echo "   rollback so a bad upgrade can be re-bootstrapped without re-cloning."
    echo "   Pass --purge-voices to destroy them too."
  fi

  if [ "$CONFIRM" = 1 ]; then
    say "post-teardown verification"
    systemctl status gravitone --no-pager 2>&1 | head -3 || echo "   unit gone (expected)"
    docker ps -a --filter name=gravitone 2>/dev/null || true
    docker volume ls --filter name=gravitone 2>/dev/null || true
  else
    echo; echo "DRY RUN — the box was not modified. Re-run with --yes."
  fi
}

case "$CMD" in
  verify) cmd_verify ;;
  cloud)  cmd_cloud ;;
  stack)  cmd_stack ;;
  box)    cmd_box ;;
  all)    cmd_cloud; cmd_stack ;;
  *) echo "usage: $0 {verify|cloud|stack|box|all} [--yes] [--purge-voices]"; exit 1 ;;
esac
