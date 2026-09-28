#!/usr/bin/env bash
# `read` echoes the MAJOR.MINOR an environment's orchestrator recorded on its last rollout, or `none`.
set -euo pipefail

ACTION="${1:?usage: orchestrator-contract-version.sh read|write <environment> [version]}"
ENV="${2:?usage: orchestrator-contract-version.sh read|write <environment> [version]}"
PARAM="/scvs/${ENV}/deployed/orchestrator-contract-version"

case "$ACTION" in
  read)
    RAW="$(aws ssm get-parameter --name "$PARAM" --query 'Parameter.Value' --output text 2>&1)" || {
      case "$RAW" in
        *ParameterNotFound*)
          echo "::notice::no $PARAM yet — this environment's orchestrator has never recorded a contract version" >&2
          echo none
          exit 0
          ;;
        *)
          echo "::error::could not read $PARAM: $RAW" >&2
          exit 4
          ;;
      esac
    }
    [[ "$RAW" =~ ^[0-9]+\.[0-9]+$ ]] || {
      echo "::error::$PARAM holds '$RAW', which is not a MAJOR.MINOR contract version" >&2
      exit 4
    }
    echo "$RAW"
    ;;
  write)
    VERSION="${3:?usage: orchestrator-contract-version.sh write <environment> <version>}"
    [[ "$VERSION" =~ ^[0-9]+\.[0-9]+$ ]] || {
      echo "::error::$VERSION is not a MAJOR.MINOR contract version" >&2
      exit 4
    }
    aws ssm put-parameter --name "$PARAM" --type String --overwrite --value "$VERSION" \
      --description "Highest recipe.json contract version ${ENV}'s orchestrator-svc supports (written by deploy.yml)" \
      >/dev/null || {
      echo "::error::could not write $PARAM — the CI role needs ssm:PutParameter on /scvs/*/deployed/*" >&2
      exit 4
    }
    echo "recorded $PARAM = $VERSION" >&2
    ;;
  *)
    echo "::error::unknown action $ACTION (expected read or write)" >&2
    exit 4
    ;;
esac
