#!/usr/bin/env bash
# Read from the source, not the built package: its callers set up neither pnpm nor node_modules.
set -euo pipefail

SOURCE="packages/core/src/artifact-contract.ts"
VERSION=$(sed -n 's/.*BUILD_ARTIFACT_SCHEMA_VERSION = "\([0-9]*\.[0-9]*\)".*/\1/p' "$SOURCE" | head -1)
if [ -z "$VERSION" ]; then
  echo "::error::could not read BUILD_ARTIFACT_SCHEMA_VERSION from $SOURCE — this check cannot be skipped silently" >&2
  exit 1
fi
echo "$VERSION"
