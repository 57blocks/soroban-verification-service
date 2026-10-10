/** The `(cliver, rsver)` pairs the composition gate composes, and why each one is in the list. */

/** @typedef {"composes" | "either"} Expectation */

/**
 * @typedef {object} CompositionPair
 * @property {string} id
 * @property {string} cliver
 * @property {string} rsver
 * @property {Expectation} expect
 * @property {string[]} dimensions
 * @property {string} why
 */

export const DEFAULT_PAIR_ID = "baseline-cli23.2.1-rust1.90.0";

/** @type {readonly CompositionPair[]} */
export const COMPOSITION_PAIRS = [
  {
    id: DEFAULT_PAIR_ID,
    cliver: "23.2.1#496ac35be7a7d8d923fcde9bbbc650ee593d1f6f",
    rsver: "1.90.0",
    expect: "composes",
    dimensions: ["cli-release-shape", "rust-toolchain"],
    why:
      "The gate's long-standing default. Retained unchanged so this table cannot quietly drop the one " +
      "row with a known-good history, and so a red matrix can always be bisected against a row that " +
      "was green yesterday.",
  },
  {
    id: "current-e2e-cli27.0.0-rust1.96.0",
    cliver: "27.0.0#5a7c5fe76530bf4248477ac812fc757146b98cc4",
    rsver: "1.96.0",
    expect: "composes",
    dimensions: ["cli-release-shape", "rust-toolchain"],
    why:
      "The only pair the E2E fixtures use — every purpose-built contract in " +
      "`test/integration/fixtures/e2e-fixtures.dev.json` records it. Demand rank 13, ~1.8% of live " +
      "class-B contracts. In the list because a break here breaks the entire E2E suite, so it should " +
      "not be found by the E2E suite.",
  },
  {
    id: "demand-01-cli25.1.0-rust1.95.0",
    cliver: "25.1.0#a048a57a75762458b487052e0021ea704a926bee",
    rsver: "1.95.0",
    expect: "either",
    dimensions: ["cli-release-shape", "rust-toolchain"],
    why:
      "Demand rank 1: 813 live contracts, 25.2% on its own. No official image pairs 25.1.0 with " +
      "1.95.0 — official gives 25.1.0 the 1.90.0 build — so contracts on this pair can only ever be " +
      "verified through composition. Never composed before this table existed.",
  },
  {
    id: "demand-02-cli25.2.0-rust1.95.0",
    cliver: "25.2.0#28484880988199233a7e8e87c97cb12dac323cb3",
    rsver: "1.95.0",
    expect: "either",
    dimensions: ["cli-release-shape"],
    why:
      "Demand rank 2: 326 live contracts. Shares rust 1.95.0 with rank 1, so it isolates the CLI half " +
      "— if rank 1 fails and this passes, the fault is in 25.1.0's release, not in the toolchain.",
  },
  {
    id: "demand-03-cli26.0.0-rust1.95.0",
    cliver: "26.0.0#60f7458e7ecffddf2f2d91dc6d0d2db4fab03ecc",
    rsver: "1.95.0",
    expect: "either",
    dimensions: ["cli-release-shape"],
    why:
      "Demand rank 3: 240 live contracts. 26.x is a version range published on Docker " +
      "Hub with no corresponding `stellar-cli-docker` release, so its release assets are the least " +
      "likely in the list to match the shape the resolver assumes.",
  },
  {
    id: "oldest-major-cli23.3.0-rust1.91.1",
    cliver: "23.3.0#08473ac20016c369067ce0dbca91d9595e72d6d4",
    rsver: "1.91.1",
    expect: "either",
    dimensions: ["cli-release-shape", "rust-toolchain"],
    why:
      "Demand rank 4: 150 live contracts, and the oldest CLI major with real demand. Together with the " +
      "27.0.0 row it brackets the whole 23.x–27.x release range, which is the span an asset-naming " +
      "change could hide in.",
  },
  {
    id: "oldest-cli-23.2.0-rust1.90.0",
    cliver: "23.2.0#8c559e832fd969aa469784b66e70891fadf94f0a",
    rsver: "1.90.0",
    expect: "either",
    dimensions: ["cli-release-shape", "cli-target-choice"],
    why:
      "Closes the one gap left by the 2026-08-19 finding. The baseline row proved stellar-cli **23.2.1** " +
      "emits `--target=wasm32v1-none` itself, which is what makes rejecting `rsver` 1.81.0 correct rather " +
      "than a compromise: the CLI asks for a target Rust 1.81.0 cannot supply, so no template could serve " +
      "such a contract without overriding the CLI's own choice. But 23.2.0 is the corpus's oldest CLI and " +
      "was never observed. If it emits `wasm32-unknown-unknown` instead, contracts pairing it with 1.81.0 " +
      "are genuinely buildable and we are genuinely refusing them.\n\n" +
      "The rsver is deliberately a known-good one, so the row isolates the CLI: read " +
      "`assertBuildsAContract`'s `cargo rustc … --target=` line in this row's log — that string is the " +
      "answer, whether the row passes or fails.",
  },
  {
    id: "floor-rsver-1.81.0",
    cliver: "27.0.0#5a7c5fe76530bf4248477ac812fc757146b98cc4",
    rsver: "1.81.0",
    expect: "either",
    dimensions: ["rust-toolchain"],
    why:
      "The lowest stable `rsver` among class-B contracts on chain is 1.81.0. Pinned to a CLI " +
      "already proven above so a failure isolates to the Rust half. ANSWERED 2026-08-19: `wasm32v1-none` " +
      "arrived in Rust 1.84.0, so 1.81.0 does not have it and no shipped template can serve this pair. " +
      "The row now asserts the *shape of the refusal* rather than the outcome — it must end on " +
      "`toolchain_target_unavailable` from the pre-flight in `components.ts`, in seconds and before any " +
      "download, NOT on `image_build_failed` seven minutes later. The outcome it exists to rule out is " +
      "an image that builds anyway and silently produces bytes from a different target.",
  },
  {
    id: "rev-mismatch-cli27.0.0",
    cliver: "27.0.0#93e1b1671f14830662766c005138b19095fe9307",
    rsver: "1.96.0",
    expect: "either",
    dimensions: ["cliver-rev"],
    why:
      "The cliver's rev half, which no layer had ever exercised end to end. Both other coordinates are " +
      "deliberately identical to the `current-e2e` row above — same version, same rsver, a release that " +
      "is known to compose — so the **only** difference is a rev that names a commit between releases. " +
      "That isolates it completely: this row can only fail for the reason it is here to observe.\n\n" +
      "The expected end is `smoke_test_disagreed`. `components.ts` addresses the *version* as a release " +
      "tag, so the download succeeds and the image builds; `image.ts`'s smoke test then compares the " +
      "*rev* against what the installed binary reports and finds `5a7c5fe7…` where `93e1b167…` was " +
      "recorded (`image.ts:184-203`, and `:189` names this exact case). What the row rules out is the " +
      "opposite outcome — an image that composes and is **pushed** under a recipe claiming a build " +
      "nobody made, which would let a rebuilt Wasm stamp a `<version>#<rev>` the contract never " +
      "recorded.\n\n" +
      "Costs a full compose to answer, and is worth it exactly once: `composer.service.spec.ts` proves " +
      "the *gate* refuses a disagreeing smoke test against a stub, but a stub cannot tell us whether a " +
      "real image disagrees in the first place.\n\n" +
      "ANSWERED 2026-08-19, exactly as predicted. The image built and ran; the smoke test reported\n" +
      "  rustc   : rustc 1.96.0 (ac68faa20 2026-05-25)\n" +
      "  stellar : stellar 27.0.0 (5a7c5fe76530bf4248477ac812fc757146b98cc4)\n" +
      "and the row ended `smoke_test_disagreed` — 'the composed image does not report the pair it was " +
      "asked to produce (requested 27.0.0#93e1b167…)'. So the version half resolved and installed " +
      "cleanly, the rev half disagreed, and the gate refused to push. The outcome this row exists to " +
      "rule out — a pushed image under a recipe claiming a build nobody made — did not happen.\n\n" +
      "★ Read `assertChainFormClivers()`'s note next to this. `smoke_test_disagreed` has now been seen " +
      "from **two** causes on the same day: a bare cliver with no `#rev` (test-data bug, that morning) " +
      "and this genuine rev disagreement. The reason string is identical and cannot tell them apart. " +
      "What separates them structurally is that the bare-cliver case can no longer reach a compose at " +
      "all — the shape assertion runs before anything is spent — so any `smoke_test_disagreed` this " +
      "table produces today is a real disagreement. That property is the reason the assertion is worth " +
      "more than the seven minutes it saves.",
  },
  {
    id: "reject-unreleased-cli",
    cliver: "99.0.0#0000000000000000000000000000000000000000",
    rsver: "1.96.0",
    expect: "either",
    dimensions: ["rejection"],
    why:
      "Negative control. `components.spec.ts` proves " +
      "`unreleased_cli` against a stubbed 404; this proves the same against GitHub's real answer, which " +
      "is what makes the other rows' green meaningful — a matrix that cannot go red for a version that " +
      "does not exist is not observing anything.",
  },
];

export const CORPUS_STABLE_RSVERS = [
  "1.81.0",
  "1.84.0",
  "1.84.1",
  "1.85.0",
  "1.86.0",
  "1.87.0",
  "1.88.0",
  "1.89.0",
  "1.90.0",
  "1.91.1",
  "1.92.0",
  "1.93.0",
  "1.93.1",
  "1.94.0",
  "1.94.1",
  "1.95.0",
  "1.96.0",
  "1.96.1",
  "1.97.0",
  "1.97.1",
];

export function assertChainFormClivers() {
  const bare = COMPOSITION_PAIRS.filter((pair) => !/#.+$/.test(pair.cliver));
  if (bare.length === 0) return;
  throw new Error(
    `composition-pairs.mjs: ${bare.length} row(s) carry a cliver with no '#<rev>': ` +
      `${bare.map((pair) => `${pair.id} (${pair.cliver})`).join(", ")}.\n` +
      "A recorded cliver is `<version>#<rev>`; a bare version is only a normalisation. Without the " +
      "rev, `smokeTestComposedImage` fails closed and the row reports " +
      "`smoke_test_disagreed` about a perfectly good image. Resolve the release commit with:\n" +
      "  curl -s https://api.github.com/repos/stellar/stellar-cli/git/ref/tags/v<version> | jq -r .object.sha",
  );
}

export const NAMED_COMPOSITION_FAILURES = [
  "unaddressable_cliver",
  "toolchain_target_unavailable",
  "unreleased_cli",
  "component_unreachable",
  "ambiguous_release_asset",
  "asset_digest_unavailable",
  "component_too_large",
  "component_checksum_mismatch",
  "cli_archive_extract_failed",
  "image_build_failed",
  "smoke_test_failed",
  "smoke_test_disagreed",
  "runtime_surface_differs",
];
