# Interpret multi-verifier results

An aggregate gives you each verifier's answer side by side. Turning those answers into what your
application shows is your decision, and this page is about making it well. The principles behind it are in
[Trust model](../introduction/trust-model.md).

## Decide whose results count

Start from a list of the verifiers you trust, identified by result root: the `verifier.url` of each
entry. Do not identify a verifier by its `name`; anyone can call themselves anything.

The aggregator's own list is a reasonable start, but it is the aggregator operator's choice, and it can
change. If your answer matters, keep your own list.

## Turn the entries into one answer

A rule should look only at verifiers you trust, and treat a conflict as a conflict:

```sh
TRUSTED='["https://results.verifier-a.example","https://results.verifier-b.example"]'

curl -s "$ORIGIN/api/query/v1/contracts/mainnet/$CONTRACT_ID" | jq -r --argjson trusted "$TRUSTED" '
  [.source_code_verifications[] | select(.verifier.url as $u | $trusted | index($u)) | .status] as $s
  | if ($s | index("verified")) and ($s | index("mismatched")) then "disputed"
    elif $s | index("verified") then "verified"
    elif $s | index("mismatched") then "mismatched"
    else "no result" end'
```

You may want a stricter rule: for example, counting only results with
`recipe_source: on_chain_metadata`, where the recipe was fixed on chain before anyone submitted anything,
or requiring two verifiers to agree. What matters is that the rule is yours, written down, and the same
every time.

## What the aggregate's own fields mean

**`agreement`** applies a fixed rule to all the entries, trusted by you or not:

| `agreement` | When |
| --- | --- |
| `no_data` | No verifier has a result |
| `single` | Exactly one verifier has a result, whatever it is |
| `disputed` | At least one `verified` and at least one `mismatched` |
| `unanimous_verified` | Every entry is `verified` |
| `unanimous_mismatched` | Every entry is `mismatched` |
| `unverified_only` | Anything else, such as `verified` alongside an entry with no conclusion |

Use it as a quick summary, not in place of your rule: `single` says nothing about whether that one
verifier is one you trust, or whether it said `verified`.

**`status`** on an entry is `verified` or `mismatched`. `unverified` means the verifier gave no conclusion
the aggregator recognises; treat it as no result.

## Disputes

A `disputed` Wasm has been verified by one verifier and has a mismatch from another. That usually means
they rebuilt different source, or ran under different policies, not that one of them is broken: each
verdict is about the source submitted to that verifier. Show both, with who said what, and link each
report. A verifier never lets a later mismatch replace its own `verified`, so a dispute is always between
verifiers.

## Verifiers that could not be read

`unavailable_verifiers` names the verifiers the aggregator failed to read on its latest attempt. It is the
same list in every response, whatever the Wasm. Their entries are still served, as last read; if the
answer matters, say that a verifier could not be reached.

A verifier missing from the entries has no result the aggregator has read for this Wasm. The aggregator
may simply not have reached it yet; to be sure, ask the verifier itself. A verifier the aggregator has
paused keeps its last results in the answer without being read again; a disabled one disappears from it.

## Showing a result to people

- **Name the verifier.** "Verified by Example Verifier", linked to the report, not a bare "verified". No
  result is the network's verdict.
- **Show the strength.** A result whose recipe came from the chain, built in an official image, says more
  than one built from a recipe the submitter supplied; see the two fields in
  [Trust model](../introduction/trust-model.md#what-each-result-tells-you-about-itself).
- **Re-check after an upgrade.** Look contracts up by address each time, or follow the Wasm they run: a
  verified Wasm says nothing about the next one.
- **Let people check.** Every report is a static file with its SHA-256 beside it; see
  [Read the result tree directly](./read-the-result-tree.md#checking-what-you-read).
