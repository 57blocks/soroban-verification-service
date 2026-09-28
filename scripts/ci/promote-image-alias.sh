#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="${1:?usage: promote-image-alias.sh <repository-name> <image-digest>}"
DIGEST="${2:?usage: promote-image-alias.sh <repository-name> <image-digest>}"
ALIAS_TAG="${ALIAS_TAG:-deployed}"

# Both media types: the default set excludes OCI, and buildx emits either.
IMAGE=$(aws ecr batch-get-image \
  --repository-name "$REPOSITORY" \
  --image-ids "imageDigest=$DIGEST" \
  --accepted-media-types \
  application/vnd.docker.distribution.manifest.v2+json \
  application/vnd.oci.image.manifest.v1+json \
  --query 'images[0]' --output json)

MANIFEST=$(jq -r '.imageManifest // empty' <<<"$IMAGE")
MEDIA_TYPE=$(jq -r '.imageManifestMediaType // empty' <<<"$IMAGE")

if [ -z "$MANIFEST" ]; then
  echo "::error::$REPOSITORY has no image at $DIGEST — nothing to promote"
  exit 1
fi

PUT_ARGS=(--repository-name "$REPOSITORY" --image-tag "$ALIAS_TAG" --image-manifest "$MANIFEST")
[ -n "$MEDIA_TYPE" ] && PUT_ARGS+=(--image-manifest-media-type "$MEDIA_TYPE")

# ImageAlreadyExistsException means the alias is already there, which is success.
if OUTPUT=$(aws ecr put-image "${PUT_ARGS[@]}" 2>&1); then
  echo "$REPOSITORY:$ALIAS_TAG -> $DIGEST"
else
  case "$OUTPUT" in
    *ImageAlreadyExistsException*)
      echo "$REPOSITORY:$ALIAS_TAG already at $DIGEST"
      ;;
    *)
      echo "::error::could not move $REPOSITORY:$ALIAS_TAG to $DIGEST: $OUTPUT"
      exit 1
      ;;
  esac
fi
