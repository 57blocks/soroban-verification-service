#!/bin/sh
# Substitutes runtime configuration into the served index.html at container start.
set -eu

template=/etc/nginx/scvs/index.html.template
target=/usr/share/nginx/html/index.html
placeholder=__SCVS_ENABLE_AGGREGATOR__

# Rendered from the template every start rather than edited in place, so a restarted container substitutes into
# the placeholders again instead of into an already-substituted document.
if [ ! -f "$template" ]; then
  echo "web-entrypoint: $template is missing; the image was built wrong" >&2
  exit 1
fi

# The value is validated below, but the *substitution* needs its own check: `sed` exits 0 when it replaces
# nothing, so a template that lost the placeholder would render a page that silently falls back to whatever the
# bundle was built with.
if ! grep -q "$placeholder" "$template"; then
  echo "web-entrypoint: $template no longer contains $placeholder; the flag would be ignored" >&2
  exit 1
fi

# A malformed value is rejected, never silently treated as off — the same rule the services' env DTOs follow.
case "${SCVS_ENABLE_AGGREGATOR:-}" in
  "" | true | false) ;;
  *)
    echo "web-entrypoint: SCVS_ENABLE_AGGREGATOR must be 'true', 'false' or unset," \
      "got '${SCVS_ENABLE_AGGREGATOR}'" >&2
    exit 1
    ;;
esac

# Written aside and moved into place, so a request arriving mid-render never sees a truncated page.
sed "s|${placeholder}|${SCVS_ENABLE_AGGREGATOR:-}|g" "$template" >"$target.tmp"
mv "$target.tmp" "$target"
