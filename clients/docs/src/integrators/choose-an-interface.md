<script setup>
import { sdkReadmeUrl } from "../../../web/src/config/site.ts";
</script>

# Choose an interface

You can read verification results three ways, and submit them one way. They differ in how much they
do for you and what they ask you to depend on.

| You want to | Use | Depends on |
| --- | --- | --- |
| Show what several verifiers say about a contract or a Wasm | The **Query API** of an aggregator: [Query across verifiers](./query-across-verifiers.md) | The aggregator being up |
| Read one verifier's results with no service in between | The verifier's **result tree**, static files over HTTPS: [Read the result tree directly](./read-the-result-tree.md) | Only the files being reachable |
| Read results from TypeScript or JavaScript | The `soroban-verification-client` SDK on npm, which reads both of the above | Whichever of the two it reads |
| Submit a contract and follow its job | The **Submission API**: [Submit a contract with curl](../quick-start/submit-with-curl.md), [Verify from CI](../developers/verify-from-ci.md) | The verifier you submit to |

## Reading

**Start with the Query API** if your application shows verification status to people, for example a
wallet, an explorer or a dashboard. One request answers for every verifier the aggregator reads, and it
can look a contract up by its address. Interpreting the answer is still your job; see
[Interpret multi-verifier results](./interpret-multi-verifier-results.md).

**Read the result tree** when you trust one or a few specific verifiers, want no dependency on anyone's
API, or want to check results yourself rather than through someone else's summary. It is what an
aggregator itself reads.

**The SDK** wraps both, and validates the documents it reads. It is a read-only client, installed with
`npm install soroban-verification-client`. Its <a :href="sdkReadmeUrl">README</a> covers reading
verifiers directly and through an aggregator.

## Submitting

Submission is a separate interface, on the verifier rather than the aggregator: the verifier that
rebuilds the contract is the one that publishes the result. See the
[contract developer guides](../developers/make-your-contract-verifiable.md).

A result appears in the Query API only after the aggregator next reads the verifier that published it,
so follow the job's status to know the moment it has finished.

## What every interface has in common

- **No account and no key.** Reading and submitting are open; rate limits stand in for authentication.
- **Results are keyed by Wasm hash.** A contract address is resolved to the Wasm it runs now. After an
  upgrade it runs a different Wasm, with its own results, or none.
- **Every result names its verifier.** Nothing in any interface is a verdict on behalf of the network;
  see [Trust model](../introduction/trust-model.md).
