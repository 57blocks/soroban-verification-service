#!/usr/bin/env bash
# Callers: deploy.yml (deploy-service, deploy-web) and rollback.yml.
set -euo pipefail

CLUSTER="${1:?usage: roll-service-to-alias.sh <cluster> <expected-digest> <service>...}"
EXPECTED="${2:?usage: roll-service-to-alias.sh <cluster> <expected-digest> <service>...}"
shift 2
[ "$#" -gt 0 ] || { echo "::error::no services given"; exit 2; }
SERVICES=("$@")

DEADLINE_SECONDS="${ROLLOUT_DEADLINE_SECONDS:-1800}"
POLL_SECONDS="${ROLLOUT_POLL_SECONDS:-15}"
# Old tasks can still be draining for a moment after a COMPLETED rollout, which shows up as two digests running.
SETTLE_ATTEMPTS="${ROLLOUT_SETTLE_ATTEMPTS:-12}"
SETTLE_SECONDS="${ROLLOUT_SETTLE_SECONDS:-10}"

# invariants.md rule 29: CI owns the task definition, and every revision pins an exact commit's digest.
# deploy.yml passes TASK_DEFINITION_ARN to point a service at the revision it just registered.
# rollback.yml passes it too now, pointing at the ACTIVE revision that pins the commit being rolled
# back to — found by scanning the family, not by an alias. Neither caller relies on the alias tag to
# determine what a service is running; it is deploy-time bookkeeping only.
#
# An env var rather than a positional argument, deliberately: rollback.yml passes N service names
# positionally ("$CLUSTER" "$DIGEST" $SERVICES), so a fourth positional would be read as a service.
# It is also single-service by construction — one ARN cannot serve a multi-service call — hence the
# guard below rather than a silent mis-assignment.
ROLL_ARGS=(--force-new-deployment)
if [ -n "${TASK_DEFINITION_ARN:-}" ]; then
  if [ "${#SERVICES[@]}" -ne 1 ]; then
    echo "::error::TASK_DEFINITION_ARN is set but ${#SERVICES[@]} services were given — one revision cannot serve several"
    exit 2
  fi
  ROLL_ARGS=(--task-definition "$TASK_DEFINITION_ARN")
fi

# Poll the deployment this run created, by id.
declare -a DEPLOYMENT_IDS=()
for SERVICE in "${SERVICES[@]}"; do
  ID=$(aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" "${ROLL_ARGS[@]}" \
    --query 'service.deployments[?status==`PRIMARY`].id | [0]' --output text)
  if [ -z "$ID" ] || [ "$ID" = "None" ]; then
    echo "::error::$SERVICE: update-service returned no PRIMARY deployment id"
    exit 1
  fi
  echo "$SERVICE: deployment $ID started"
  DEPLOYMENT_IDS+=("$ID")
done

DEADLINE=$((SECONDS + DEADLINE_SECONDS))
for i in "${!SERVICES[@]}"; do
  SERVICE="${SERVICES[$i]}"
  DEPLOYMENT="${DEPLOYMENT_IDS[$i]}"
  while :; do
    STATE=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
      --query "services[0].deployments[?id=='${DEPLOYMENT}'].rolloutState | [0]" --output text)
    case "$STATE" in
      COMPLETED)
        echo "$SERVICE: $DEPLOYMENT COMPLETED"
        break
        ;;
      FAILED)
        REASON=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
          --query "services[0].deployments[?id=='${DEPLOYMENT}'].rolloutStateReason | [0]" --output text)
        echo "::error::$SERVICE: $DEPLOYMENT FAILED — $REASON"
        exit 1
        ;;
      None|"")
        # The deployment is gone from the service's list: a circuit-breaker rollback superseded it.
        echo "::error::$SERVICE: $DEPLOYMENT is no longer listed — it was superseded, most likely by a rollback"
        exit 1
        ;;
    esac
    if [ "$SECONDS" -ge "$DEADLINE" ]; then
      echo "::error::$SERVICE: $DEPLOYMENT still $STATE after ${DEADLINE_SECONDS}s"
      exit 1
    fi
    sleep "$POLL_SECONDS"
  done
done

# A COMPLETED rollout of a rollback is still COMPLETED, so the digest is what settles it.
runningDigests() {
  local service="$1" tasks
  tasks=$(aws ecs list-tasks --cluster "$CLUSTER" --service-name "$service" \
    --desired-status RUNNING --query 'taskArns' --output text)
  [ -n "$tasks" ] && [ "$tasks" != "None" ] || return 1
  # shellcheck disable=SC2086
  aws ecs describe-tasks --cluster "$CLUSTER" --tasks $tasks \
    --query "tasks[].containers[?name=='${service}'].imageDigest" --output text \
    | tr '\t' '\n' | grep -v '^$' | sort -u | tr '\n' ' ' | xargs
}

FAILED=0
for SERVICE in "${SERVICES[@]}"; do
  RUNNING=""
  for _ in $(seq "$SETTLE_ATTEMPTS"); do
    RUNNING=$(runningDigests "$SERVICE" || true)
    [ "$RUNNING" = "$EXPECTED" ] && break
    sleep "$SETTLE_SECONDS"
  done

  if [ "$RUNNING" = "$EXPECTED" ]; then
    echo "$SERVICE runs $EXPECTED"
  elif [ -z "$RUNNING" ]; then
    echo "::error::$SERVICE has no RUNNING task after a completed rollout"
    FAILED=1
  else
    echo "::error::$SERVICE runs [$RUNNING], expected $EXPECTED — the deployment did not land"
    FAILED=1
  fi
done

exit "$FAILED"
