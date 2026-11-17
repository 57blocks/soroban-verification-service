#!/bin/sh
set -e

# The docker gateway stays root: it makes the sandbox workspaces the runner may not rename, and it is the only
# container in the job that mounts the host's docker socket. Every other command drops to `node`.
if [ "${1:-}" = "docker-gateway" ]; then
  exec node /app/services/builder/dist/docker-gateway-entrypoint.js
fi

DOCKER_SOCK="/var/run/docker.sock"
if [ -S "$DOCKER_SOCK" ]; then
  SOCK_GID="$(stat -c '%g' "$DOCKER_SOCK")"
  if ! getent group "$SOCK_GID" >/dev/null 2>&1; then
    groupadd -g "$SOCK_GID" docker-host
  fi
  SOCK_GROUP="$(getent group "$SOCK_GID" | cut -d: -f1)"
  usermod -aG "$SOCK_GROUP" node
fi

exec gosu node "$@"
