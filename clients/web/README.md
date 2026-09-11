# Soroban Verify

Workspace implementation of the `/` landing page and `/verify` verification submission page described in:

- Stellar-inspired verification landing page;
- contract ID or Wasm hash target submission;
- preflight-style incomplete response handling;
- SEP-58 submitted-source manifest completion;
- public archive URL and private uploaded tarball source modes;
- queued, running, verified, mismatch, and failure UI states;
- direct job status pages at `/verify/jobs/{job_id}`;
- browser-local recent verification jobs;
- API v1 submission flow against the verifier service.

## Structure

Feature-first: a feature is a vertical slice that owns its own routes, components, hooks, state,
and copy. `src/` root level holds only what more than one feature needs.

```text
tailwind.config.js         every design token — see "Design tokens" below
components.json            shadcn/ui generator config (style, aliases, icon library)
spa-routes.ts              renders route-paths.ts into nginx `location` blocks; a build plugin
                             emits it as dist/spa-routes.conf — see "Routing" below
public/                    design assets: 57blocks.png, tick-circle.svg, archive-tick.svg
src/
  main.tsx                 React root: query client, router provider, sonner Toaster
  index.css                Tailwind entry + the few global element rules
  app/
    route-paths.ts           the declared route surface, read by the routes and by the renderer
    root-route.tsx           the one root route, the `/` redirect, and the not-found component
    router.tsx               assembles the route tree from each feature's exported routes
  components/ui/           shadcn/ui primitives, restyled to the design tokens:
                             button, pill-icon, input, label, select, collapsible,
                             badge, sonner
  components/              site-nav + site-footer (the console and legal pages),
                             legal-links (the two legal documents, linked from both footers
                             and from the submission control), not-found (what an unrouted
                             path renders)
  config/site.ts           links used by more than one feature (outbound, and the legal routes)
  hooks/use-legal-documents  the operator's legal bundle — shared, because the legal pages render it
                             and the console binds its version to a submission
  lib/legal.ts               LegalDocument / LegalSection / LegalBlock / LegalBundle
  hooks/                   app-wide hooks (document title)
  lib/http.ts              API base URL + error-message extraction
  lib/utils.ts             `cn()` — clsx + tailwind-merge
  features/
    landing/               the marketing page at /
      components/            one component per section, + LandingPage composing them
      routes/                the / route
      content/               one module per section, each owning that section's SectionHead
                             copy AND its items, re-exported through content/index.ts —
                             so a claim the page makes is edited in exactly one file
      navigation.ts          nav + footer link tables
      index.ts               public surface: the routes
    verification/          the verify console at /verify and /verify/jobs/$job_id
      components/            VerifyConsole (container) + one component per panel
      hooks/                 use-verification-console (the state machine),
                             use-job-event-stream (SSE), use-recent-jobs,
                             use-source-archive
      routes/                both console routes
      types/                 the console's view model
      utils/                 pure helpers: result, diagnostics, manifest, flow, format,
                             clipboard, recent-jobs store, evidence-rules (the required-field
                             refusals, shared by the fields and the pre-submit gate)
      constants.ts           form defaults, status/field copy, tone classes
      index.ts               public surface: the routes + VerifyConsole
    legal/                 the Terms of Service at /terms and the Privacy Notice at /privacy.
                             THE TEXT IS NOT HERE: it is operator configuration, fetched from
                             GET /api/verification/v1/legal, and this bundle ships none of it
      components/            LegalPage (layout) + LegalBlocks (paragraph/list renderer)
      content/shared.ts      the page's own chrome about draft state — nothing operator-specific
      routes/                both document routes, with the loading and unavailable states the
                             fetch introduced
      index.ts               public surface: the routes
    aggregator/            the flag-gated page at /query — BUILT, REACHABLE ONLY WHERE THE FLAG IS ON
      components/            AggregatorPage (the page), CollapsibleSection, TrustedVerifiers +
                             AdditionalRootsPanel (the two lists), HashLookup / ContractLookup
                             (the two tabs), LookupResult + AggregatedStatusView +
                             UnavailableVerifiers + RootResults (shared rendering), VerifierResult,
                             PeerLink (S26 interstitial), Feedback
      hooks/                 use-query-api (the query-svc transport) + use-aggregate-lookup /
                             use-hash-lookup / use-contract-lookup / use-trusted-verifiers;
                             use-additional-roots (the session list) + use-root-lookups (the one
                             path that fetches a verifier directly)
      routes/                /query, whose beforeLoad redirects when the flag is off
      types/                 the lookup's view model
      index.ts               public surface: the routes + AggregatorPage
```

`aggregator` is one page: **Aggregated Verification Results** at `/query`. Top to bottom it shows the
Trusted Verifiers List, the session's additional result roots — both collapsible, both carrying a
count badge, since collapsed the badge is the only thing still saying what an answer is made of — and
then a lookup by Wasm hash or by contract ID.

**Every aggregate answer comes from query-svc**, which serves what its sync retained rather than
fetching while you wait. An aggregate with no entries therefore means "not reached yet", not "nobody
has anything": it is reported as what this deployment holds, with a **Refresh**, never as a verdict,
and `unavailable_verifiers` is rendered even then because a verifier failing to sync is frequently
the reason there is nothing.

**The one exception is deliberate and visible.** Result roots the reader adds for the session are
fetched by the browser and reported in their own section, one block per root — they are roots
query-svc does not aggregate across, so nothing else could ask them. The two sources never merge: an
aggregate is a claim about a curated set, and an ad-hoc list is not one. Those roots are gone on
reload, which is what stops them becoming a second, unmaintained TVL.

Gated by **`SCVS_ENABLE_AGGREGATOR`**, read from the container's environment at start-up (`"true"` in
`dev`, absent elsewhere) — not the build-time `VITE_ENABLE_AGGREGATOR`, which survives for
`pnpm run dev:web` only. **It is the only feature that renders another verifier's content, so
S24–S26 apply to it and to nothing else here.** See
`the-result-explorer-is-flag-off.md`
for why the capability ships disabled,
`the-aggregator-flag-is-set-at-container-start.md`
for where the flag is read, and
`the-aggregator-is-one-page.md`
for the page's shape.

Rules that keep this from drifting:

- **Cross feature imports go through `features/<name>/index.ts`.** Nothing outside a feature
  reaches into its `components/`, `hooks/`, or `utils/`.
- **Promote on second use, not on suspicion.** A helper stays in the feature that uses it until a
  second feature genuinely needs it, then it moves to `src/lib`, `src/hooks`, or `src/config` — the
  same ownership rule the backend applies to DTOs in
  [ADR-005](../../docs/adr/ADR-005-dto-ownership-follows-use.md).
- **Components render; hooks decide.** Panels take props and return markup. Anything stateful —
  submitting, streaming, storing — belongs in a hook under `hooks/`.
- **Copy is data.** Section text, status text, and field help live in `content.ts`/`constants.ts`,
  not inline in JSX, so wording changes never touch layout.
- **Styling is Tailwind utilities written inline in the JSX.** There are no feature stylesheets and
  no CSS modules: `index.css` holds Tailwind's three directives, a handful of base element rules,
  and one scrollbar utility. Nothing else. Anything that cannot be a utility — the dot field, the
  hero glow, the pill arrow's hover animation — is a named `backgroundImage`/`keyframes` entry in
  `tailwind.config.js` and is still applied as a class.
- **UI primitives come from shadcn/ui, in `src/components/ui`.** They are copied into the repo, not
  imported from a package, so they are ours to restyle — and they are already restyled to the
  design tokens. A component that needs a button imports `@/components/ui/button`; it does not
  hand-roll one.
- **No raw colours in components.** Every colour is a named token — see below.

## Routing

`src/app/route-paths.ts` is the declared route surface. Two consumers read it: each feature's `path:`
declaration, and `spa-routes.ts`, whose Vite plugin renders it into `dist/spa-routes.conf` at build
time — the nginx `location` allowlist the deployed origin serves the entry document from. Everything
that is neither one of those routes nor a real file in `dist/` answers **404**, carrying
`components/not-found.tsx`; the router renders the same component after a client-side navigation.

Adding a route means adding it to `route-paths.ts`. `test/route-surface.spec.tsx` fails when the
declared set and the mounted tree disagree, and `pnpm run check:host-routing` (repository root) serves
the real `docker/web-nginx.conf` on nginx and probes what each position answers. The reasoning is in
`../../docs/features/console/decisions/an-unrouted-path-answers-404.md`.

`<Link to="…">` call sites keep their path literals rather than referencing `ROUTE_PATHS` — TanStack
type-checks those against the built tree, which is a stronger guarantee than a shared constant.

## Legal pages

`/terms` and `/privacy` are **the reference deployment's documents** — the terms under which
57Blocks operates its hosted instance. They are not part of the software's contract: the software is
Apache-2.0 ([ADR-023](../../docs/adr/ADR-023-the-project-is-licensed-apache-2.md)), and the footer's
licence line (`footerLegal` in `features/landing/content/brand.ts`) names that licence precisely so
the two are not confused. **An operator self-hosting this client must replace the text in
`features/legal/content/`** before serving it; shipping another operator's terms is worse than
shipping none.

The documents are data (`features/legal/content/*.ts`), not markdown or JSX, so counsel can read
them in the rendered page and reviewers can diff them here. Two inline marks are supported in a
paragraph, `**bold**` and `label`; a same-origin `href` renders as a router link. Every
statement in the Privacy Notice is meant to be checkable against the code — a change to what a
service stores or sends, or to what the console loads from a third party (today: Google Fonts, in
`index.html`), is a change to `privacy.ts` in the same PR.

They ship as **drafts**: while `legalEffectiveDate` in `content/shared.ts` is `null`, each page
carries a banner and an "Open for legal review" list at its foot. Setting the date is the publish
step, once both legal reviews (57Blocks counsel, Stellar's legal team) are done. Nothing
else on the page changes.

## Form layer

The console's two stages — submit a target, then complete the evidence the verifier asked for — are
one **react-hook-form** instance created in `use-verification-console` and passed down. There is no
form library component wrapper: `FieldShell` renders the design's label/hint/help row, and the
inputs are `register()`-ed shadcn `Input`s. Validation lives with the field as a `validate`
function; `submitTarget`/`submitCompletedManifest` call `form.trigger([...])` and bail on `false`.

The evidence stage is **inline only** — there is no download-a-template / upload-a-filled-manifest
path. `source_sha256` is required; the build environment is derived from deployed Wasm metadata and
is never entered by the submitter. The only file the console accepts is the private source archive,
hashed in the browser by `use-source-archive`.

Toasts are **sonner** (`toast.success` / `.error` / `.warning`), mounted once in `main.tsx`.

`copyValue` (`utils/clipboard.util.ts`) tries `navigator.clipboard.writeText` and falls back to a
detached-textarea `document.execCommand("copy")`. The fallback is load-bearing, not defensive: the
async API is undefined on a plain-http origin and rejects with `NotAllowedError` wherever the page
lacks clipboard-write permission, which is why every copy button in the console silently failed
before it existed. The fallback must stay synchronous inside the click handler — it depends on the
transient user activation.

## Design tokens

`tailwind.config.js` is the single definition of the palette, transcribed from the approved design.
Every value in a component resolves through it.

| Group | What it is |
| --- | --- |
| `ink.*` | Neutral scale: `ink` (#0f0f0f) headings and dark sections, `ink-body` copy, `ink-soft` eyebrows, `ink-label` panel sub-headings, `ink-value` diagnostics values, `ink-warm` console captions, `ink-mute` footer/meta |
| `yellow.*` | The one accent (#fdda24), plus `soft`/`pale` washes, `bright` hover, `deep` card eyebrows, `shade` the ◆ text-shadow, `dot` the queued status dot |
| `surface.*` | Light fills, in stacking order: white → `alt` tinted → `hover` → `hero` wash → `field`/`track`/`chip` |
| `line.*` | Hairlines: `line` landing, `strong` console + inputs, `hero`, `soft` flow track, `mute`, `quiet` |
| `dark.*` | The two near-black sections and their cards: `card`, `line`, `rule`, `hover`, `fg`, `cmd`, `text`, `dim`, `bright` |
| `success.* warning.* danger.* neutral.*` | Verdict tones. Within a group, `fg` is text, `surface` a panel fill, `badge` a pill fill, `dot` the recent-jobs status dot |

Also owned here, and used the same way: `maxWidth.shell` (1320px, the page width) and
`maxWidth.console` (900px), `boxShadow.panel`/`dropdown`/`float`/`underline`/`focus`,
`backgroundImage.dots`/`hero-glow`/`cta-glow`/`console-page`, and the `arrow-slide`/`glow`
animations.

Conventions:

- **A raw `text-[#abc123]` in a component is a bug report against the config.** Add the token there,
  then use it. `grep -rn '\[#' src` should return nothing.
- **Alpha comes from the opacity modifier on a token** — `text-ink/[0.66]`, `bg-surface/60`,
  `border-ink/[0.16]` — not from a second hex.
- **`theme()` is allowed inside an arbitrary value** where Tailwind has no utility for the property,
  e.g. the heading highlight `shadow-[inset_0_-0.18em_0_theme(colors.yellow.DEFAULT)]`. The colour
  is still the token.
- **`backgroundImage` and `backgroundSize` share the `bg-*` namespace.** That is why the dot field's
  size key is `dotgrid` (`bg-dots bg-dotgrid`) and the console page pairs `bg-console-page` with an
  arbitrary `bg-[length:auto,13px_13px]`.

## Run

From the workspace root (pnpm workspace — see the repository's own `AGENTS.md` for the full
prerequisite list):

```bash
pnpm install
pnpm run build
```

Start the Verification API in one shell:

```bash
PORT=5000 SCVS_CLI_TIMEOUT_MS=600000 pnpm run dev:verification-svc
```

Start the console in another shell, pointed at that API — see
["Use a real verification API"](#use-a-real-verification-api) below for the proxy vs. local-backend
modes:

```bash
pnpm run dev:web
```

Open:

- `http://localhost:5173/`
- `http://localhost:5173/verify`
- `http://localhost:5173/verify/jobs/{job_id}`

## Use a real verification API

Two modes. Both read the **repository-root** `.env` / `.env.local` — `envDir` in
`vite.config.ts` points there, so a `clients/web/.env.local` is read by nothing. The dev server
warns on start-up if it finds one, since it looks exactly like the configuration and its first
symptom is the console reporting itself unconfigured.

### Against a deployed environment (dev or staging)

Proxy `/api` through the dev server. This is the mode to reach for when debugging real data:

```bash
# repository-root .env.local
VITE_DEV_API_PROXY="https://dev.sv.example.com"
VITE_VERIFY_API_URL=""
VITE_QUERY_API_URL=""
```

then `pnpm run dev:web`. The browser's requests stay same-origin, which is both what gets past CORS
— a deployed environment does not allow `localhost` — and the shape the console actually ships in,
where one ALB fronts the console and both APIs by path (`docs/design/aws-deployment.md` §4).

One `/api` rule serves both services, and the job page's SSE stream is proxied too, so a live
verification can be watched end to end.

**Both URLs must be empty.** A non-empty base is concatenated with `/api/verification/v1/...` and
sent to that host directly, skipping the proxy; an *unset* `VITE_VERIFY_API_URL` makes the console
report itself unconfigured and call nothing. `dev-proxy.ts` refuses to start the server for either,
and for a target carrying a path (which would produce `/api/verification/api/verification/v1/...`),
with the fix in the message. Dev only: `vite build` ignores it and no container sets it.

### Against local backends

Point each base at its own port and leave the proxy unset — the two services are separate processes
locally, and conflating them sends `GET /api/query/v1/verifiers` to verification-svc, which does not
serve it:

```bash
VITE_VERIFY_API_URL="http://localhost:5000"
VITE_QUERY_API_URL="http://localhost:5001"
```

### The paths, either way

The console adds the service prefix itself — `getApiBase()` in `src/lib/http.ts` is an *origin*, not
a base path:

```text
POST   {base}/api/verification/v1/verifications
GET    {base}/api/verification/v1/verifications/{job_id}
GET    {base}/api/verification/v1/verifications/{job_id}/events   (SSE)
GET    {base}/api/query/v1/verifiers                              (aggregator only)
```

`""` is a valid base meaning "same origin", and is what every deployed build uses. It must be `""`
and not `"/"` — `"/" + "/api/..."` is protocol-relative and resolves to a different host entirely.

## Real Testnet Verification Example

Use this target in the console:

```text
Network: Testnet
Contract ID: CAIDEXLNHK7WF2OC4CZ5Y3FHA5WNMAGIYSFKGKAUHVBGDVAZ2EQJTKEG
```

When the console asks for source evidence, use the source archive URL:

```text
https://raw.githubusercontent.com/jia57b/soroban-contract/main/ecf4bc7db300358330af9bc1a272267f1c870a849b68db0f768bcea4b6078533.tar.gz
```
