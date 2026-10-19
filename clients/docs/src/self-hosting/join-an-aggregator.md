# Join an aggregator

An aggregator reads the verifiers on its **Trusted Verifiers List** and serves their results side by
side. Its operator decides who is on the list: there is no registration, and no verifier can add itself.
To be read by an aggregator, ask its operator, and give them the details below.

## What to give an aggregator's operator

| Field | Value |
| --- | --- |
| `id` | A short identifier; the aggregator's operator may choose their own |
| `display_name` | Your verifier's name |
| `url` | Your result root: exactly your `SCVS_PUBLIC_RESULT_ROOT` |
| `manifest_url` | `<result root>/verifier-manifest.json` |
| `bulk_load_url` | `https://<your API host>/api/verification/v1/wasms` |

All three URLs must be `https:`. The operator adds `status` and, if they like, a `trust_tier` of their
own; you set neither.

## What your verifier must serve

A verifier running this software serves all of it without further setup:

- **Status objects** at `<result root>/wasms/<wasm_hash>.json`, publicly, over HTTPS, without redirects:
  an aggregator does not follow them.
- **Its bulk load** at `/api/verification/v1/wasms`, which tells the aggregator which status objects
  changed.
- **`verifier-manifest.json` and `policy.json`** at the result root, which `orchestrator-svc` publishes
  every time it starts.

An aggregator gives each read 5 seconds by default, and refuses a response over 1 MiB; a status object
is far smaller.

## Keep your result root stable

Your result root is your identity. An aggregator matches each status object to you by the URL in it,
which is your `SCVS_PUBLIC_RESULT_ROOT`, compared as URLs: letter case in the scheme and host, a default
port and trailing slashes do not matter, the path otherwise does. If
the two stop matching, for example because you moved your results, the aggregator treats your results as
withdrawn and drops them as it reads them. Moving means asking every aggregator that reads you to update
its list.

## How an aggregator reads you

- It reads every active verifier on its list about once a minute, up to 200 changes at a time, starting
  from your first result. A long history takes a few minutes to catch up.
- When a read fails, it lists you in `unavailable_verifiers` and keeps serving your results as last read.
  A status object that answers `404` is not a failure: the aggregator withdraws that result.
- Its operator can **pause** you, which stops reading you but keeps your results in its answers, or
  **disable** you, which removes them.

See [Query across verifiers](../integrators/query-across-verifiers.md) for what its users see.

## Running an aggregator

An aggregator's list is loaded into its database by `scripts/seed-tvl.ts`, run after its migrations, from
`SCVS_TRUSTED_VERIFIERS_SOURCE`: a file, or an `https:` URL pinned by its SHA-256 in
`SCVS_TRUSTED_VERIFIERS_SOURCE_SHA256`. Unset, it loads the repository's local development list. The document is a
`stellar-trusted-verifiers-list` with one entry per verifier, using the fields above and `status`.

- An entry is matched to the existing list by `id`, and updated.
- A verifier no longer in the document is **disabled**, not deleted: it stays on the published list, and
  its results are withdrawn.
- A new entry without `status` is `active`. An existing entry without `status` keeps the status it
  already had, so to re-admit a disabled verifier, set `"status": "active"` explicitly.

A new verifier is read from the next minute onwards. The aggregator publishes its list at
`GET /api/query/v1/verifiers`.
