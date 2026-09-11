import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CLI_27_0_0_RUST_1_96_0_IMAGE as BASELINE_ORACLE_IMAGE } from "./oracles.js";

export type BuildClass = "cli-legacy";

export const DEVIATIONS = [
  "readonly-source-mount",
  "redirected-target-dir",
  "vendored-offline",
] as const;

export type Deviation = (typeof DEVIATIONS)[number];

export type DifferentialFixture = {
  id: string;
  sourceDir: string;
  image: string;
  bldarg: string[];
  bldopt: string[];
  buildClass: BuildClass;
  deviationsUnderTest: Deviation[];
  rules: string[];
};

export const SAMPLE_CONTRACTS_ROOT = join(
  repoRoot(),
  "test",
  "fixtures",
  "sample-contracts",
);

/** The oracle every fixture below is compared against. */
const BASELINE_IMAGE = BASELINE_ORACLE_IMAGE;

export const FIXTURES: readonly DifferentialFixture[] = [
  {
    id: "cli-legacy-single-package-current",
    sourceDir: join(SAMPLE_CONTRACTS_ROOT, "single-package"),
    image: BASELINE_IMAGE,
    bldarg: ["contract", "build"],
    bldopt: ["--manifest-path=contracts/hello/Cargo.toml", "--package=hello-contract", "--optimize"],
    buildClass: "cli-legacy",
    deviationsUnderTest: [],
    rules: ["BE9"],
  },
  {
    id: "be4-bldopt-encoding-current",
    sourceDir: join(SAMPLE_CONTRACTS_ROOT, "bldopt-encoding"),
    image: BASELINE_IMAGE,
    bldarg: ["contract", "build"],
    bldopt: [
      "--manifest-path=contracts/env-reader/Cargo.toml",
      "--package=env-reader",
      "--env=B='this is very nice'",
      "--env=QUOTE='it'\\''s nice'",
    ],
    buildClass: "cli-legacy",
    deviationsUnderTest: [],
    rules: ["BE4", "BE9"],
  },
  {
    id: "be6-multi-package-recorded-package-current",
    sourceDir: join(SAMPLE_CONTRACTS_ROOT, "multi-package-workspace"),
    image: BASELINE_IMAGE,
    bldarg: ["contract", "build"],
    bldopt: ["--manifest-path=Cargo.toml", "--package=contract-a"],
    buildClass: "cli-legacy",
    deviationsUnderTest: [],
    rules: ["BE6", "BE9"],
  },
  {
    id: "be6-multi-package-ambiguous-current",
    sourceDir: join(SAMPLE_CONTRACTS_ROOT, "multi-package-workspace"),
    image: BASELINE_IMAGE,
    bldarg: ["contract", "build"],
    bldopt: ["--manifest-path=Cargo.toml"],
    buildClass: "cli-legacy",
    deviationsUnderTest: [],
    rules: ["BE6"],
  },
  {
    id: "be7-readonly-source-mount-current",
    sourceDir: join(SAMPLE_CONTRACTS_ROOT, "single-package"),
    image: BASELINE_IMAGE,
    bldarg: ["contract", "build"],
    bldopt: ["--manifest-path=contracts/hello/Cargo.toml", "--package=hello-contract"],
    buildClass: "cli-legacy",
    deviationsUnderTest: ["readonly-source-mount"],
    rules: ["BE7", "BE9"],
  },
  {
    id: "be7-redirected-target-dir-current",
    sourceDir: join(SAMPLE_CONTRACTS_ROOT, "single-package"),
    image: BASELINE_IMAGE,
    bldarg: ["contract", "build"],
    bldopt: ["--manifest-path=contracts/hello/Cargo.toml", "--package=hello-contract"],
    buildClass: "cli-legacy",
    deviationsUnderTest: ["redirected-target-dir"],
    rules: ["BE7", "BE9"],
  },
  {
    id: "be7-vendored-offline-current",
    sourceDir: join(SAMPLE_CONTRACTS_ROOT, "single-package"),
    image: BASELINE_IMAGE,
    bldarg: ["contract", "build"],
    bldopt: ["--manifest-path=contracts/hello/Cargo.toml", "--package=hello-contract"],
    buildClass: "cli-legacy",
    deviationsUnderTest: ["vendored-offline"],
    rules: ["BE7", "BE9"],
  },
];

function repoRoot(): string {
  let current = resolve(process.cwd());
  while (true) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error("Unable to locate repository root");
    current = parent;
  }
}
