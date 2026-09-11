#!/usr/bin/env bash
# Reads the /scvs/<env>/ci/descriptor SSM parameter.
set -euo pipefail

ENV="${1:?usage: load-ci-descriptor.sh <environment> [schema-version[,schema-version...]]}"
ACCEPTED_SCHEMAS="${2:-1}"
PARAM="/scvs/${ENV}/ci/descriptor"

RAW="$(aws ssm get-parameter --name "$PARAM" --query 'Parameter.Value' --output text 2>&1)" || {
  # Diagnostics go to STDERR, never stdout: callers capture stdout in a command substitution (`DESC=$(bash
  # scripts/ci/load-ci-descriptor.sh ...)`), and a message swallowed by that capture is a failure with no
  # explanation in the log.
  case "$RAW" in
    *ParameterNotFound*)
      echo "::notice::no CI descriptor at $PARAM — the infrastructure has not been applied to $ENV yet" >&2
      exit 3
      ;;
    *AccessDenied*|*"not authorized"*)
      echo "::error::AccessDenied reading $PARAM — the CI role needs ssm:GetParameter on the descriptor path (a permissions gap, not missing infrastructure)" >&2
      exit 4
      ;;
    *)
      echo "::error::could not read $PARAM: $RAW" >&2
      exit 4
      ;;
  esac
}

SCHEMA="$(jq -r '.schema_version' <<<"$RAW")"
# Comma-delimited membership, done by pattern rather than by splitting: both sides are wrapped in commas so `1`
# cannot match inside `11`, and there is no loop whose exit status `set -e` has to be reasoned about.
case ",${ACCEPTED_SCHEMAS}," in
  *",${SCHEMA},"*) ;;
  *)
    echo "::error::infra descriptor v${SCHEMA}, this workflow accepts v${ACCEPTED_SCHEMAS} — update the workflow to the new shape, or apply the matching infrastructure" >&2
    exit 5
    ;;
esac

echo "CI_DESCRIPTOR_JSON=$(jq -c . <<<"$RAW")" >> "$GITHUB_ENV"
# Flat top-level scalars become uppercase env vars; nested objects are read via CI_DESCRIPTOR_JSON.
jq -r 'to_entries[] | select(.value | type == "string" or type == "number") | "\(.key | ascii_upcase)=\(.value)"' <<<"$RAW" >> "$GITHUB_ENV"

echo "ci descriptor v${SCHEMA} loaded from $PARAM (accepted: v${ACCEPTED_SCHEMAS})" >&2
jq -c . <<<"$RAW"
