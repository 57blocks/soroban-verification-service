#!/bin/sh
# Starts as root (needed to inspect/chgrp the mounted docker.sock and to run gosu), then execs the real Node
# entrypoint as UID/GID 1000 (node:24-slim's built-in `node` user) before doing anything else.
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
