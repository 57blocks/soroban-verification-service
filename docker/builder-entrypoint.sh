#!/bin/sh
set -e

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
