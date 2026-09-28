#!/bin/sh
set -eu

template=/etc/nginx/scvs/index.html.template
target=/usr/share/nginx/html/index.html
placeholder=__SCVS_ENABLE_AGGREGATOR__

if [ ! -f "$template" ]; then
  echo "web-entrypoint: $template is missing; the image was built wrong" >&2
  exit 1
fi

# `sed` exits 0 when it replaces nothing, so a lost placeholder must be caught here.
if ! grep -q "$placeholder" "$template"; then
  echo "web-entrypoint: $template no longer contains $placeholder; the flag would be ignored" >&2
  exit 1
fi

case "${SCVS_ENABLE_AGGREGATOR:-}" in
  "" | true | false) ;;
  *)
    echo "web-entrypoint: SCVS_ENABLE_AGGREGATOR must be 'true', 'false' or unset," \
      "got '${SCVS_ENABLE_AGGREGATOR}'" >&2
    exit 1
    ;;
esac

# Written aside and moved into place, so a request mid-render never sees a truncated page.
sed "s|${placeholder}|${SCVS_ENABLE_AGGREGATOR:-}|g" "$template" >"$target.tmp"
mv "$target.tmp" "$target"
