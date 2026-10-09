# Soroban Verifier

Workspace implementation of the `/` landing page and `/verify` verification submission page:

- landing page in the BlockSmith design system, the brand this service is hosted alongside;
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
public/                    design assets: 57blocks.png, archive-tick.svg
src/
  main.tsx                 React root: query client, router provider, sonner Toaster
  index.css                Tailwind entry + the few global element rules
  app/
    route-paths.ts           the declared route surface, read by the routes and by the renderer
    root-route.tsx           the one root route, the `/` redirect, and the not-found component
    router.tsx               assembles the route tree from each feature's exported routes
  components/ui/           shadcn/ui primitives, restyled to the design tokens:
                             button, input, label, select, collapsible, badge,
                             sonner, fade-up, hero-flow (the hero's WebGL
                             wash — see "The hero background" below),
                             dot-lattice (the canvas dot grid behind the closing
                             CTA and the console — see "The dot lattice" below),
                             typewriter (the hero headline)
  components/              site-nav + site-footer (the console and legal pages),
                             legal-links (the two legal documents, linked from both footers
                             and from the submission control), not-found (what an unrouted
                             path renders), and the two shared visual devices —
                             mono-chip, sealed-box — see "Shared devices" below
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
      components/            VerifyConsole (container) + one component per panel;
                             MonoLabel (the caption over a value) and ValueStrip
                             (caption + mono-chip) are what every result grid is made of
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
`pnpm run dev:web` only. **It is the only feature that renders another verifier's content**, which is
why it ships disabled by default, why the flag is read at container start rather than at build time
(so an operator can toggle it without a rebuild), and why it stays a single page rather than growing
its own feature tree.

Rules that keep this from drifting:

- **Cross feature imports go through `features/<name>/index.ts`.** Nothing outside a feature
  reaches into its `components/`, `hooks/`, or `utils/`.
- **Promote on second use, not on suspicion.** A helper stays in the feature that uses it until a
  second feature genuinely needs it, then it moves to `src/lib`, `src/hooks`, or `src/config` — the
  same ownership rule the backend applies to DTOs in
  [rule 7 of `docs/invariants.md`](../../docs/invariants.md).
- **Components render; hooks decide.** Panels take props and return markup. Anything stateful —
  submitting, streaming, storing — belongs in a hook under `hooks/`.
- **Copy is data.** Section text, status text, and field help live in `content.ts`/`constants.ts`,
  not inline in JSX, so wording changes never touch layout.
- **Styling is Tailwind utilities written inline in the JSX.** There are no feature stylesheets and
  no CSS modules: `index.css` holds Tailwind's three directives, a handful of base element rules,
  and one scrollbar utility — the scroll-triggered fade-up's two states, which a utility cannot
  express. Nothing else. Anything else that cannot be a utility is a named entry in
  `tailwind.config.js` and is still applied as a class.
- **UI primitives come from shadcn/ui, in `src/components/ui`.** They are copied into the repo, not
  imported from a package, so they are ours to restyle — and they are already restyled to the
  design tokens. A component that needs a button imports `@/components/ui/button`; it does not
  hand-roll one.
- **No raw colours in components.** Every colour is a named token — see below.

## Shared devices

Two components in `src/components/` are the visual language both the landing page and the console
speak. They live at the root rather than in `features/landing/`, where they started, because a second
feature uses them — the same promote-on-second-use rule as everything else here:

| Device | What it says | Landing | Console |
| --- | --- | --- | --- |
| `mono-chip` | one concrete value, set apart from the prose around it | a sample under a card | the real evidence: recipe, source, timings, comparison values |
| `sealed-box` | *this happened inside the sealed environment* | the hero diagram's rebuild lane | the whole `RebuildCard` — the inputs a real rebuild ran on |

**Colour marks a verdict, and nothing else.** That is why a `mono-chip` span takes a tone only for an
outcome, and why the console's selection controls are neutral: a chosen lookup mode is not a verdict.
The accent belongs to a verdict or a highlight, never to a selection or an eyebrow.

**`HashCompare` is deliberately not here.** It draws two digests chunk by chunk and marks the chunks
that disagree, which reads as *where* they disagree. On the landing page that is honest — the digests
are illustrative and `content/trust-model.ts` says so. On a real result it is not: SHA-256 avalanches,
so two digests that differ at all differ in every chunk, and the device would promise a locality that
does not exist. The console states the verdict and leaves both digests in the raw diagnostics.

## The hero background

`components/ui/hero-flow.tsx` is the landing hero's background: one fragment shader drawing a
domain-warped noise field as pale ink, on a plain WebGL context with no library. The pointer, and
four slow wandering sources while nobody is moving it, add a local swirl to the warp; the wanderers
hand over to the pointer within a quarter of a second and come back two seconds after it stops.

- **It does not mount under `prefers-reduced-motion: reduce`.** The hero's own static wash is the
  design; the flow is an enhancement on top of it, switched off rather than slowed down.
- **The palette is pale yellows** (`HeroSection`'s `heroFlowColors`), all at hue 45° or above. The
  accent itself is not in it: "Shared devices" above reserves the accent for a verdict or a
  highlight, and an ambient wash painted the same gold would spend it.
- **It writes premultiplied colour** — `gl_FragColor` is `color * alpha, alpha` and the context is
  created with `premultipliedAlpha: true`. Straight alpha over a white page darkens the backdrop
  instead of tinting it, and reads as grey smoke.
- **It renders at half the device resolution** and is stretched by CSS; the field is soft enough
  that the difference does not show, and it quarters the fragment work.

It pauses when the hero scrolls out of view or the tab is hidden, and it reads the pointer from a
window listener with the canvas `pointer-events-none`, so the CTA and the nav keep their clicks.

## The dot lattice

`components/ui/dot-lattice.tsx` draws a canvas grid of accent-coloured dots that move away from the
pointer and spring back. `DotLatticeDark` is the closing CTA's background; `DotLatticeLight` sits
behind the console, faded out between `fadeStart` and `fadeEnd` pixels from the top. It is
`pointer-events: none`, so its section is `relative` and the content is lifted above it with
`relative` — nothing else has to know it is there.

- **Its positioning lives in `index.css`.** The component renders `.dot-lattice` and expects that
  class to place it, beside `.fade-up` in `@layer components`; the canvas is sized from that
  container, so the container has to be the positioned element.
- **The dot colour is written out, not referenced.** A canvas `fillStyle` takes a colour rather than
  a utility class, so the accent is one `ACCENT_RGB` constant.
- **It only animates while something moves.** It draws once, then runs its frame loop only while the
  pointer is near or a dot is still settling, and not at all while it is off screen or the tab is
  hidden. Under `prefers-reduced-motion` it draws the still grid and ignores the pointer.

## Routing

`src/app/route-paths.ts` is the declared route surface. Two consumers read it: each feature's `path:`
declaration, and `spa-routes.ts`, whose Vite plugin renders it into `dist/spa-routes.conf` at build
time — the nginx `location` allowlist the deployed origin serves the entry document from. Everything
that is neither one of those routes nor a real file in `dist/` answers **404**, carrying
`components/not-found.tsx`; the router renders the same component after a client-side navigation.

Adding a route means adding it to `route-paths.ts`. `test/route-surface.spec.tsx` fails when the
declared set and the mounted tree disagree, and `pnpm run check:host-routing` (repository root) serves
the real `docker/web-nginx.conf` on nginx and probes what each position answers — see
[`docs/specs/configuration.md`](../../docs/specs/configuration.md) §5 for the host routing contract.

`<Link to="…">` call sites keep their path literals rather than referencing `ROUTE_PATHS` — TanStack
type-checks those against the built tree, which is a stronger guarantee than a shared constant.

## Legal pages

`/terms` and `/privacy` are **the reference deployment's documents** — the terms under which
57Blocks operates its hosted instance. They are not part of the software's contract: the software is
Apache-2.0 ([rule 26 of `docs/invariants.md`](../../docs/invariants.md)), and the footer's
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

`tailwind.config.js` is the single definition of the palette. Its values are BlockSmith's — the brand
this service is hosted alongside — and the group names are this app's own, so a token says what a
value is *for* rather than what colour it is. The product keeps its own name and mark: the visual
language is shared, the identity is not, and neither site links to the other.

| Group | What it is |
| --- | --- |
| `ink.*` | Neutral scale: `ink` (#101828) headings, solid buttons and the dark section, `ink-body` copy (#4a5565), `ink-soft` eyebrows, `ink-label` panel sub-headings, `ink-value` diagnostics values, `ink-warm` ghost buttons and recent-job timestamps, `ink-mute` footer/meta and every mono caption |
| `yellow.*` | The one accent (#f5d35a), plus `soft`/`pale` washes, `bright` hover, `deep` (#a77d0e) the text-safe member, `shade` the ◆ glyph, `dot` the queued status dot |
| `surface.*` | Light fills, in stacking order: white → `alt` tinted (#f6f7fb), also every mono strip → `hover` → `hero` wash → `track`/`chip` |
| `line.*` | Hairlines: `line` (#e5e7eb) everywhere, `strong` console + inputs, `hero`, `soft` flow track, `mute`, `quiet` |
| `dark.*` | The closing CTA's near-black band and its cards: `card`, `line`, `rule`, `hover`, `fg`, `cmd`, `text`, `dim`, `bright` |
| `success.* warning.* danger.* neutral.*` | Verdict tones. Within a group, `fg` is text, `surface` a panel fill, `badge` a pill fill, `dot` the recent-jobs status dot |

Also owned here, and used the same way: `maxWidth.shell` (1440px, the page width) and
`maxWidth.console` (1120px, the console's column — see the token's own comment for why it is not 900),
`boxShadow.panel`/`dropdown`/`float`/`focus`, and the two families in
`fontFamily` — `sans` (Inter) and `mono` (JetBrains Mono).

Conventions:

- **A raw `text-[#abc123]` in a component is a bug report against the config.** Add the token there,
  then use it. `grep -rn '\[#' src` should return nothing.
- **Alpha comes from the opacity modifier on a token** — `text-ink/[0.66]`, `bg-surface/60`,
  `border-ink/[0.16]` — not from a second hex.
- **`theme()` is allowed inside an arbitrary value** where Tailwind has no utility for the property,
  e.g. the pipeline numeral's highlight `shadow-[inset_0_-0.28em_0_theme(colors.yellow.DEFAULT)]`.
  The colour is still the token.
- **The accent is never text on white.** At #f5d35a that is under 2:1; `yellow-deep` is the member of
  the family that clears AA, and the rest are fills and rules.
- **Fonts are self-hosted, always** (`src/fonts.ts`). A `@import` from a font CDN discloses every
  visitor's IP to it, which is the request this console removed and may not reintroduce.

Card and control idiom, so a new component matches the ones beside it:

- a card is `rounded-xl border border-line bg-surface`, lifting on hover with
  `transition-all duration-300 hover:-translate-y-1 hover:shadow-lg`;
- a floating console panel is the same, plus `shadow-panel`;
- a button is a pill, solid `ink` for the primary action, `accent` on the dark band, bordered white
  otherwise, ending in a `PillIcon` badge whose glyph slides on hover (`animate-arrow-slide`);
- a section is `px-4 md:px-20 py-16 md:py-24`, alternating white and `surface-alt` down the page.

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
where one ALB fronts the console and both APIs by path (see
[`docs/specs/configuration.md`](../../docs/specs/configuration.md) §5, the host routing contract).

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
