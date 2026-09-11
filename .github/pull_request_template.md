<!-- All four sections are required. "None" is a valid answer; a deleted heading is not.
     See CODE_REVIEW.md. -->

## Summary

<!-- What changed and why. Link the feature docs (docs/features/<feature>/) or the ADR that
     authorizes this behaviour. If neither exists and this is more than a trivial fix, that is
     worth explaining here. -->

## Test plan

<!-- How you verified this, not how someone could. Paste the relevant result.

     Baseline gate:
       pnpm run build && pnpm run typecheck && pnpm run lint && pnpm run test

     Plus whatever is specific to the change. If a test was already failing before your work,
     say so and show the evidence. -->

## Architecture impact

<!-- Boundaries crossed, dependencies added or removed, contracts changed.

     Check specifically:
     - Did any package gain or lose a workspace dependency?
     - Did a DTO move, or gain/lose a field? Did `pnpm run generate:api-client` output change?
     - Did the published artifact or result-tree format change?
     - Does an existing ADR or design doc now describe something untrue? Update it in THIS PR.
     - Does this establish a new pattern, or remove a constraint something else relies on?
       That needs an ADR.

     "None." -->

## Security / data handling impact

<!-- Sensitive surfaces: the sandbox boundary and its dependencies, the trust/image policy, IAM
     roles, the public HTTP surface, DB migrations, credential and presigned-URL handling.

     If this touches the sandbox: did it gain a dependency, a credential, or a decision it should
     not have? See docs/adr/ADR-002-builder-holds-no-business-credentials.md.

     Also: does data already written to Postgres or the result tree still validate after this?

     "None." -->
