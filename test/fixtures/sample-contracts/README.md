# Sample Contract Fixtures

Small sample Soroban contract source trees used as good-path fixtures for
rebuild/compare testing (e.g. exercising `stellar contract build` and the
byte-for-byte Wasm comparison path against a known-good source tree, as
opposed to the adversarial cases in `../malicious-tarballs/`). The comparison
is the trusted side's own.

Three trees are present, added for the differential harness
(`services/builder/test/differential/fixtures.ts`) — see each tree's own
`README.md` for what it exercises:

- `single-package/`
- `multi-package-workspace/`
- `bldopt-encoding/`
