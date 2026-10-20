# soroban-verification-client

Read Soroban contract source-verification results, in Node and in the browser. The client reads an
aggregator's Query API, or every verifier's result root directly with no service in between, validates
each document it reads, and returns the same shape either way. It is read-only: submitting a contract for
verification goes through a verifier's Submission API.

## Install

```bash
npm install soroban-verification-client
```

| Install | Gets you |
| --- | --- |
| `soroban-verification-client` | The newest stable release, the `latest` tag |
| `soroban-verification-client@staging` | The newest release candidate |
| `soroban-verification-client@dev` | A build of the newest change to the SDK on `main` |
| `soroban-verification-client@0.1.0` | Exactly that version |

`latest` never holds a prerelease. Pin an exact version in anything you ship. Every version is published
by the repository's release workflow with npm provenance, which `npm audit signatures` checks.

## Read a result

```ts
import { newClient, newHostedClient } from "soroban-verification-client";

// One request to an aggregator, which can also look a contract up by its address.
const hosted = newHostedClient({ baseUrl: "https://verifier.example.org" });
const aggregate = await hosted.registry.byContract("mainnet", "C...");
console.log(aggregate.agreement, aggregate.source_code_verifications, aggregate.unavailable_verifiers);

// The same question, asked of each verifier directly.
const client = newClient({ tvl: await hosted.verifiers() });
const direct = await client.registry.byHash(aggregate.wasm_hash);

// Fetch a result's report and check it against its published SHA-256.
const report = direct.source_code_verifications
  .flatMap((entry) => entry.results_urls ?? [])
  .find((link) => typeof link === "object" && link.type === "report");
if (report) console.log((await client.results.verifyUrl(report)).verified);
```

Every answer carries one entry per verifier, each attributed to its verifier, and never a merged verdict:
which verifiers to trust is your decision. A verifier that cannot be read is listed in
`unavailable_verifiers` with a reason, rather than failing the call or being left out.

## Documentation

- [Read a result with the SDK](https://github.com/57blocks/soroban-verification-service/blob/main/clients/docs/src/quick-start/read-with-the-sdk.md),
  the quick start.
- [Use the SDK](https://github.com/57blocks/soroban-verification-service/blob/main/clients/docs/src/integrators/use-the-sdk.md):
  both clients, their options and errors, checking evidence, and the fetch policy.
- [Result documents](https://github.com/57blocks/soroban-verification-service/blob/main/clients/docs/src/api/result-documents.md):
  every field of the documents the SDK returns.

Every deployment of the console also serves this documentation, at `/docs/`.

## Support policy

- **Semantic versioning.** A breaking change to the exported API is a major release. While the version is
  `0.x`, a minor release can break it; the [changelog](https://github.com/57blocks/soroban-verification-service/blob/main/CHANGELOG.md)
  names each break.
- **Runtimes.** Node.js 20 or later, and any browser with WebCrypto in a secure context. Without
  WebCrypto, pass a `hasher` to `verifyUrl` or `fetchAndVerifyResultUrl`.
- **ESM only.** From CommonJS, load it with `await import("soroban-verification-client")`.
- **One copy of the validation libraries.** `class-validator`, `class-transformer` and `reflect-metadata`
  keep their metadata in a module-level singleton. A dependency tree with two copies of one of them turns
  validation into a check that always passes.
- **Supported API.** Only what the package exports. Imports from inside `dist/` are not a contract.

## Development

The SDK is developed in the
[soroban-verification-service](https://github.com/57blocks/soroban-verification-service) repository, in
`clients/sdk`. From a checkout:

```bash
pnpm install
pnpm turbo run build --filter=soroban-verification-client...
pnpm --filter soroban-verification-client run test
pnpm --filter soroban-verification-client run check:packaging
```

`check:packaging` packs the package, checks its exports and types, then installs the tarball outside the
workspace and validates a result through it, so it needs the network. Packages inside the repository depend
on the SDK as `workspace:*`, not on a published version, so they always build against the same commit.

Bugs go in [GitHub issues](https://github.com/57blocks/soroban-verification-service/issues);
vulnerabilities go through the repository's
[security policy](https://github.com/57blocks/soroban-verification-service/blob/main/SECURITY.md).

## License

Apache-2.0.
