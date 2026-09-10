# Testnet E2E Fixture

This fixture documents a real testnet verification path for the M1 verifier.
It is intentionally kept as a manual e2e because it depends on Stellar testnet
and Docker. The rebuild runs on the service's own restricted direct-build path,
with the trusted side hashing the rebuilt Wasm itself, so a released Stellar CLI
is sufficient.

## Fixture

- Network: `testnet`
- Contract ID: `CAIDEXLNHK7WF2OC4CZ5Y3FHA5WNMAGIYSFKGKAUHVBGDVAZ2EQJTKEG`
- Source archive:
  `https://raw.githubusercontent.com/jia57b/soroban-contract/main/ecf4bc7db300358330af9bc1a272267f1c870a849b68db0f768bcea4b6078533.tar.gz`
- Source SHA-256:
  `ecf4bc7db300358330af9bc1a272267f1c870a849b68db0f768bcea4b6078533`
- Build image:
  `docker.io/stellar/stellar-cli@sha256:cddfdee493f09feb3a52f1a7d185fc0c9391d841422cbcbd9cde0a4293e9ab43`
- Build options:
  `--locked --manifest-path=contracts/verified-demo/Cargo.toml --package=verified-demo --optimize`

The source archive was produced by the verifiable build flow and is committed
as a downloadable raw GitHub asset in the sample contract repository; its bytes
are what `source_sha256` above describes. That sentence is the only record of
where these bytes came from, so it stays. Do not use the GitHub `blob` page URL;
the verifier must fetch the archive bytes.

## Start Services

From the repository root:

```bash
STELLAR_CLI_PATH=/path/to/stellar \
SCVS_CLI_TIMEOUT_MS=900000 \
PORT=5000 \
pnpm run dev:verification-svc
```

In another terminal:

```bash
VITE_VERIFY_API_URL=http://localhost:5000 npm run dev:web
```

Open `http://localhost:5173/verify`.

## Console Flow

1. Enter the contract ID above and select `testnet`.
2. Click prepare/preflight.
3. If the page asks for missing information, fill the fields from the fixture.
4. Submit the job.
5. Open the job page and wait for a terminal status.

Expected result:

```text
status_summary = verified
verification_path = metadata_backed
evidence_source = wasm_metadata
matched = true
```

## API Flow

Submit the manifest directly:

```bash
curl -sS http://localhost:5000/v1/verifications \
  -H 'content-type: application/json' \
  --data @test/e2e/testnet/metadata-backed-submit.json
```

Poll the returned job:

```bash
curl -sS http://localhost:5000/v1/verifications/<job_id>
```

## Notes

- Docker must be running.
- The first run may take several minutes because Docker pulls the build image
  and Cargo downloads dependencies inside the verification environment.
- A `source_hash_mismatch` means the archive bytes do not match the fixture
  hash. Re-check that the raw archive URL is used.
- A `mismatch` means the rebuild completed but the rebuilt Wasm differs from
  the deployed Wasm. The job page should show mismatch diagnostics.
