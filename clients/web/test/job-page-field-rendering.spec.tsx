import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { RebuildCard } from "@/features/verification/components/RebuildCard";
import { ResultPanel } from "@/features/verification/components/ResultPanel";
import type { ArtifactRecipeFacts } from "@/features/verification/types";
import {
  rebuildProvenance,
  wasmStatusUrlFromReportUrl,
} from "@/features/verification/utils/rebuild-provenance.util";
import { hashChunks } from "@/features/verification/utils/format.util";
import { resultSummaryEntries } from "@/features/verification/utils/result.util";

const WASM = "7944a96d512f6e51532687811cc0c932505b0c051be9d351f5332739d70f753c";
const ARTIFACT_SHA = "c72b50bea1d5e285fbee032471f1f5ece22cf4f0272603da523b490b5a29e62b";
const SOURCE_SHA = "cf09f58efa8e9b4e433d67933030cce719e1e4e133e46a3fb1d3f2151300dfe5";
const REPORT_URL = `https://results.dev.sv.example.com/reports/${ARTIFACT_SHA}.json`;
const SOURCE_URI =
  "https://github.com/reflector-network/reflector-contract/archive/refs/tags/v6.0.0_reflector-pulse-contract_cli25.1.0.tar.gz";

/** The real `sandbox_diagnostics` off dev job `9cfbfecd`, trimmed to the fields the display reads. */
const DIAGNOSTICS = {
  runner: "docker_build_image_rebuild",
  build_image:
    "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/sv-dev-composed-environments@sha256:945f7e8c",
  container_manifest_path: "/source/Cargo.toml",
  rebuilt_wasm_hash: WASM,
  expected_wasm_hash: WASM,
  rebuilt_wasm_size_bytes: 19418,
  docker_cap_drop: "ALL",
  docker_security_opt: "no-new-privileges",
  docker_network: "none",
  docker_read_only: true,
  docker_user: "1000:1000",
  docker_cpus: "2",
  docker_memory: "2g",
  docker_pids_limit: "512",
  dependency_prefetch: "cargo_vendor",
  dependency_prefetch_policy: "allowlist",
  cargo_net_offline: true,
  rustup_toolchain: "1.94.0-aarch64-unknown-linux-gnu",
  timed_out: false,
  exit_code: 0,
  // The verifier's own pin. Must never reach the page as this build's CLI — it is 28.0.0 while the contract
  // declares, and the image installs, 25.1.0.
  reference_alignment: {
    repo: "stellar/stellar-cli",
    version: "v28.0.0",
    read_from: "docker/stellar-cli.pin",
  },
};

/** `build_recipe` off the same job's published report — the only place the pair is published. */
const RECIPE: ArtifactRecipeFacts = {
  recipeSource: "submitted",
  buildIsolation: "network_isolated",
  pair: { cliver: "25.1.0#a048a57a75762458b487052e0021ea704a926bee", rsver: "1.94.0" },
  environment: {
    kind: "composed",
    trustLevel: "upstream_pinned",
    templateVersion: "v3",
    imageDigest: "sha256:945f7e8c62b13ac316e788417c65be65728d61800d3fbdbdc04324eb04e3dd62",
    recipeSha256: "d63acc7e6403e50fdb583633b99d0096a3e063598354f979097b3f89123e9c37",
  },
  components: [
    { kind: "base_image", source: "docker.io/library/buildpack-deps", sha256: "sha256:645b62ac" },
    {
      kind: "rust_toolchain",
      source: "https://static.rust-lang.org/rustup/archive/1.29.0/",
      sha256: "sha256:9732d6c5",
    },
    {
      kind: "stellar_cli",
      source:
        "https://github.com/stellar/stellar-cli/releases/download/v25.1.0/stellar-cli-25.1.0-aarch64-unknown-linux-gnu.tar.gz",
      sha256: "sha256:15c68afa",
    },
    {
      kind: "runtime_library",
      source: "https://snapshot.debian.org/archive/debian/",
      sha256: "sha256:2a423794",
    },
  ],
  buildOptions: ["--package=reflector-pulse-contract", "--optimize"],
  metadataReplay: ["source_repo=github:reflector-network/reflector-contract"],
};

const EMPTY_RECIPE: ArtifactRecipeFacts = {
  recipeSource: null,
  buildIsolation: null,
  pair: null,
  environment: null,
  components: [],
  buildOptions: [],
  metadataReplay: [],
};

const VERIFIED_RESULT = {
  status_summary: "verified",
  wasm_hash: WASM,
  rebuilt_wasm_hash: WASM,
  matched: true,
  verification_path: "retroactive_manual",
  verified_at: "2026-09-01T02:49:46.066Z",
  artifact_url: REPORT_URL,
  artifact_sha256: ARTIFACT_SHA,
  sandbox_diagnostics: DIAGNOSTICS,
};

/** The same job, had the rebuild produced different bytes: one chunk of the digest differs. */
const MISMATCH_RESULT = {
  ...VERIFIED_RESULT,
  status_summary: "mismatch",
  rebuilt_wasm_hash: `${WASM.slice(0, 40)}ffffffff${WASM.slice(48)}`,
  matched: false,
};

const groupsFor = (recipe: ArtifactRecipeFacts = RECIPE) =>
  rebuildProvenance({
    recipe,
    sourceUri: SOURCE_URI,
    sourceSha256: SOURCE_SHA,
    diagnostics: DIAGNOSTICS,
  });

const renderRebuild = (recipe: ArtifactRecipeFacts = RECIPE) =>
  render(<RebuildCard groups={groupsFor(recipe)} />);

/**
 * Rendering the pin among the build inputs said this contract was built with 28.0.0, which the image itself
 * contradicts.
 */
describe("the CLI shown is the one that built the contract", () => {
  test("names the declared cliver, and never the verifier's reference pin", () => {
    const { container } = renderRebuild();

    expect(screen.getByText("Stellar CLI (cliver)")).toBeInTheDocument();
    expect(screen.getByText(/^25\.1\.0#a048a57a/)).toBeInTheDocument();
    expect(container.textContent).not.toContain("28.0.0");
    expect(container.textContent).not.toContain("stellar-cli.pin");
  });

  // The composed image's own component list agrees with the declared pair, which is why showing the pin was
  // wrong rather than merely confusing.
  test("the composed image installed the declared CLI, not the pin", () => {
    const cli = RECIPE.components.find((component) => component.kind === "stellar_cli");

    expect(cli?.source).toContain("v25.1.0");
    expect(cli?.source).not.toContain("v28.0.0");
  });
});

/**
 * A reader must be able to tell what the contract declared — which a submitter cannot influence — from what the
 * verifier constructed to reproduce it.
 */
describe("parameters are grouped by who chose them", () => {
  test("the pair and the chain-recorded metadata are the contract's own", () => {
    const declared = groupsFor().find((group) => group.key === "declared");

    expect(declared?.title).toBe("Declared by the contract");
    expect(declared?.fields.map((field) => field.key)).toEqual([
      "cliver",
      "rsver",
      "meta_source_repo",
    ]);
    expect(declared?.origin).toMatch(/on-chain contractmetav0/);
  });

  // The verifier's own environment is no longer a group: it described the verifier rather than the contract,
  // and the raw diagnostics keep every field of it.
  test("the card holds only the contract's declaration and the recipe", () => {
    expect(groupsFor().map((group) => group.key)).toEqual(["declared", "recipe"]);
  });

  test("the source repository is a link", () => {
    renderRebuild();

    expect(
      screen.getByRole("link", { name: /reflector-network\/reflector-contract$/ }),
    ).toHaveAttribute("href", "https://github.com/reflector-network/reflector-contract");
  });

  test("the recipe group's heading follows recipe_source", () => {
    expect(groupsFor().find((group) => group.key === "recipe")?.title).toBe(
      "Supplied with the submission",
    );
    expect(
      groupsFor({ ...RECIPE, recipeSource: "on_chain_metadata" }).find(
        (group) => group.key === "recipe",
      )?.title,
    ).toBe("Reproduced from the contract's own recipe");
  });

  test("an unstated recipe_source claims no provenance for those fields", () => {
    const recipeGroup = groupsFor({ ...RECIPE, recipeSource: null }).find(
      (group) => group.key === "recipe",
    );

    expect(recipeGroup?.title).toBe("Build inputs");
    expect(recipeGroup?.origin).toMatch(/did not state where the recipe came from/);
  });

  test("a group with nothing to show is dropped, not rendered empty", () => {
    expect(
      rebuildProvenance({
        recipe: EMPTY_RECIPE,
        sourceUri: null,
        sourceSha256: null,
        diagnostics: undefined,
      }),
    ).toEqual([]);
  });

  test("the card renders nothing when the report carried no recipe", () => {
    const { container } = render(<RebuildCard groups={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

/**
 * The verdict is a claim about two digests, and the landing page already has the device for showing that claim:
 * the comparison chunk by chunk. A reader should be able to see *which* chunk differs, not be told it did.
 */
describe("the verdict shows the two digests it is about", () => {
  const differingChunk = (result: Record<string, unknown>) =>
    hashChunks(result.wasm_hash)!.findIndex(
      (chunk, index) => chunk !== hashChunks(result.rebuilt_wasm_hash)![index],
    );

  test("splits a digest into the chunks the comparison is read in", () => {
    expect(hashChunks(WASM)).toEqual([
      "7944a96d",
      "512f6e51",
      "53268781",
      "1cc0c932",
      "505b0c05",
      "1be9d351",
      "f5332739",
      "d70f753c",
    ]);
  });

  // Hex case is not significant, so two spellings of one digest must not read as a mismatch.
  test("a digest that differs only in case is the same digest", () => {
    expect(hashChunks(WASM.toUpperCase())).toEqual(hashChunks(WASM));
  });

  // A malformed hash compared chunk by chunk would mark chunks as differing for a reason that is not the
  // rebuild, so there is nothing to render.
  test("refuses anything that is not a digest", () => {
    expect(hashChunks("not a hash")).toBeNull();
    expect(hashChunks(WASM.slice(0, 63))).toBeNull();
    expect(hashChunks(undefined)).toBeNull();
  });

  test("a verified result shows both digests, agreeing", () => {
    render(<ResultPanel state="verified" result={VERIFIED_RESULT} />);

    const compare = screen.getByTestId("digest-compare");
    expect(compare.textContent).toContain("7944a96d");
    expect(compare.textContent).toContain("d70f753c");
  });

  test("a mismatch marks the chunk that differs, and not the ones that agree", () => {
    render(<ResultPanel state="mismatch" result={MISMATCH_RESULT} />);

    const index = differingChunk(MISMATCH_RESULT);
    expect(index).toBeGreaterThanOrEqual(0);

    const deployed = hashChunks(MISMATCH_RESULT.wasm_hash)!;
    expect(screen.getAllByText(deployed[index]!)[0]).toHaveClass("text-danger-fg");
    expect(screen.getAllByText(deployed[0]!)[0]).not.toHaveClass("text-danger-fg");
  });

  // A job that never rebuilt has one digest, and one digest is not a comparison.
  test("renders nothing without both digests", () => {
    const noRebuild: Record<string, unknown> = { ...MISMATCH_RESULT };
    delete noRebuild.rebuilt_wasm_hash;
    render(<ResultPanel state="build_failed" result={noRebuild} />);

    expect(screen.queryByTestId("digest-compare")).not.toBeInTheDocument();
  });
});

describe("both published documents are offered", () => {
  test("links the report and the wasm status object", () => {
    render(<ResultPanel state="verified" result={VERIFIED_RESULT} />);

    expect(screen.getByRole("link", { name: new RegExp(ARTIFACT_SHA) })).toHaveAttribute(
      "href",
      REPORT_URL,
    );
    expect(screen.getByRole("link", { name: new RegExp(`wasms/${WASM}`) })).toHaveAttribute(
      "href",
      `https://results.dev.sv.example.com/wasms/${WASM}.json`,
    );
  });

  test("derives the status-object URL from the report's own result root", () => {
    expect(wasmStatusUrlFromReportUrl(REPORT_URL, WASM)).toBe(
      `https://results.dev.sv.example.com/wasms/${WASM}.json`,
    );
  });

  // A guessed link is worse than no link: it would 404 under the reader's own verification.
  test("fails closed on anything that is not a report key", () => {
    expect(wasmStatusUrlFromReportUrl("https://example.com/elsewhere/x.json", WASM)).toBeUndefined();
    expect(wasmStatusUrlFromReportUrl("not a url", WASM)).toBeUndefined();
    expect(wasmStatusUrlFromReportUrl(REPORT_URL, undefined)).toBeUndefined();
    expect(wasmStatusUrlFromReportUrl(undefined, WASM)).toBeUndefined();
  });

  test("the digest rides the report link rather than being its own tile", () => {
    render(<ResultPanel state="verified" result={VERIFIED_RESULT} />);

    expect(resultSummaryEntries(VERIFIED_RESULT).map(([key]) => key)).not.toContain(
      "artifact_sha256",
    );
    expect(screen.getByText(/integrity digest/i)).toBeInTheDocument();
  });

  // The hashes agreeing is what the verdict says; repeating the rebuilt one added nothing.
  test("the rebuilt hash is not a result tile", () => {
    const { container } = render(<ResultPanel state="verified" result={VERIFIED_RESULT} />);

    expect(resultSummaryEntries(VERIFIED_RESULT).map(([key]) => key)).not.toContain(
      "rebuilt_wasm_hash",
    );
    expect(container.textContent).not.toMatch(/Rebuilt Wasm hash/);
  });
});

/**
 * The rendered sandbox configuration described the verifier rather than the contract; every field of it is
 * still in the JSON one click further in.
 */
describe("the diagnostics disclosure keeps the command and the JSON", () => {
  test("renders no sandbox configuration", () => {
    const { container } = render(<ResultPanel state="verified" result={VERIFIED_RESULT} />);
    const text = container.textContent ?? "";

    expect(text).toMatch(/Developer diagnostics/);
    expect(text).toMatch(/exact command, raw JSON/);
    expect(text).not.toMatch(/no privilege escalation/);
    expect(text).not.toMatch(/Docker (CPUs|memory|network|rootfs|user)/);
    expect(text).not.toMatch(/\bSandbox\b/);
  });
});
