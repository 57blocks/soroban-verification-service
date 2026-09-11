import { randomBytes, randomUUID } from "node:crypto";
import {
  RebuildsRepository,
  createPrismaClient,
  readDbEnv,
  type PrismaClient,
} from "@scvs/db";
import { CreatedRows } from "@scvs/db/testing";

/**
 * What remains is `markTerminal`'s in-job form below, plus `requeueStaleCliFailure`, whose job is the opposite:
 * to stop a *stale* code outliving the attempt it describes.
 */
let client: PrismaClient;
let rebuilds: RebuildsRepository;
const createdRows = new CreatedRows();

const IMAGE = `docker.io/stellar/stellar-cli@sha256:${"c".repeat(64)}`;
const CHAIN_SHA = "3ee9dbfefc5fe690b8a2bb19f495905bc1e25f98c349be816ffaab4e6073db03";

beforeAll(() => {
  client = createPrismaClient(readDbEnv());
  rebuilds = new RebuildsRepository(client);
});

afterAll(async () => {
  await createdRows.cleanup(client);
  await client.$disconnect();
});

/** A rebuild that ran `verify`, failed, and recorded everything such an attempt records. */
async function burnedVerifyAttempt() {
  const sourceSha256 = randomBytes(32).toString("hex");
  const rebuildId = createdRows.rebuild(randomUUID());
  await rebuilds.findOrCreate({
    rebuildId,
    idempotencyKey: `verify-attempt-trace-${randomBytes(8).toString("hex")}`,
    imageDigest: IMAGE,
    sourceRef: {
      type: "source_uri",
      visibility: "public",
      source_uri: "https://example.test/s.tar.gz",
      source_sha256: sourceSha256,
    },
    buildOptions: { bldopt: [], bldarg: [] },
    buildMode: "verify",
    mechanismReason: "on_chain_recipe_in_trusted_image",
    chainSourceSha256: CHAIN_SHA,
  });
  await rebuilds.markTerminal(rebuildId, {
    outcome: "cli_failure",
    runner: "stellar_contract_verify",
    errorCode: "source_archive_not_chain_recorded",
    diagnostics: { runner: "stellar_contract_verify" },
    canonicalSourceSha256: sourceSha256,
    canonicalSourceKey: "staging/x/verify/canonical-source",
    sourceCanonicalisation: { reconstruction: "hash_mismatch" },
  });
  return rebuildId;
}

describe("requeueStaleCliFailure — the reset that survived the retirement", () => {
  it("★ a fresh full attempt starts with no reason, so a later success cannot publish a stale one", async () => {
    const rebuildId = await burnedVerifyAttempt();

    // Passed by the caller rather than read off the row: the row may still say `verify` from before the
    // retirement, and resetting to its own value would re-dispatch a mode nothing can run.
    expect(await rebuilds.requeueStaleCliFailure(rebuildId, "build")).toBe(true);

    const row = await rebuilds.getById(rebuildId);
    expect(row?.buildMode).toBe("build");
    expect(row?.status).toBe("pending");
    // Keeping it would let an attempt that then *succeeds* publish `metadata_backed` beside a reason from an
    // attempt that is no longer this rebuild's.
    expect(row?.verifyFailureCode).toBeUndefined();
    // Cleared for the same reason the demotion cleared them: this attempt materialises again.
    expect(row?.outcome).toBeUndefined();
    expect(row?.errorCode).toBeUndefined();
    expect(row?.canonicalSourceSha256).toBeUndefined();
    expect(row?.canonicalSourceKey).toBeUndefined();
    expect(row?.sourceCanonicalisation).toBeUndefined();
    // Chain-derived and immutable for a given Wasm, so it is not the retry's to re-establish.
    expect(row?.chainSourceSha256).toBe(CHAIN_SHA);
  });

  it("★ a duplicate delivery does not reset twice", async () => {
    const rebuildId = await burnedVerifyAttempt();
    expect(await rebuilds.requeueStaleCliFailure(rebuildId, "build")).toBe(true);

    // The CAS requires `status: "done"` AND `outcome: "cli_failure"`, both of which the first call moved off —
    // so a second SQS delivery matches no row.
    expect(await rebuilds.requeueStaleCliFailure(rebuildId, "build")).toBe(false);
    expect((await rebuilds.getById(rebuildId))?.status).toBe("pending");
  });

  /**
   * Asserted rather than deleted: a rebuild reaching `pending` with `buildMode: "verify"` would be a mode no
   * builder image can run, and this is the cheapest place that fact is observable.
   */
  it("nothing puts a rebuild back into verify mode", async () => {
    const rebuildId = await burnedVerifyAttempt();
    await rebuilds.requeueStaleCliFailure(rebuildId, "build");

    const row = await rebuilds.getById(rebuildId);
    expect(row?.status).toBe("pending");
    expect(row?.buildMode).not.toBe("verify");
  });
});

/**
 * The builder runs the sandbox itself when the materialiser's record already settles that the CLI cannot
 * succeed, so the code arrives on `BuildArtifact.verify_attempt_reason` and `markTerminal` writes it.
 */
describe("markTerminal, for a demotion that happened inside the job", () => {
  async function inJobDemotion() {
    const rebuildId = createdRows.rebuild(randomUUID());
    await rebuilds.findOrCreate({
      rebuildId,
      idempotencyKey: `in-job-demotion-${randomBytes(8).toString("hex")}`,
      imageDigest: IMAGE,
      sourceRef: {
        type: "source_uri",
        visibility: "public",
        source_uri: "https://example.test/s.tar.gz",
        source_sha256: randomBytes(32).toString("hex"),
      },
      buildOptions: { bldopt: [], bldarg: [] },
      // Dispatched verify — and never requeued, because the runner did the build itself.
      buildMode: "verify",
      mechanismReason: "on_chain_recipe_in_trusted_image",
      chainSourceSha256: CHAIN_SHA,
    });
    return rebuildId;
  }

  it("★ records the reason beside a sandbox runner on a rebuild still dispatched as verify", async () => {
    const rebuildId = await inJobDemotion();

    await rebuilds.markTerminal(rebuildId, {
      outcome: "success",
      runner: "docker_build_image_rebuild",
      rebuiltWasmHash: "a".repeat(64),
      verifyFailureCode: "source_archive_not_chain_recorded",
    });

    const row = await rebuilds.getById(rebuildId);
    expect(row?.verifyFailureCode).toBe("source_archive_not_chain_recorded");
    // The three facts `verdict.util.ts` reads, and the combination only the in-job form produces: dispatched
    // verify, run by the sandbox, with a reason for the difference.
    expect(row?.buildMode).toBe("verify");
    expect(row?.runner).toBe("docker_build_image_rebuild");
  });

  it("writes nothing when the CLI path actually ran, so a success cannot publish a phantom reason", async () => {
    const rebuildId = await inJobDemotion();

    await rebuilds.markTerminal(rebuildId, {
      outcome: "success",
      runner: "stellar_contract_verify",
      rebuiltWasmHash: "a".repeat(64),
    });

    const row = await rebuilds.getById(rebuildId);
    expect(row?.verifyFailureCode).toBeUndefined();
  });
});
