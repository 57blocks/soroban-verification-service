# Third-party verifier onboarding guide

> **Audience**: an organisation considering running its own Soroban contract verifier, independent of
> this project's own deployment, and possibly wanting other aggregators to include it in their reads.
> **Read this first, because it changes what "onboarding" means here**: there is no registration API,
> no signup form, and no protocol step this guide can walk you through to get listed anywhere. That is
> not a gap — it's a deliberate design choice, quoted in §1. This guide instead covers the two things
> that actually are in your control: standing up a real, independently operated verifier, and making it
> self-describing enough that an aggregator *could* choose to include it.

## 1. There is no verifier-registration API, and there will not be one

From this project's own technical requirements document:

> "The TVL needs no verifier-registration API. Admission to a TVL is the aggregating operator's
> decision and always was: a verifier describes itself and does not admit itself to anyone's list. A
> central registry that verifiers sign up to would reintroduce exactly the single chokepoint the
> per-verifier attribution model exists to avoid."

The Trusted Verifiers List (TVL) that any given aggregator serves is that aggregator's own curated
list, published as a static document at `GET /api/query/v1/verifiers` on *their* deployment. Being
listed there is entirely their call, made by whatever process they choose — reading your published
result root, an email exchange, a manual review. This document cannot specify that process because it
is not uniform across aggregators, and by design it is not meant to be.

What follows is what you actually control.

## 2. Step one: deploy a real, independently operated verifier

There is no way to be a credible verifier without first being one — an aggregator has nothing to
inspect otherwise. Follow [`docs/self-hosted-deployment.md`](self-hosted-deployment.md) to stand up
Verifier-only mode in your own AWS account, under your own identity. The properties that actually make
you *independent*, and that any aggregator worth being listed by will notice if they're missing:

- Your own AWS account and credentials — not a shared deployment fronted by a different name.
- Your own trust policy (what build images and source modes you accept), configured to reflect
  decisions you actually made, not copied wholesale from another verifier's defaults without
  consideration.
- Your own published result root, reachable over HTTPS, independent of whether any other verifier's
  service is up.

## 3. Step two: make yourself self-describing

Two documents live at your result root and are what an aggregator — or anyone else — would actually
read to evaluate you:

### `verifier-manifest.json`

Your self-description: identity for attribution and display, and the URL templates a consumer follows
to fetch your published results by hash or by contract. Getting this right matters more than anything
else in this guide, because a manifest is worse than useless if it's wrong:

- **Every URL template must actually resolve.** If your manifest advertises a by-hash template and a
  real hash substituted into it 404s, that is a broken promise a peer verifier or aggregator will hit
  the first time they try to use you, not a cosmetic issue.
- Publish it at the fixed, well-known location in your result root (this project's implementation
  writes it as `verifier-manifest.json` at the root, alongside — not nested under — the hash-keyed
  documents; follow the same convention so tooling written against one verifier works against yours).

### Decide whether you serve a bulk-load endpoint

This is the one decision in this document that materially changes what an aggregator can do with you,
so it gets its own callout rather than living as a manifest field in passing.

A verifier that serves only static per-hash files is **fully readable, but not enumerable**: an
aggregator can fetch your result for a Wasm hash it already knows, and that read never depends on your
service being up. What it *cannot* do without more is discover which hashes you have results for in the
first place — a static-only verifier's coverage, from an aggregator's side, is "whatever hashes it
learned about elsewhere." This is a real, named conformance class in this project's own design (not a
degraded or unsupported state), so treat serving only static files as a legitimate choice, not a
placeholder for something you haven't gotten to yet.

If you want an aggregator to be able to **synchronise against you** — pull the full list of what you've
verified, rather than only ever checking hashes it already suspects — you need to serve a bulk-load
route (`GET /api/verification/v1/wasms` in this project's own implementation) and publish its URL as
your manifest's `bulk_load_url`. Without it, you are not excluded from any TVL, but you are invisible to
any discovery process that works by asking "what has this verifier published," rather than "does this
verifier agree about this specific hash."

Two failure modes to avoid once you do serve one:

- **A `bulk_load_url` that resolves to nothing, or to a stale/partial page, is worse than not publishing
  the field at all** — the same principle as §3's warning about manifest URL templates. An aggregator
  that discovers the field and then gets an empty or broken response records that as a real failure to
  reach you, not as "static-only."
- Keep the field itself in sync with reality: if you stop serving bulk load, remove the field — a
  dangling `bulk_load_url` an aggregator successfully seeded once and then never re-checks can leave you
  looking synchronisable long after you've stopped being so.

### `policy.json`

Your declared trust rules: which build-image trust levels you accept, which source-submission modes
you allow, your retention policy. This document must be **generated from your live configuration, not
hand-written and left to drift** — a policy document that disagrees with what your service actually
does is worse than publishing none, because it actively misleads a consumer deciding whether to trust
your results.

Before considering yourself "done," fetch both documents from your own public result root exactly as
an external reader would — not from an internal path, not with any special access — and confirm they
read as a stranger would need them to.

## 4. Step three: being considered by a specific aggregator

Once you are running and self-describing, reaching any particular aggregator is a manual act between
two organisations — an introduction, an email, a conversation about their trust tiers — not a protocol
this guide specifies, per §1. There is nothing to automate here, and treating this step as something
you can script or standardize misreads the design decision in §1: the lack of a chokepoint is the
point, not an oversight to work around.

## 5. What an aggregator that does list you will publish about you

If an aggregator adds you to their TVL, here is the shape of what they record — useful as "what to
expect them to say about you," not as something you fill in and submit:

| Field | What it is |
| --- | --- |
| `url` | Your result root's base URL |
| `manifest_url` | Where your `verifier-manifest.json` lives, if you publish one. Optional in the published schema: the Results SEP does not define that document, and nothing an aggregator needs is read out of it — so its absence excludes you from nothing. Publish one anyway if you want a reader to find your policy and contact details in a predictable place |
| `bulk_load_url` | Present only if you serve one — see §3's callout. Its absence doesn't exclude you, but it does mean an aggregator can only reach you by looking up hashes it already knows, never by asking you what you have |
| `display_name` | How they'll refer to you |
| `trust_tier` | *Their* assessment of you, not a self-rating |
| `status` | `active` \| `paused` \| `disabled` |
| `added_at` | When they added you |

None of these are values you provide directly to them through any API this project defines — they are
values the aggregator sets, based on their own review of what you publish per §3.
