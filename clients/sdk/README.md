# TypeScript SDK

Read and aggregate Soroban contract source-verification results across verifiers, in Node **and** in
the browser, with **no hosted API required**. Where a hosted Public Query API *is* available, the same
questions can be asked of it instead — the answer has the same shape, so nothing that reads one changes
(TRD §8.3). It is a query client, not a submission client: writing to a verifier is done through a
client generated from the published OpenAPI specification.

## Two ways to read: peer-direct or hosted

Every question below can be asked either way — the answer has the same shape either way
(`AggregatedWasmStatus`, what `AggregateReader` names), so picking one is a constructor choice, not a
branch you write into your own code:

| | `newClient` (peer-direct) | `newHostedClient` (hosted) |
| :--- | :--- | :--- |
| What it does | Fans out to every verifier's own result root yourself | Reads one deployment's already-assembled aggregate over HTTP |
| Needs a hosted API | No | Yes |
| Query by contract address | No — needs a ledger read the browser can't do | Yes, `byContract` |
| Cost per query | One request per verifier | One request, period |
| Survives a slow verifier | No — that verifier's entry is just slow or unavailable | Yes — the aggregator already absorbed that |

A hosted read can also seed a peer-direct client: `newClient({ tvl: await hosted.verifiers() })` takes
the hosted list you just fetched and lets you fan out yourself from there.

### Peer-direct: `newClient`

The SDK takes the Trusted Verifiers List **as data**. Loading it — from a URL, a file, a database, a
config bundle — is the caller's job, because only the caller knows where theirs lives and what timeout,
retry and error handling it wants.

**Shape of the document `tvl` must be:**

```json
{
  "schema": "stellar-trusted-verifiers-list",
  "verifiers": [
    {
      "id": "local-verifier",
      "display_name": "Local Soroban Verifier",
      "url": "http://localhost:5000/public",
      "manifest_url": "http://localhost:5000/public/verifier-manifest.json",
      "bulk_load_url": "http://localhost:5000/api/verification/v1/wasms",
      "trust_tier": "local",
      "status": "active"
    }
  ],
  "updated_at": "2026-07-01T00:00:00.000Z"
}
```

- `schema` — required, either `"stellar-trusted-verifiers-list"` or the older
  `"stellar-trusted-verifiers-list-v1"`; both are accepted.
- `schema_version` — optional here (this package tolerates its absence), though the published Results
  SEP schema lists it as required on a conformant document — include it (`"1.0"`) if you're publishing
  one, not just consuming one.
- `verifiers` — required array. Each entry, per the published schema
  (`stellar-trusted-verifiers-list-1.0.schema.json`):
  - `url` — required: the verifier's result root, and this entry's real identity.
  - `manifest_url` — **optional**: where that verifier publishes its own self-description
    (`verifier-manifest.json`). The Results SEP does not define that document, and **nothing the SEP
    specifies is read out of it** — `byHash`, `statusObject` and `bulkLoad` never fetch it, so an entry
    without one is a conformance class rather than a broken entry. `discover()` is the exception, and it
    is an extension beyond the SEP: it expects this project's own `stellar-verifier-manifest-v1` shape
    and follows that document's `policy_url` to a `stellar-verifier-policy-v1`. An entry with no
    `manifest_url` reports `not_advertised` there and is unaffected everywhere else.
  - `status` — required: `"active"`, `"paused"`, or `"disabled"`.
  - `id` — **optional**, and implementation-local: it's a key for whoever wrote this list to key their
    own storage by, not identity — `url` is. Don't rely on it meaning anything outside this document.
  - `display_name` — optional: the label to show a user. Fall back to `url`, not to `id` — that is
    optional too.
  - `bulk_load_url` — **optional**. Only needed if you want to call `registry.bulkLoad()` against this
    verifier; a verifier that doesn't serve one is still fully usable for `byHash`/`statusObject`. See
    [`../../docs/verifier-onboarding.md`](../../docs/verifier-onboarding.md) for what publishing one
    means from the verifier's side.
  - `trust_tier` — optional: your own free-form label (e.g. `"local"`, `"primary"`, `"community"`).
    Nothing in this package interprets its value.
- `updated_at` — required: an ISO 8601 timestamp for this document.

A local-development example with a single self-hosted verifier is
[`config/trusted-verifiers.local.json`](../../config/trusted-verifiers.local.json) at the repository
root — the JSON above is that file's `verifiers` entry.

```ts
import { newClient } from "soroban-verification-client";

const tvl = await fetch("https://example.com/trusted-verifiers.json").then((r) => r.json());
const client = newClient({ tvl });

// "Does any trusted verifier vouch for these bytes?" — no network parameter: a wasm hash is a
// function of the bytes alone, so a verdict is not chain-scoped (docs/invariants.md rule 12).
const byHash = await client.registry.byHash("9f2c1a7b…");

// One named verifier's own document, unaggregated.
const theirs = await client.registry.statusObject(client.verifiers[0], "9f2c1a7b…");

// One page of a verifier's own bulk-load stream. `bulk_load_url` is optional, so pick a member that
// declares one rather than assuming the first does — `bulkLoad` throws on a member that doesn't. See
// ../../docs/verifier-onboarding.md for what publishing one means for a verifier.
const enumerable = client.verifiers.find((verifier) => verifier.bulk_load_url !== undefined);
const page = enumerable ? await client.registry.bulkLoad(enumerable, { limit: 100 }) : undefined;
```

Every response carries **one attributed entry per verifier**, never a merged verdict. Disagreement
between verifiers is a legitimate outcome, not an inconsistency for the SDK to resolve: a consumer that
wants a single answer applies its own rule to the list, because only it knows which verifiers it trusts.

**An unreachable verifier is never silently omitted.** It comes back in `unavailable_verifiers` with a
`reason` of `fetch_failed`, `invalid_response`, `timeout`, or `refused`. A query never rejects because
one verifier failed.

If the list carries relative references, pass `baseUrl` — the absolute base they resolve against.

`client.discover()` resolves every listed verifier's manifest and policy documents in one call — useful
for showing a user which verifiers are actually reachable and what each one's trust policy declares,
rather than only their raw TVL entries. It answers **one outcome per member, in the list's own order,
and never rejects**: one verifier's dead manifest host cannot fail the others. Switch on `outcome`:

- `"available"` — `manifest` and `policy` are both present and both parsed.
- `"not_advertised"` — the entry names no `manifest_url`. Nothing is wrong and nothing was fetched.
- `"unavailable"` — a `manifest_url` was advertised but the manifest or the `policy_url` it names could
  not be read. `reason` uses the same vocabulary as `unavailable_verifiers` (`fetch_failed`,
  `invalid_response`, `timeout`, `refused`) and `error` carries the detail.

The three are deliberately distinct rather than one absent `manifest`: "publishes nothing" and "is
down" are different facts about a verifier, and only the second is a problem.

**Validation strictness is a per-call option.** `statusObject` and `byHash` both take
`{ validation: "default" | "strict-base" }`. `"default"` (the implicit choice) tolerates a peer document
carrying fields beyond the published 1.0 schema — real documents from an actively developed peer often
do. `"strict-base"` projects the document down to the base schema before validating, dropping unknown
fields rather than accepting them; reach for it if your own code must never see a field it doesn't
already know about.

### Hosted: `newHostedClient`

`newHostedClient` reads one deployment's aggregate over HTTP rather than fanning out to every verifier
directly. Use it when you want the answer an aggregator has already assembled — it is one request
instead of one per verifier, it survives a verifier being slow, and it is the only way to ask **by
contract address**, which needs a ledger read the browser cannot do.

```ts
import { newHostedClient } from "soroban-verification-client";

// Absolute anywhere; `""` — same origin as this page — only in a browser, which resolves it.
const hosted = newHostedClient({ baseUrl: "https://dev.sv.example.com" });

const byHash = await hosted.registry.byHash("9f2c1a7b…");
const byContract = await hosted.registry.byContract("testnet", "CA…");
// The Trusted Verifiers List that aggregate was assembled from — and the object `newClient` takes,
// so a hosted read can seed a client-side one.
const client = newClient({ tvl: await hosted.verifiers() });
```

**A hosted answer is a peer's document.** It is validated as one: any MINOR of the MAJOR this package
reads is accepted, an `agreement` or an unavailability `reason` added after us rides along rather than
failing the response, and a body that is not an aggregate at all is refused rather than dereferenced.

Every method throws `QueryApiError` and nothing else. `error.failure` carries `{ status, code, message }`:
`code` is the service's own where it declared one (`invalid_contract_id`, `contract_not_found`,
`address_resolution_failed`, …) and otherwise this client's — `unreachable`, `timeout`, `refused`,
`response_too_large`, `invalid_response`, `http_<status>`. `queryApiFailureOf(error)` gives a caller's
error path one shape to read.

| The endpoint is yours, so the policy differs from the peer one above | |
| :--- | :--- |
| Scheme and origin are pinned to the base URL's own | Any redirect is refused by default, same as the peer client — pass `policy: { followRedirects: true }` to allow one, checked against this origin on its final URL |
| Private ranges are **not** blocked | The guard exists for a URL a peer chose; here it would only refuse a localhost API |
| The 1 MiB cap and the 5 s cancelling timeout still apply | `maxResponseBytes`, `timeoutMs` |

## Fetching a `results_urls` artifact

A status object may point at reports, provenance documents or SBOMs. Those bytes are **untrusted
input**, and this package treats them as such: it verifies them against the `sha256` the status object
declares, returns them raw, and never parses, renders, follows or trusts them over the status object
itself.

```ts
import { fetchAndVerifyResultUrl } from "soroban-verification-client";

const artifact = await fetchAndVerifyResultUrl({
  type: "report",
  url: "https://verify.example.com/reports/abc.json",
  sha256: "…",
});
// artifact.verified === true; artifact.bytes are the exact published bytes; artifact.origin is where
// they actually came from, after redirects.
```

An entry with **no** `sha256` cannot be verified, so it is refused. Pass `allowUnverified: true` to
fetch it anyway — the result is then `verified: false`, so the decision stays visible in your code.

**If you show a user a link to one of these destinations, show them the destination first.** The SDK
returns `origin` and the full URL precisely so you can build that interstitial; it never navigates on
your behalf.

**Calling this from a server needs a sandbox.** You are fetching a URL a third party chose. The fetch
policy below bounds it, but a portable `fetch` wrapper cannot pin DNS resolution, so an
egress-controlled worker or a network policy is the real boundary.

## The fetch policy

Every request the client makes — verifier manifests, result indexes, `results_urls` artifacts — passes a
policy first. The defaults are strict on purpose, because a peer's manifest decides which URLs get
requested next:

| Default | Opt out with |
| :--- | :--- |
| `https:` only | `allowedSchemes: ["https:", "http:"]` |
| Origins pinned to the ones the TVL names | `allowedOrigins: []` |
| Private, loopback and link-local IP literals refused | `blockPrivateRanges: false` |
| 1 MiB response cap, enforced by a running byte count | `maxResponseBytes` |
| 5 s timeout that **cancels** the request | `timeoutMs` (must be positive) |
| Any redirect refused outright | `followRedirects: true` |

Redirects are off by default everywhere in this package — a redirect response fails the request rather
than being followed. Opt in with `followRedirects: true` when you need one followed, and only then does
the final URL get checked against the origin allowlist above.

```ts
// A local development root, with both relaxations named rather than implied.
const client = newClient({
  tvl,
  policy: { allowedSchemes: ["http:"], blockPrivateRanges: false },
});
```

## Support policy

- **Semantic versioning.** A breaking change to the exported surface is a major. While the package is
  at `0.x`, semver permits breaking changes in a minor; the changelog names each one rather than
  leaning on that permission.
- **Runtimes.** Node **>= 20** (`crypto.subtle` and `AbortSignal.timeout` are the constraint), and any
  browser with WebCrypto in a secure context. An insecure browser context has no `crypto.subtle`: pass
  `options.hasher` to `fetchAndVerifyResultUrl` — `clients/web`'s `format.util.ts` shows the
  `@noble/hashes` fallback shape.
- **ESM only.** The whole repository is `"type": "module"`. A CommonJS consumer needs a dynamic
  `import()`. A dual CJS/ESM build is deliberately not shipped: two module instances of a
  decorator-metadata library are how validation silently starts passing everything.
- **One copy of the validation libraries.** `class-validator`, `class-transformer` and
  `reflect-metadata` are real dependencies, and a consumer's tree must resolve exactly **one** physical
  copy of each. Their metadata lives in a module-level singleton; a duplicate turns validation into a
  no-op that reports success.
- **Supported surface.** Only what `src/index.ts` exports. Deep imports into `dist/` are not a contract.

## Development

```bash
pnpm --filter soroban-verification-client run build              # tsup for the JS bundle, then API Extractor rolls up
                                               # the declarations (tsup's own dts pass can't — see
                                               # tsup.config.ts)
pnpm --filter soroban-verification-client run typecheck          # tsc --noEmit over src/ and test/
pnpm --filter soroban-verification-client run test               # the four suites below
pnpm --filter soroban-verification-client run check:packaging    # publint + are-the-types-wrong over a real pack,
                                               # then install the tarball outside the workspace and
                                               # aggregate through it (needs the network)
```

| Suite | What it exists to catch |
| :--- | :--- |
| `test/sdk-test.ts` | Aggregation over the fixture tree, relative templates over **real HTTP**, TVL validation, the fetch policy, `results_urls` verification, and that aggregation never fetches an artifact by itself |
| `test/hosted-test.ts` | The hosted mode over **real HTTP**: the three routes, a hosted list seeding a client-side client, a subject that cannot leave its path segment, declared vs synthesised failures, a 200 that is not an answer, `schema_version` tolerance, and that a redirect does not lift the origin pin |
| `test/registry-read-test.ts` | The Registry API read surface: the draft's own worked examples, each validation mode, and honest degradation when a peer is unreachable |
| `test/browser-graph-test.ts` | Walks the built module graph and **names** any file reaching a `node:` builtin or a Nest package |
| `test/browser-bundle-test.ts` | Asserts the bundle imports exactly its declared dependencies and kept its decorator metadata, then bundles the published output for `--platform=browser` and **executes** it against the fixtures — "runs in a browser", not "resolves in a browser" |

Why the package is bundled rather than shipped as plain `tsc` output, and why the validation libraries
are excluded from that bundle: [`tsup.config.ts`](tsup.config.ts).

## Installing

```bash
npm install soroban-verification-client
```

> **Not published yet.** The first version goes out when this repository becomes public: a release is
> published through npm's trusted publishing, which stamps provenance, and provenance can only be
> verified against a source anyone can read. Until then every release run builds and checks the tarball
> and stops before the registry. Build from source in the meantime — see [CONTRIBUTING.md](../../CONTRIBUTING.md).

Published to the public npm registry, with build provenance: the registry records which workflow run
in which repository produced each version, and `npm audit signatures` verifies it. Nothing to
configure, no registry to point at, no credential.

Then pick a **channel**. The git ref decides it: `main` publishes a prerelease, a tag publishes a
release, and `latest` never resolves to a prerelease.

| Install | Gets you | Published by |
| --- | --- | --- |
| `npm install soroban-verification-client` | newest stable — the `latest` dist-tag | a `vX.Y.Z` tag |
| `npm install soroban-verification-client@staging` | newest release candidate | a `vX.Y.Z-rc.N` tag |
| `npm install soroban-verification-client@dev` | newest build off `main` | every merge that touches the SDK |
| `npm install soroban-verification-client@0.1.2` | exactly that version | — |

Either tag channel can also be cut from the Actions tab without a terminal: run the `release` workflow and
set `version` to `v0.1.2` (stable) or `v0.1.2-rc.1` (staging). The run pins the tag to `main`'s HEAD, runs
the same ancestor check a pushed tag would, and creates the real tag and GitHub release. Leave `version`
empty to hand-mint a `dev` prerelease. Set `commit` as well to release a commit other than `main`'s HEAD —
it still has to be an ancestor of `main`, and the stamp, the tag and the provenance check all follow it.

`@dev` and `@staging` are also **checked against the environments they serve**. Every deploy compares the
commit its running image was built from against the commit behind that environment's dist-tag, and fails on
`staging` when the two differ in anything the tarball is built from — printing the one `release` dispatch
that repairs it. So a `staging` install matching what `staging` runs is a gate, not a habit.

`latest` **never** holds a prerelease: the release workflow reads both dist-tags back after every publish
and fails if it does, so a plain `npm install soroban-verification-client` cannot handoff a `dev` build. That check is what
makes the table above a guarantee rather than a convention.

Pin an exact version in anything you ship. `@dev` and `@staging` move on every qualifying merge and are
for trying a change before it is released, not for depending on.

A version is **immutable** — npm never replaces one, so a fix ships as a new version. `0.0.0` only
reserves the package name and contains no code; the first release is `0.1.0`.

Consumers inside this monorepo (`clients/web`, `services/query-svc`) depend on `workspace:*` instead, and
should keep doing so: they need the types from the same commit, and a pinned published version would be a
second number to bump with a silent failure mode when nobody does.
