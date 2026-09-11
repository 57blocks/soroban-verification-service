#!/usr/bin/env bash
# Points the @scvs scope at this account's CodeArtifact npm registry from the directory it is run in, so a
# project outside this monorepo can install @scvs/sdk. Copy this file into that project; it needs only bash,
# git and the AWS CLI.
#
#   bash npmrc-bootstrap.sh                 # writes ./.npmrc, leaving any other entries in it alone
#   DOMAIN=… REPOSITORY=… AWS_REGION=… bash npmrc-bootstrap.sh
#
# The endpoint is resolved from your AWS credentials rather than written down: it embeds the account id, which
# no file in either repository carries. The token it writes is a live credential valid for 12 hours.
set -euo pipefail

DOMAIN="${DOMAIN:-sv-packages}"
REPOSITORY="${REPOSITORY:-sv-npm}"
REGION="${AWS_REGION:-ap-southeast-2}"
NPMRC="${NPMRC:-.npmrc}"

# A tracked .npmrc would commit the token. Refuse rather than write one.
if git ls-files --error-unmatch "$NPMRC" >/dev/null 2>&1; then
  echo "✗ $NPMRC is tracked by git — add it to .gitignore first: this script writes a live token into it" >&2
  exit 1
fi

ENDPOINT="$(aws codeartifact get-repository-endpoint \
  --domain "$DOMAIN" --repository "$REPOSITORY" --format npm \
  --region "$REGION" --query repositoryEndpoint --output text)"
TOKEN="$(aws codeartifact get-authorization-token \
  --domain "$DOMAIN" --region "$REGION" --query authorizationToken --output text)"

HOST="${ENDPOINT#https://}"
MANAGED_AUTH="//${HOST}:_authToken="

# Rewritten in place, so re-running refreshes the token instead of stacking duplicate lines. Only @scvs is
# scoped: the SDK's own dependencies still resolve from npmjs, exactly as they would for any other consumer.
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
if [ -f "$NPMRC" ]; then
  grep -v -e '^@scvs:registry=' -e "^${MANAGED_AUTH}" "$NPMRC" > "$TMP" || true
fi
{
  printf '@scvs:registry=%s\n' "$ENDPOINT"
  printf '%s%s\n' "$MANAGED_AUTH" "$TOKEN"
} >> "$TMP"
cp "$TMP" "$NPMRC"
chmod 600 "$NPMRC"

echo "✓ @scvs -> ${HOST#*.} · wrote $NPMRC (token valid 12h)"
echo
echo "  npm install @scvs/sdk           # newest stable"
echo "  npm install @scvs/sdk@staging   # newest release candidate"
echo "  npm install @scvs/sdk@dev       # newest build off main"
