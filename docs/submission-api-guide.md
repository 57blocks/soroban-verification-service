# Submission API guide

> **Audience**: a developer calling `verification-svc` directly — submitting a contract for
> verification and tracking it — without going through any UI.
> **Shape authority**: this guide documents the *flow* between routes and the error codes worth having
> a stable reference for. It does **not** reproduce exact request/response fields, because those are
> DTOs that can change and prose describing them goes stale silently when they do. For the exact shape
> of any request or response, use the live route explorer this service already mounts —
> `/api/verification/v1/docs` (Swagger UI) — or the generated `services/verification-svc/openapi.json`
> (`pnpm run generate:openapi`) directly.

## What a submission is

`POST .../v1/verifications` takes a `target` (network + contract ID, or a Wasm hash) and an optional
`manifest` describing the source to rebuild. The manifest's fields:

- `schema` — a fixed version string, `"stellar-submitted-source-verification-manifest-v1"`. Required
  whenever you send a manifest at all.
- `source_sha256` — required: the SHA-256 of the exact source-archive bytes.
- Exactly one of `source_uri` (a URL to fetch the archive from) or `upload_id` (a handle from the
  upload route below), depending on where your source already lives:
  - **Already fetchable from a public URL or repository** — use `source_uri`. Skip the upload route
    entirely.
  - **Private, or not hosted anywhere reachable** — upload it first (below), then use the `upload_id`
    it gives you.
- `is_public` — optional, defaults to **not public**: whether the published record becomes readable by
  anyone rather than just you. Independent of *how* you supplied the source.
- `bldarg` / `bldopt` — optional extra build arguments/flags. Omit both for the SEP-58 default, a plain
  `contract build`.
- `bldimg` — optional, and not needed for a new submission: the build environment is derived from the
  deployed Wasm's own on-chain metadata, not chosen by the submitter. This field exists for older
  clients only.

## The full flow

### 1. Don't know your manifest fields yet? Call preflight first

`POST .../v1/preflight`

Optional, read-only. Given just a target, it tells you what a submission would need — and if the
target has on-chain SEP-58 metadata, its response includes `suggested_manifest`: a manifest already
shaped to drop straight into a submit call's `manifest` field. If `preflight`'s `missing_fields` comes
back empty, `suggested_manifest` is usable as-is; you don't need to call preflight yourself at all,
either — see the next section.

A `not_found` status maps to a 404; anything else preflight can't resolve maps to a 502. Malformed
input (bad network, no target given at all) is a 400.

### 2. If your source isn't already at a public URL: upload it

`POST .../v1/uploads/source`

Body is a raw binary stream (`application/gzip`), not JSON. Format is detected by sniffing file content,
not by trusting the filename extension or the optional `x-filename` header — `.tar.gz`, `.tgz`, and
`.zip` are all accepted regardless of what you name the upload. An archive over the size limit is 413
`source_archive_too_large`.

The response carries an `upload_id` and the `source_sha256` computed from what you sent — **both go
straight into your submit call's `manifest`** (`manifest.upload_id`, `manifest.source_sha256`). The
`upload_id` **expires 30 minutes after upload** — submit before then, or upload again. If submit rejects
an `upload_id` (not found, expired, or a `source_sha256` mismatch against what was actually uploaded),
the fix is a fresh upload and a fresh submit — there's no way to extend or retry the same one.

Skip this route entirely if `manifest.source_uri` already points at your source.

### 3. Submit

`POST .../v1/verifications`

Two different success outcomes, not just one:

- **202 Accepted** — the job is queued for a real rebuild.
- **200 OK, `incomplete`** — you called submit with no `manifest` (or an incomplete one), and the
  server ran preflight internally on your behalf. If everything it needs was inferrable from on-chain
  metadata, it queues the job for you automatically and you'd have seen 202 instead — so if you're
  reading `incomplete`, some field genuinely couldn't be inferred. The response's `missing_fields` (with
  `field_hints` alongside) tells you exactly what to add. **There is no separate completion endpoint** —
  fill in the missing fields and call `POST .../v1/verifications` again with a complete `manifest`.

The response is never cached (`Cache-Control: no-store`) — it names the specific job just created, so
caching it would be caching someone else's job the moment two callers hit the route in sequence.

### 4. Check status

`GET .../v1/verifications/:job_id`

Poll this until the job reaches a terminal state. `job_id` must be a real UUID from a submit response —
anything else is a 400 `invalid_job_id`, not a 404, since a malformed ID was never going to resolve to
any job at all.

### 5. Subscribe instead of polling — SSE

`GET .../v1/verifications/:job_id/events` (`text/event-stream`)

**Each event carries the job's full current status, not a diff.** A client should replace its local
copy of the job's state on every event, never patch it incrementally — there is no lower-frequency
"what changed" event type to consume instead. One event per status transition; the stream ends once the
job reaches a terminal state.

A stream can also end on a non-terminal event carrying `stream_timeout: true`: the connection window
elapsed, or the server could not read the job. Reconnect to keep following it; a browser `EventSource`
does this on its own.

Use this instead of polling whenever your integration can hold an open connection — it's strictly less
work for both sides than a polling loop tight enough to feel responsive.

### 6. Build log — token-gated, expiring

`GET .../v1/verifications/:job_id/log` (and `DELETE` on the same path)

The submit response carries a one-time access token for this job's build log
(`x-build-log-token` on the request). No token, or the wrong one, is 401 `build_log_token_required`.
The token also **expires** — past that point every request is 410 `build_log_expired`, token or not.
`DELETE` is idempotent: deleting a log that's already gone still returns 204.

Keep the token somewhere your own tooling can retrieve it when you need to debug a failed build — it
is not recoverable from the job status response, and once it expires there is no way to re-derive it.

## Error codes worth keeping a reference for

These are stable identifiers across the routes above — the exact response envelope they appear in is
the OpenAPI document's job, not this table's:

| Code | Route | Meaning |
| --- | --- | --- |
| `invalid_job_id` | status, log | The path segment isn't a UUID at all |
| `build_log_token_required` | log | Missing or wrong `x-build-log-token` |
| `build_log_expired` | log | Token was valid once; the log's access window has closed |
| `source_archive_too_large` | upload | Body exceeded the size limit |
| `invalid_manifest` | submit | `manifest.schema` is missing/wrong, `source_sha256` isn't a 64-char hex string, or neither `source_uri` nor `upload_id` was given |
| `source_archive_not_chain_recorded` | submit | The submitted archive's hash disagrees with a `source_sha256` this contract already records on chain |
| `upload_not_found` | submit | `manifest.upload_id` was never uploaded, already expired, or already consumed |
| `upload_expired` | submit | The upload existed but its 30-minute window closed |
| `source_hash_mismatch` | submit | `manifest.source_sha256` doesn't match the hash computed at upload time |
| `rate_limited` | preflight, submit | Abuse-guard quota hit |
| `invalid_network` | preflight, submit | Network isn't a recognised value |
| `invalid_request` | preflight, submit | Neither a contract ID nor a Wasm hash was given |

## End-to-end: two full paths, source already public vs. source uploaded

```bash
# Path A — source is already at a public URL: no upload needed. source_sha256 must be the SHA-256
# of the exact archive bytes source_uri points to — compute it yourself before submitting, e.g.:
#   SOURCE_SHA256=$(curl -sL https://github.com/you/project/archive/refs/heads/main.tar.gz | sha256sum | cut -d' ' -f1)
JOB_ID=$(curl -sX POST https://verify.example.org/api/verification/v1/verifications \
  -H "Content-Type: application/json" \
  -d '{
    "target": {"network":"testnet","contract_id":"'"$CONTRACT_ID"'"},
    "manifest": {
      "schema":"stellar-submitted-source-verification-manifest-v1",
      "source_sha256":"'"$SOURCE_SHA256"'",
      "source_uri":"https://github.com/you/project/archive/refs/heads/main.tar.gz"
    }
  }' | jq -r .job_id)

# Path B — source is private: upload it first, then reference the upload
UPLOAD=$(curl -sX POST https://verify.example.org/api/verification/v1/uploads/source \
  -H "Content-Type: application/gzip" --data-binary @source.tar.gz)
JOB_ID=$(curl -sX POST https://verify.example.org/api/verification/v1/verifications \
  -H "Content-Type: application/json" \
  -d '{
    "target": {"network":"testnet","contract_id":"'"$CONTRACT_ID"'"},
    "manifest": {
      "schema":"stellar-submitted-source-verification-manifest-v1",
      "source_sha256":"'"$(echo "$UPLOAD" | jq -r .source_sha256)"'",
      "upload_id":"'"$(echo "$UPLOAD" | jq -r .upload_id)"'"
    }
  }' | jq -r .job_id)

# Either path from here: wait for a terminal state (SSE is the better choice for real
# integrations; polling shown for brevity)
until curl -s https://verify.example.org/api/verification/v1/verifications/$JOB_ID \
  | jq -e '.status | IN("verified","mismatched","build_failed","cli_failure")' >/dev/null; do
  sleep 5
done

# Read the result — from the verifier's Result Publishing surface, a separate service from
# the submission API above. See docs/reading-the-result-tree.md and
# docs/aggregator-query-api-guide.md for the actual routes.
curl https://results.example.org/wasms/$WASM_HASH.json
```

**Submission and publishing are two different services.** verification-svc (this guide) accepts jobs
and reports their status; it holds no published result of its own to serve. Read the result through
[`docs/reading-the-result-tree.md`](reading-the-result-tree.md) or
[`docs/aggregator-query-api-guide.md`](aggregator-query-api-guide.md) instead.

If you're building anything more than a one-off script, see [`docs/integrator-guide.md`](integrator-guide.md)
for how this fits together with the read side, or [`clients/sdk/README.md`](../clients/sdk/README.md)
for a typed client that covers the read half of this walkthrough.
