# Verify from CI

Verification needs no account and no key, so a pipeline can submit a contract the way a person does, over
HTTP. There is no separate CLI: the script below calls the API with `curl` (7.76 or later) and `jq`,
waits for the verdict, and fails the step unless the contract is verified.

## The script

It checks the contract, uploads the source archive, submits, and polls until the job settles:

```sh
#!/usr/bin/env bash
# Usage: ORIGIN=… NETWORK=mainnet CONTRACT_ID=C… ARCHIVE=my-contract.tar.gz [DRY_RUN=true] ./verify.sh
set -euo pipefail
: "${ORIGIN:?}" "${NETWORK:?}" "${CONTRACT_ID:?}" "${ARCHIVE:?}"
API="$ORIGIN/api/verification/v1"

# Prints the response; on an HTTP error, prints the error body and fails.
call() { local out; out=$(curl -s --fail-with-body "$@") || { echo "$out" >&2; return 1; }; echo "$out"; }
post() { call -X POST "$API/$1" "${@:2}"; }
words() { jq -c --arg k "$1" '.available_fields[$k] // "" | split(" ") | map(select(. != ""))' <<<"$PREFLIGHT"; }

PREFLIGHT=$(post preflight -H 'Content-Type: application/json' \
  -d "$(jq -n --arg n "$NETWORK" --arg c "$CONTRACT_ID" '{network: $n, contract_id: $c}')")
case "$(jq -r .build_environment.kind <<<"$PREFLIGHT")" in
  chain_named|compose) ;;
  *) jq . <<<"$PREFLIGHT"; echo "This verifier cannot rebuild the contract." >&2; exit 1 ;;
esac

UPLOAD=$(post uploads/source -H 'Content-Type: application/octet-stream' --data-binary "@$ARCHIVE")
TERMS=$(call "$API/legal" | jq -r .version)

SUBMITTED=$(post verifications -H 'Content-Type: application/json' -d "$(jq -n \
  --arg n "$NETWORK" --arg c "$CONTRACT_ID" --arg t "$TERMS" --argjson u "$UPLOAD" \
  --argjson opt "${BLDOPT:-$(words bldopt)}" --argjson arg "${BLDARG:-$(words bldarg)}" \
  --argjson dry "${DRY_RUN:-false}" '{
    target: {network: $n, contract_id: $c},
    manifest: ({schema: "stellar-submitted-source-verification-manifest-v1",
                upload_id: $u.upload_id, source_sha256: $u.source_sha256, bldopt: $opt}
               + if $arg == [] then {} else {bldarg: $arg} end),
    accepted_terms_version: $t,
    dry_run: $dry
  }')")

JOB_ID=$(jq -r .job_id <<<"$SUBMITTED")
jq -r '.build_log_token // empty' <<<"$SUBMITTED" > build-log-token.txt
echo "Job: $ORIGIN/verify/jobs/$JOB_ID"

failed_at=""
while :; do
  JOB=$(call "$API/verifications/$JOB_ID")
  STATUS=$(jq -r .status <<<"$JOB")
  case "$STATUS" in
    queued|running) failed_at=""; sleep 15 ;;
    # A timeout or a fault on the verifier's side is retried: wait to see whether the job is re-queued.
    build_failed) failed_at=${failed_at:-$SECONDS}; (( SECONDS - failed_at < 180 )) || break; sleep 15 ;;
    *) break ;;
  esac
done

jq '{status, error, reason: .result.reason, detail: .result.detail}' <<<"$JOB"
[ "$STATUS" = verified ]
```

The build options and arguments come from the contract's own metadata. For a contract that records
none, as a contract without a recorded image usually does, set them as JSON arrays, for example
`BLDOPT='["--manifest-path=contracts/token/Cargo.toml","--package=token","--optimize"]'`.

`ARCHIVE` has to be the archive the deployed Wasm was built from. Keep that file, as a release asset for
example; an archive regenerated in CI will usually hash differently. To fetch the source from a URL
instead of uploading it, see [Prepare your source](./prepare-your-source.md#handing-it-over).

The job link it prints opens the job in the console, for anyone.

### In GitHub Actions

```yaml
name: Verify contract
on:
  release:
    types: [published]
jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
      - run: gh release download "$TAG" --pattern 'my-contract.tar.gz'
        env:
          GH_TOKEN: ${{ github.token }}
          TAG: ${{ github.event.release.tag_name }}
      - run: ./scripts/verify.sh
        env:
          ORIGIN: https://verifier.example.org
          NETWORK: mainnet
          CONTRACT_ID: ${{ vars.CONTRACT_ID }}
          ARCHIVE: my-contract.tar.gz
```

## Try it first with a dry run

`DRY_RUN=true` sends `dry_run: true`. The job builds and compares as usual, and the verdict comes back to
you only: nothing is published. Run it before the contract is final, or on every change, to learn early
whether the source and options reproduce the Wasm. A dry run still compares against a deployed
contract, so before a mainnet release, deploy the same Wasm to testnet and dry-run that.

## How long it takes

Usually minutes, longer when the verifier first has to compose a build environment for a contract
without a recorded image. A build step that runs past the verifier's time limit, 10 minutes by default,
fails, and is retried automatically, as is a failure on the verifier's side: the job shows
`build_failed`, then returns to `queued`. The script waits three minutes before it takes `build_failed`
as final. Give the CI job room for retries: 45 minutes is ample.

Polling the job's status costs nothing against your rate limits. To follow it as it happens instead,
read the [event stream](../api/events.md).

## Rate limits

Limits are counted per caller address, per route, in fixed one-minute windows. By default:

| Route | Per minute |
| --- | --- |
| Submit | 6 |
| Upload | 6 |
| Preflight, build log | 18 |
| Opening an event stream | 12 |
| Job status | Not limited |

A request over a limit answers `429` with `rate_limited`, and no `Retry-After`: wait for the next
minute. On shared CI runners, other pipelines may share your address and your limit. A verifier can set
other limits; see [Rate limits](../api/index.md#rate-limits).

## Submitting twice

- **While a job for the same Wasm and the same archive is still queued or running**, with the same
  `dry_run` and `is_public`, the verifier returns that job, with `202` and its `job_id`, instead of
  starting another. The response carries no
  `build_log_token`: the log belongs to the submission that created the job. The script above still
  follows the job to its verdict.
- **After a job has finished**, an identical submission starts a new job, which usually reuses the
  earlier rebuild instead of building again.

## Terms of Service

When the verifier's terms are in force, each submission must name the version it accepts, in
`accepted_terms_version`; the script reads the current version from `GET /api/verification/v1/legal`. A
pipeline that submits accepts those terms on behalf of whoever runs it, so read them first:
<a href="/terms">Terms of Service</a>. A version that is not the current one is refused with
`terms_version_outdated`, so a pinned version starts failing when the terms change.

## The build log

The submission returns a `build_log_token`, the only key to the job's build log, and the script saves it
to `build-log-token.txt`. Keep it as a private artifact, not in public output; it is not shown again. The
log is redacted of credentials and local paths, and expires after a retention period, seven days by
default.

```sh
curl -s "$ORIGIN/api/verification/v1/verifications/$JOB_ID/log" \
  -H "X-Build-Log-Token: $(cat build-log-token.txt)"
```
