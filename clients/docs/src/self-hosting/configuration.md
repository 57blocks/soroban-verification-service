# Configuration reference

Every setting the verifier's services read from their environment, generated from the repository's
`config/env-manifest.yaml`. Each service reads its own settings and the shared settings it names; a
service never reads a setting that is not listed for it.

How to read the tables:

- **Required** says whether the service needs a value. A required setting is checked when the service
  starts, unless the table says otherwise: some are checked only on first use, so a missing value
  shows up as a failing request rather than a failed start, and a few are not checked at all.
- **Default** is the value used when the setting is not given.
- Numbers ending in `_MS` are milliseconds, and `_BYTES` bytes.

<!--@include: ../../.vitepress/generated/configuration.md-->
