# ADR-017: Compose once, cache by digest in a private registry, publish the recipe regardless

> **Status**: Accepted 2026-08-05 · promoted from
> `docs/features/build-environments/decisions/compose-once-cache-in-private-registry.md`,
> which carried it as `Proposed` and specified this promotion on acceptance.
> **Authority**: TRD §10 item 13 (resolution/durability) and, for placement, item 12; IMPLEMENTATION-SPEC
> §B.4 (TD1–TD3), §B.5 (CE1–CE5)
> **Changes**: the Batch contract for cli-legacy dispatch; the immutable-identity field `Rebuild`/`Job`
> key on ([ADR-008](ADR-008-rebuild-and-verdict-are-separate-entities.md)); a new compute environment,
> job queue, IAM role and ECR repository in the infrastructure contract
> ([ADR-006](ADR-006-terraform-owns-aws-infrastructure.md))
> **Depends on**: whichever mechanism
> `infra-and-ops`
> settles for CE1/CE4 — this ADR does not re-litigate it, it only extends that mechanism's scope to a
> second fleet. **That decision is still open; see "Outstanding" at the foot of this document for what
> that leaves unresolved.**
> **Scope**: how a recorded `(cliver, rsver)` pair is resolved into a materialized, durable build
> environment (TD1/TD2); how that environment crosses from the trusted composition worker to the
> isolated builder worker; what identifies it in the rebuild key and in the published result.

## Context

`build-environments/plan.md` §2.1 lists six questions a repo-level decision must answer before the
`BuildEnvironmentResolver`/`Materializer` seams it sketches (§3.2) can be implemented, and states
they cross service boundaries too far for this feature to answer alone:

1. Is a materialized environment reused across rebuilds, or single-use?
2. What immutable value identifies the environment actually used?
3. How does the rebuild obtain the materialized bytes across isolated workers?
4. How long does any staging copy live, and what recovers/cleans it?
5. Is TD2 met by mirroring artifacts, or by the published component recipe?
6. Which component verifies the observed digest and component checksums?

Three facts constrain the answer:

- **Demand is concentrated, not uniform.** The 2026-07-30 corpus scan: the top 5 `(cliver, rsver)`
  pairs cover 50% of live class-B contracts (813, 326, 240, 150, 145 contracts respectively); the
  long tail's ~50 remaining pairs each serve one or two. Composing fresh on every verification means
  redoing the same network fetch and Docker build hundreds of times for the popular pairs, for no
  security benefit — composition's inputs are chain-derived and official-only regardless of whether
  the result is cached (ADR-009 constraint 1 doesn't get weaker or stronger either way).
- **Today's mechanism already crosses isolated workers by digest-pinned registry pull, for cli-58.**
  `BatchJobParams.image_digest` / `Job.imageDigest` / `Rebuild.imageDigest` are plain strings the
  orchestrator hands to Batch, and the builder pulls them like any other digest-pinned reference. This
  is a solved, already-deployed transport. Inventing a bundle format or a remote-builder RPC to move
  environment bytes around solves a problem that a second OCI repository does not have.
- **ADR-009 constraint 4 forbids a *shared, multi-verifier* registry, not a private one.** "Publish
  prebuilt environments — a registry the verifier operates" is one of the two conforming shapes
  `design/build-environments.md` §6 names for TD1. A private cache this verifier alone writes to and
  reads from is not the trust hazard constraint 4 targets (anyone who can push to a registry *others*
  trust by name); it is closer to the object storage the rebuild pipeline already writes artifacts to.

## Decision

**Compose an environment once per `(cliver, rsver, template_version)`, push it by digest to a private
ECR repository this verifier operates, and always publish the full component recipe with every result
regardless of whether that result was served from cache.** Concretely:

### 1. Reuse, not single-use

A `(cliver, rsver)` pair composes to the same environment every time, by criterion 1 (every input
pinned). There is no security reason to discard and recompose it per verification, and every reason
not to, given the demand curve above. Composition is modeled as its own entity and lifecycle,
parallel to `Rebuild` (ADR-008) rather than folded into it:

```prisma
model Environment {
  id              String   @id @db.Uuid
  cliver          String
  rsver           String
  templateVersion String   @map("template_version")
  // status: pending | composing | ready | failed — mirrors Rebuild's pending/dispatching/running/done
  status          String   @default("pending")
  recipeSha256    String?  @map("recipe_sha256")   // §2 below — the published immutable identity
  imageDigest     String?  @map("image_digest")    // our ECR pull target; an operational detail
  recipe          Json?                             // ComposedEnvironmentRecipe (plan.md §3.1)
  errorCode       String?  @map("error_code")
  batchJobId      String?  @map("batch_job_id")
  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt @map("updated_at")

  @@unique([cliver, rsver, templateVersion])
  @@index([status])
  @@map("environments")
}
```

Two jobs discovering the same not-yet-composed pair race through the same
compare-and-set claim pattern `Rebuild` already proves out (`status: "pending" → "composing"`); both
attach to the one row. Composition is bounded to ≤ 99 rows by corpus size (§TD3), so there is no
unbounded-growth concern this table needs to defend against.

### 2. Immutable identity: a recipe hash, not the raw OCI digest

**`recipe_sha256`** — the sha256 of a canonical serialization of `ComposedEnvironmentRecipe`
(`{schema, template_version, pair: {cliver, rsver}, components: [{kind, source, sha256}, ...]}`,
fields in fixed order, matching the encoding discipline IMPLEMENTATION-SPEC §E already uses for the
idempotency key) — is **the** immutable, observed identity this feature publishes and keys on. The
resulting container image's own registry digest (`image_digest`) is recorded too, but only as an
**operational pull coordinate**, not the published identity: Docker layer/build metadata can vary
build-to-build in ways that don't change what was actually pinned (a fresh `docker buildx` run against
an identical recipe should reproduce the same image bytes, per the PoC's H4 run-to-run results, but
the recipe hash doesn't have to depend on that guarantee holding forever). This directly answers
plan.md §3.3's "the rebuild key uses the observed immutable environment identity ... never a tag":
`Rebuild.imageDigest`'s cli-legacy values become `recipe_sha256`, and a lookup from
`recipe_sha256 → Environment.imageDigest` happens once, at dispatch time, to populate
`BatchJobParams.image_digest` with something Batch can actually pull.

### 3. Cross-worker transport: registry pull, unchanged

The builder receives exactly what it receives today for cli-58 — a digest-pinned image string — just
pointed at `<account>.dkr.ecr.<region>.amazonaws.com/scvs-composed-environments@sha256:<image_digest>`
instead of Docker Hub. **No new field shape and no new transport** for *consuming* an environment. What's
new is only *who populates* `image_digest` for cli-legacy (the resolver/materializer below, instead of
image-policy validating a submitted `bldimg`) and *where it physically lives* (our ECR, not the
ecosystem's).

> **Correction, 2026-08-12 — this section also said "no new builder code path", and that was wrong.**
> Drafted by an agent, pending the owner's approval.
>
> Docker Hub pulls anonymously; a **private** ECR registry does not. The first cli-legacy job to reach the
> rebuild failed with `no basic auth credentials`, surfaced as `toolchain_probe_failed` because the
> toolchain probe is the first command to pull the image. Everything else in this section held — same
> field, same digest-pinned string, same `docker run` — but consuming the environment needs one thing
> cli-58 never did: an `ecr get-login-password` → `docker login` before the first pull
> (`sandbox-runtime.ts:authenticateForImage`, a no-op for any non-ECR registry).
>
> This does **not** widen what the builder holds, and no IAM change accompanied it.
> `../design/aws-deployment.md` §5.1 already scopes the builder's roles to
> "zero business permissions (**ECR pull** + logs only)", and the capability was already present and
> unexercised: the Batch compute environment's instance role carries
> `ecr:GetAuthorizationToken`/`BatchGetImage`/`GetDownloadUrlForLayer` through the AWS-managed
> `AmazonEC2ContainerServiceforEC2Role`. The token lands in the runner's docker config; the container that
> executes submitted code is the inner one, which has neither the socket nor that config.
>
> It did cost the sandbox image one package — `awscli` — because `services/builder` must import no AWS SDK
> and `test/trust-boundary.spec.ts` fails if it ever does. The composer reached the same conclusion for the
> same reason; see `authenticateToEcr`'s comment there.
>
> Recorded rather than quietly patched because the claim was load-bearing: it is why nobody looked for an
> authentication step, and the cost was a production failure per unexercised layer. See
> `../features/sandbox-hardening/updates/2026-08-12-private-ecr-pull-needs-authentication.md`.

### 4. No staging lifecycle to manage — the registry is the durable copy

Because the composed image is pushed to ECR (not held in a transient blob with a TTL), there is no
staging-copy cleanup problem to design. At the corpus's full 93-environment ceiling, at a
conservatively estimated ~500 MB–1 GB per composed image (rust toolchain + stellar-cli binary +
Debian slim base), total footprint is under 100 GB — cheap to keep indefinitely and irrelevant next to
the object-storage costs the rebuild pipeline already carries for source and build artifacts.

**Retention, in three layers** *(revised 2026-08-05 — see "Revision history"; the original text here read
"ECR lifecycle policy: never expire an image referenced by any `Environment.status = "ready"` row", which
is not a policy ECR can execute).*

An ECR lifecycle rule can only select on `tagStatus`, `tagPrefixList`, image count, or days since push.
It cannot query our database, so "referenced by a `ready` row" is not expressible as a rule — it is an
intent someone has to translate into something ECR can enforce. Deleting one of these images does not
invalidate an already-published result (`recipe_sha256` plus the full component recipe still let a third
party rebuild it without us — §5), but it does mean **we** can no longer reproduce it, and nothing would
announce that. So:

1. **This repository carries no expiry rule at all.** That is the policy — not "a rule that spares ready
   images", no rule.
2. **The absence is recorded as load-bearing**, in `config/env-manifest.yaml`'s
   `SCVS_COMPOSED_ENVIRONMENT_REPOSITORY_URI` entry. An absent configuration protects nothing by itself;
   what stands between a later account-wide cost pass and these images is a written statement that they
   are not garbage.
3. **The composer tags every pushed image with its `recipe_sha256`.** This is the layer that survives
   somebody else changing (1). An image pushed by digest alone is `untagged`, and "expire untagged images
   after N days" is the most common ECR hygiene rule there is — written to sweep up orphaned build layers,
   which is exactly what a composed environment looks like from outside. The tag makes that rule shape
   miss us.

Three properties of that tag are requirements, not incidental:

- **Nothing ever reads it.** Dispatch resolves `recipe_sha256 → Environment.imageDigest` from the database
  and pulls by digest (§2, §3). The tag exists to stop ECR classifying the image as garbage, and to make
  the repository legible in the console — never as a lookup key. A tag-derived environment reference would
  violate `build-environments/plan.md` §6 outright.
- **`recipe_sha256`, not the pair.** A pair-derived tag (`cli25.1.0-rs1.95.0-v1`) reads better and is also
  1:1 with an `Environment` row — but it has to *move* when a reset row is recomposed against changed
  upstream components, and the image it moves off becomes `untagged` again while a published result may
  still reference it. `recipe_sha256` is a hash of content: one tag per image, never moved, never reused. A
  second human-readable tag may be applied alongside it; the safety property comes from this one.
- **It is defence in depth, not a guarantee.** A rule written `tagStatus: any` + `sinceImagePushed` deletes
  tagged images too. Layer 1 is still the actual policy; layer 3 only removes the likeliest way for layer 1
  to be undone by accident.

The only lifecycle that needs bounding is the **`composing` state itself** — a crash mid-build or
mid-push must not strand the row. This reuses ADR-008's reconciliation pattern verbatim: a
`composing` row past a timeout is either resumed (ask Batch whether the job is still running) or
reset to `pending` for the next attacher to retry. Composition has no partial side effect worth
recovering — nothing is pushed to ECR until the local build and every component checksum verify, and
ECR's own content-addressing makes a duplicate push of identical bytes a no-op — so "reset and retry
from scratch" is always safe, unlike a rebuild's Batch dispatch, which the existing reconciler already
treats more carefully for exactly that reason.

### 5. TD2: both mirror and publish, for different reasons

**Mirroring** (our own ECR copy) is the operational durability mechanism: it is what makes dispatch
fast and independent of whether `static.rust-lang.org` or a GitHub release asset is still reachable
at rebuild time. **Publishing the full recipe with every result** (component locations and
checksums, §9 of `design/build-environments.md`) is not optional even though we mirror — SDF's
criterion 3 is about what a *third party* can do without trusting or pulling from us, which our
private cache does nothing to satisfy on its own. The two mechanisms answer different questions
(plan.md's "have we already got a copy" vs. ADR-009's "can anyone else get one without us"), so this
proposal adopts both rather than picking one, at negligible added cost.

### 6. Verification: the composer worker, before anything is usable

The composer worker verifies every component's checksum (rustup-installer sha256 against the pin
baked into the template; the stellar-cli release binary against the per-asset digest GitHub's release
API publishes — the same check the PoC validated as sufficient) **before** that component enters the
`docker build` context, and aborts the composition (job failure, `Environment.status = "failed"`, no
push, no publication) on any mismatch. It additionally smoke-tests the finished image — runs
`rustc --version` / `stellar --version` inside it — and refuses to mark it `ready` if either disagrees
with the pair it was supposed to produce. It also **tags the pushed image with its `recipe_sha256`**,
which is a retention requirement rather than a verification one (§4 layer 3) but belongs here because the
push is the only moment at which anything can apply it. This is the direct fix for the failure mode the PoC caught
in the *official* 26.x images (silently building with a different toolchain than declared): the
composer, not a downstream consumer, is where that check belongs, because it is the only place that
has both the declared pair and the freshly-built image in hand at once. No separate, more-trusted
verifying component is required: composition already satisfies CE1 by construction (its whole input
set is on-chain metadata plus official artifacts), so the same worker doing its own verification adds
no new trust dependency, provided it never accepts a submitter-supplied checksum as an override —
already guaranteed by `BuildEnvironmentResolver` having no submitter-reachable parameter (plan.md
§3.2).

### Placement, extending the infra-and-ops mechanism rather than re-deciding it

Composition gets its **own** Batch job queue and compute environment (`scvs-composer`), separate from
the builder's (`scvs-builder`):

- **CE4 between fleets is free**: composer and builder never share a host because they are different
  compute environments (different underlying EC2 capacity) — no new mechanism, just a second
  application of Terraform's existing per-environment isolation.
- **CE4 within the composer fleet** follows whatever `infra-and-ops`'s TRD §10 item 12 ADR settles on
  for the builder (today's proposal: pin to a single instance type, size the job to the whole
  instance — the "floor"; a nested rootless runtime later, per that proposal's Alternative B, removes
  the co-tenancy question for both fleets at once). This proposal does not choose that mechanism a
  second time; it only asserts the composer fleet is in scope for whatever gets chosen.
- **Egress allowlist** (PA5-style, infrastructure layer): the ECR endpoint (push to our own repo, pull
  the digest-pinned Docker Official base through Docker Hub's registry/token/layer endpoints),
  `static.rust-lang.org` (rustup-verified toolchain archives), and GitHub's API and release-asset
  redirects/CDNs (`api.github.com`, `github.com`, `release-assets.githubusercontent.com`,
  `objects.githubusercontent.com`) — nothing else. No submitted source
  host, no crates registry, no artifact-upload endpoint: the composer never touches submission data.
- **IAM role**: a third role, distinct from both the resident services' role and the builder fleet's
  zero-business-permission role (CE5) — ECR push/pull scoped to the one `scvs-composed-environments`
  repository, and nothing else. Not the builder's role, because the composer needs a write capability
  (`ecr:PutImage`) the builder must never have; not the resident-service role, because the composer
  has no business reason to reach the database, S3 result buckets, or `batch:SubmitJob` for the
  builder queue.
- **Module boundary**: a new `build-environments` module in `services/orchestrator-svc`, alongside the
  existing `verification-pipeline` module — it owns the `Environment` state machine and Batch dispatch
  to `scvs-composer`, structurally identical to how `verification-pipeline` already owns `Rebuild` and
  dispatch to `scvs-builder`. No new microservice.

## Consequences

**Easier**

- No new wire format or transport is invented. The Batch contract's `image_digest` field is reused
  unchanged; only its source (resolver output vs. submitted `bldimg`) and target registry change.
- Reuse turns the corpus's demand concentration into a cost saving instead of a cost multiplier: the
  top 5 pairs' 1,674 contracts (52% of class-B) each pay one composition, not one per submission.
- The composer's reconciliation logic is a straightforward instance of a pattern this codebase already
  has proven (ADR-008's `Rebuild` claim/reconcile), not a new one to design from scratch.

**Harder / constrained**

- A second Batch compute environment, a second job definition, a second IAM role, and a new ECR
  repository are new Terraform-contract surface (ADR-006) — real infrastructure work, not free.
- `Rebuild`'s `image_digest` column changes meaning for cli-legacy rows (recipe hash, not a registry
  digest); the dispatch path needs the extra `recipe_sha256 → image_digest` lookup at Batch-submit
  time, which cli-58's path does not need. This is exactly the migration plan.md §3.4 already flags.
- ECR outages or throttling become a new dependency for the rebuild path, on top of the builder's
  existing dependency on the source host and crates registry. Mitigated by the fact that a composed
  environment, once `ready`, is pulled the same way an `sdf_trusted` image already is today.
- The composer fleet is a second high-privilege (container-execution-capable) surface CE1–CE5 governs;
  auditing and alerting (O4/O5 in `infra-and-ops/spec.md`) must cover it from day one, not be
  retrofitted after the builder fleet's.

## Alternatives considered

- **Per-verification assembly, no cache** (plan.md's originally recommended direction). Avoids
  operating a second registry, but pays a full Docker build and network fetch for every verification
  of every pair, including the 813-contract head of the demand curve, for no corresponding security
  gain — composition's trust properties come from *what* it fetches (official, pinned), not from
  *when* it fetches it. Rejected on cost grounds, not correctness grounds.
- **Single-use OCI bundle over a presigned URL, no registry.** Avoids ECR, but requires the builder to
  learn a new "load this bundle" code path distinct from its existing "pull this digest" path, for a
  transport that solves nothing a registry doesn't already solve more simply. Rejected: more new
  surface for no benefit.
- **A remote composition daemon the builder calls at build time.** Turns composition into a live
  runtime dependency of every rebuild rather than a precomputed, cacheable artifact; a composer outage
  would then fail rebuilds directly instead of only delaying the first verification of a new pair.
  Rejected.
- **A registry shared across verifiers.** Already excluded by ADR-009 constraint 4; restated here only
  to distinguish it from the private registry this proposal adopts.

## Outstanding — accepted with these still to verify

Accepted without these being closed first, deliberately: none of them can change the *shape* of the
decision, only its operating parameters, and the software contract had to be settled before the
infrastructure work could be specified against it. Each is owned work, not a caveat to forget.

0. **`infra-and-ops`'s own CE1/CE4 decision is still `Proposed`.** This ADR asserts the composer fleet
   is in scope for whatever that decision chooses; until it is accepted, the composer fleet's *internal*
   co-tenancy question is open. CE4 *between* fleets is already settled here and needs nothing from it
   (composer and builder are different compute environments, so they cannot share a host).
1. Confirm AWS Batch/ECS supports a second compute environment and job queue in the account without
   conflicting with the builder's existing registered resources (should be routine, but is exactly the
   kind of assumption the infra-and-ops proposal's own pre-ratification list warns against skipping).
2. Confirm the per-environment image size estimate (~500 MB–1 GB) against an actual built image, to
   firm up the ECR storage-cost line above.
3. Confirm GitHub's release-asset digest API and `static.rust-lang.org`'s installer checksums remain
   sufficient for offline verification at composer scale (the PoC validated this for 18 cells; this is
   about rate limits and availability at up to 93 pairs, not about the check's correctness).
4. Decide, alongside `infra-and-ops`, whether the composer fleet's egress allowlist is expressed at the
   same layer (VPC/security-group) as PA5's, or needs its own — they are different destination sets
   and should not silently share one allowlist that's wider than either needs.

## References

- `build-environments/plan.md` §2.1, §2.2, §3.1–§3.4 — the six questions this answers
  and the seams (`BuildEnvironmentResolver`/`Materializer`) it fills in
- [ADR-009](ADR-009-build-environments-are-composed-from-official-components.md) —
  constraints 1, 4, 5; the 2026-08-05 amendment this proposal is consistent with
- [ADR-008](ADR-008-rebuild-and-verdict-are-separate-entities.md) — the claim/reconcile
  pattern `Environment` reuses; the `image_digest` field this proposal redefines for cli-legacy
- [ADR-006](ADR-006-terraform-owns-aws-infrastructure.md) — the contract the new compute
  environment and ECR repository change
- `infra-and-ops/decisions/one-job-per-host-now-nested-runtime-on-evidence.md` —
  the CE1/CE4 mechanism this proposal extends to a second fleet rather than re-deciding
- TRD §10 items 12–13; IMPLEMENTATION-SPEC §B.4 (TD1–TD3), §B.5 (CE1–CE5)
- `../../../evidence/2026-07-30-corpus-scan.md` —
  demand concentration (§5); `../../../evidence/2026-07-30-poc-composed-image.md` —
  reproducibility (H1–H4) and the checksum/verification approach (§6)

## Revision history

- **2026-08-05, accepted.** Promoted from
  `build-environments/decisions/compose-once-cache-in-private-registry.md`;
  pre-ratification checklist reframed as "Outstanding".
- **2026-08-05, §4 revised (retention).** The original single sentence — "ECR lifecycle policy: never
  expire an image referenced by any `Environment.status = "ready"` row" — was not executable: ECR lifecycle
  rules cannot read our database, and images pushed by digest alone are `untagged`, which is precisely what
  the most common ECR cleanup rule deletes. Replaced with the three layers above (no expiry rule; the
  absence recorded as load-bearing; a `recipe_sha256` tag at push). Found while implementing the composer —
  the decision's *intent* is unchanged, only its expression. §6 gained the tagging step for the same reason.
