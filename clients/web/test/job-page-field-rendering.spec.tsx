import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { RebuildCard } from "@/features/verification/components/RebuildCard";
import { ResultPanel } from "@/features/verification/components/ResultPanel";
import type { ArtifactRecipeFacts } from "@/features/verification/types";
import {
  rebuildProvenance,
  wasmStatusUrlFromReportUrl,
} from "@/features/verification/utils/rebuild-provenance.util";
import { resultSummaryEntries } from "@/features/verification/utils/result.util";

const WASM = "7944a96d512f6e51532687811cc0c932505b0c051be9d351f5332739d70f753c";
const ARTIFACT_SHA = "c72b50bea1d5e285fbee032471f1f5ece22cf4f0272603da523b490b5a29e62b";
const SOURCE_SHA = "cf09f58efa8e9b4e433d67933030cce719e1e4e133e46a3fb1d3f2151300dfe5";
const REPORT_URL = `https://results.dev.sv.example.com/reports/${ARTIFACT_SHA}.json`;
const SOURCE_URI =
  "https://github.com/reflector-network/reflector-contract/archive/refs/tags/v6.0.0_reflector-pulse-contract_cli25.1.0.tar.gz";

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
  reference_alignment: {
    repo: "stellar/stellar-cli",
    version: "v28.0.0",
    read_from: "docker/stellar-cli.pin",
  },
};

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

const inputsFor = (recipe: ArtifactRecipeFacts = RECIPE, sourceSha256: string | null = SOURCE_SHA) =>
  rebuildProvenance({
    recipe,
    sourceUri: SOURCE_URI,
    sourceSha256,
    diagnostics: DIAGNOSTICS,
  });

const renderRebuild = (recipe: ArtifactRecipeFacts = RECIPE) =>
  render(<RebuildCard inputs={inputsFor(recipe)} />);

const keysOf = (recipe: ArtifactRecipeFacts = RECIPE) =>
  inputsFor(recipe)?.fields.map((field) => field.key);

describe("the CLI shown is the one that built the contract", () => {
  test("names the declared cliver, and never the verifier's reference pin", () => {
    const { container } = renderRebuild();

    expect(screen.getByText("Stellar CLI (cliver)")).toBeInTheDocument();
    expect(screen.getByText(/^25\.1\.0#a048a57a/)).toBeInTheDocument();
    expect(container.textContent).not.toContain("28.0.0");
    expect(container.textContent).not.toContain("stellar-cli.pin");
  });

  test("the composed image installed the declared CLI, not the pin", () => {
    const cli = RECIPE.components.find((component) => component.kind === "stellar_cli");

    expect(cli?.source).toContain("v25.1.0");
    expect(cli?.source).not.toContain("v28.0.0");
  });
});

describe("the rebuild inputs are one deduplicated list", () => {
  const ON_CHAIN_RECIPE: ArtifactRecipeFacts = {
    ...RECIPE,
    recipeSource: "on_chain_metadata",
    pair: null,
    buildOptions: ["--locked", "--package=counter-contract", "--optimize"],
    metadataReplay: [
      "bldimg=docker.io/stellar/stellar-cli@sha256:a8a41b70",
      `source_sha256=${SOURCE_SHA}`,
      "bldopt=--optimize",
      "home_domain=example.org",
    ],
  };

  test("holds only the parameters a rebuild needs, in a fixed order", () => {
    expect(keysOf()).toEqual([
      "source_repo",
      "source_uri",
      "source_sha256",
      "cliver",
      "rsver",
      "bldopt",
      "manifest",
    ]);
  });

  test("a value the contract also declares appears once, tagged on-chain", () => {
    const fields = inputsFor(ON_CHAIN_RECIPE)?.fields ?? [];

    expect(fields.filter((field) => field.key === "source_sha256")).toHaveLength(1);
    expect(fields.find((field) => field.key === "source_sha256")?.onChain).toBe(true);
    expect(fields.find((field) => field.key === "bldimg")?.onChain).toBe(true);
    expect(fields.map((field) => field.key)).not.toContain("meta_home_domain");
    expect(fields.map((field) => field.value)).not.toContain("example.org");
  });

  test("declared and effective build options merge without repeats", () => {
    const bldopt = inputsFor(ON_CHAIN_RECIPE)?.fields.find((field) => field.key === "bldopt");

    expect(bldopt?.value).toBe("--locked --package=counter-contract --optimize");
    expect(bldopt?.onChain).toBe(false);
  });

  test("the source SHA-256 falls back to the contract's declaration", () => {
    const sha = rebuildProvenance({
      recipe: ON_CHAIN_RECIPE,
      sourceUri: null,
      sourceSha256: null,
    })?.fields.find((field) => field.key === "source_sha256");

    expect(sha?.value).toBe(SOURCE_SHA);
  });

  test("the source repository is a link, tagged on-chain", () => {
    renderRebuild();

    expect(
      screen.getByRole("link", { name: /reflector-network\/reflector-contract$/ }),
    ).toHaveAttribute("href", "https://github.com/reflector-network/reflector-contract");
    expect(screen.getAllByText("on-chain").length).toBeGreaterThan(0);
  });

  test("the subtitle follows recipe_source", () => {
    expect(inputsFor()?.origin).toMatch(/supplied with the submission/i);
    expect(inputsFor(ON_CHAIN_RECIPE)?.origin).toMatch(/contract's own on-chain recipe/);
    expect(inputsFor({ ...RECIPE, recipeSource: null })?.origin).toMatch(
      /did not state where the recipe came from/,
    );
  });

  test("nothing to show is null, not an empty card", () => {
    expect(
      rebuildProvenance({
        recipe: EMPTY_RECIPE,
        sourceUri: null,
        sourceSha256: null,
        diagnostics: undefined,
      }),
    ).toBeNull();
  });

  test("the card renders nothing when the report carried no recipe", () => {
    const { container } = render(<RebuildCard inputs={null} />);
    expect(container).toBeEmptyDOMElement();
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

  test("the rebuilt hash is not a result tile", () => {
    const { container } = render(<ResultPanel state="verified" result={VERIFIED_RESULT} />);

    expect(resultSummaryEntries(VERIFIED_RESULT).map(([key]) => key)).not.toContain(
      "rebuilt_wasm_hash",
    );
    expect(container.textContent).not.toMatch(/Rebuilt Wasm hash/);
  });

  test("a mismatch shows the rebuilt hash, full width", () => {
    const rebuilt = "0f3a5c7e9b1d2f4a6c8e0b2d4f6a8c0e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a";
    const mismatch = {
      ...VERIFIED_RESULT,
      status_summary: "mismatch",
      rebuilt_wasm_hash: rebuilt,
      matched: false,
      sandbox_diagnostics: { ...DIAGNOSTICS, rebuilt_wasm_hash: rebuilt },
    };
    render(<ResultPanel state="mismatch" result={mismatch} />);

    expect(resultSummaryEntries(mismatch).map(([key]) => key)).toEqual(["rebuilt_wasm_hash", "matched"]);
    expect(screen.getByText("Rebuilt Wasm hash")).toBeInTheDocument();
    expect(screen.getByText(rebuilt).parentElement).toHaveClass("md:col-span-2");
  });
});

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
