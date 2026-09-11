import { Test } from "@nestjs/testing";
import { ConfigModule } from "@nestjs/config";
import { BuilderService, buildRecipeFromJob } from "../src/modules/builder/builder.service.js";
import configuration from "../src/config/configuration.js";
import { buildRecipeArtifact } from "../src/modules/builder/recipe.js";
import type { RunCliResult } from "../src/modules/builder/run-cli.types.js";

// A malformed `BatchJobParams` is the one path that's both deterministic and reachable with no external
// dependencies: it fails Zod parsing before ever touching fetch-source/run-cli, giving a reliable "fatal"
// classification every time.
describe("BuilderService", () => {
  const originalEnv = process.env.SCVS_JOB_PARAMS_JSON;

  afterEach(() => {
    process.env.SCVS_JOB_PARAMS_JSON = originalEnv;
  });

  it("returns a fatal classification for malformed BatchJobParams", async () => {
    process.env.SCVS_JOB_PARAMS_JSON = JSON.stringify({});

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, load: [configuration] })],
      providers: [BuilderService],
    }).compile();
    const builderService = moduleRef.get(BuilderService);

    const result = await builderService.run();

    expect(result.classification).toBe("fatal");
    expect(result.exitCode).toBe(3);
    expect(result.line.schema).toBe("scvs-builder-entrypoint-result-v1");
    expect(typeof result.line.detail).toBe("string");
  });
});

describe("buildRecipeFromJob", () => {
  it("records the package extracted from bldopt in the runCli recipe", () => {
    const recipe = buildRecipeFromJob(
      {
        image_digest: "docker.io/example/soroban@sha256:" + "a".repeat(64),
        build_args: ["contract", "build"],
        build_options: ["--manifest-path=contracts/Cargo.toml", "-p", "contract-a"],
      },
    );

    expect(recipe).toMatchObject({
      image: "docker.io/example/soroban@sha256:" + "a".repeat(64),
      workspace_path: "contracts/Cargo.toml",
      target: "wasm32v1-none",
      bldarg: ["contract", "build"],
      bldopt: ["--manifest-path=contracts/Cargo.toml", "-p", "contract-a"],
      package: "contract-a",
    });
  });

  it("carries the extracted package into recipe.json artifacts", () => {
    const recipe = buildRecipeFromJob(
      {
        image_digest: "docker.io/example/soroban@sha256:" + "b".repeat(64),
        build_options: ["--manifest-path=contracts/Cargo.toml", "--package=contract-b"],
      },
    );
    const runResult: RunCliResult = {
      outcome: "built",
      runner: "docker_build_image_rebuild",
      exit_code: 0,
      diagnostics: {},
    };

    const artifact = buildRecipeArtifact(recipe, runResult);

    expect(artifact.recipe.package).toBe("contract-b");
    expect(artifact.recipe.bldopt).toEqual(["--manifest-path=contracts/Cargo.toml", "--package=contract-b"]);
  });

  it("carries metadata_replay into the runCli recipe and recipe.json artifacts", () => {
    const recipe = buildRecipeFromJob(
      {
        image_digest: "docker.io/example/soroban@sha256:" + "c".repeat(64),
        build_options: ["--meta=source_repo='github:stellar/example'"],
        metadata_replay: [
          "source_repo=github:stellar/example",
          "bldopt=--meta=source_repo='github:stellar/example'",
        ],
      },
    );
    const runResult: RunCliResult = {
      outcome: "built",
      runner: "docker_build_image_rebuild",
      exit_code: 0,
      diagnostics: {},
    };

    const artifact = buildRecipeArtifact(recipe, runResult);

    expect(recipe.metadata_replay).toEqual([
      "source_repo=github:stellar/example",
      "bldopt=--meta=source_repo='github:stellar/example'",
    ]);
    expect(artifact.recipe.metadata_replay).toEqual(recipe.metadata_replay);
  });
});
