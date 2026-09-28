import { randomBytes, randomUUID } from "node:crypto";
import { EnvironmentsRepository, createPrismaClient, readDbEnv, type PrismaClient } from "@scvs/db";
import { CreatedRows } from "@scvs/db/testing";

let client: PrismaClient;
let environments: EnvironmentsRepository;
const createdRows = new CreatedRows();

function uniquePair() {
  const salt = randomBytes(4).toString("hex");
  return { cliver: `99.0.0#${randomBytes(20).toString("hex")}`, rsver: `1.0.0-${salt}` };
}

async function seedFailed(errorCode: string, templateVersion = "v2") {
  const environmentId = createdRows.environment(randomUUID());
  const { cliver, rsver } = uniquePair();
  await environments.create({ environmentId, cliver, rsver, templateVersion });
  expect(await environments.claimForComposing(environmentId)).toBe(true);
  await environments.markFailed(environmentId, errorCode);
  return environmentId;
}

beforeAll(() => {
  client = createPrismaClient(readDbEnv());
  environments = new EnvironmentsRepository(client);
});

afterAll(async () => {
  await createdRows.cleanup(client);
  await client.$disconnect();
});

describe("listFailedByErrorCode", () => {
  it("returns rows failed with that code and not rows failed with another", async () => {
    const missing = await seedFailed("composition_template_missing");
    const disagreed = await seedFailed("smoke_test_disagreed");

    const found = (await environments.listFailedByErrorCode("composition_template_missing")).map(
      (row) => row.environmentId,
    );

    expect(found).toContain(missing);
    expect(found).not.toContain(disagreed);
  });

  it("ignores rows that are not failed", async () => {
    const environmentId = createdRows.environment(randomUUID());
    const { cliver, rsver } = uniquePair();
    await environments.create({ environmentId, cliver, rsver, templateVersion: "v2" });

    const found = (await environments.listFailedByErrorCode("composition_template_missing")).map(
      (row) => row.environmentId,
    );
    expect(found).not.toContain(environmentId);
  });
});

describe("resetFailedToPending", () => {
  it("moves a failed row back to pending and clears its error code", async () => {
    const environmentId = await seedFailed("composition_template_missing");

    expect(await environments.resetFailedToPending(environmentId, "composition_template_missing")).toBe(true);

    const row = await environments.getById(environmentId);
    expect(row?.status).toBe("pending");
    expect(row?.errorCode).toBeUndefined();
  });

  it("clears the old batch job id, so a late event for it cannot undo the reset", async () => {
    const environmentId = createdRows.environment(randomUUID());
    const { cliver, rsver } = uniquePair();
    await environments.create({ environmentId, cliver, rsver, templateVersion: "v2" });
    expect(await environments.claimForComposing(environmentId)).toBe(true);
    await environments.markComposing(environmentId, "stub-batch-doomed");
    await environments.markFailed(environmentId, "composition_template_missing");
    expect((await environments.getByBatchJobId("stub-batch-doomed"))?.environmentId).toBe(environmentId);

    expect(await environments.resetFailedToPending(environmentId, "composition_template_missing")).toBe(true);

    expect((await environments.getById(environmentId))?.batchJobId).toBeUndefined();
    expect(await environments.getByBatchJobId("stub-batch-doomed")).toBeUndefined();
  });

  it("refuses a row whose error code is not the one the caller decided on", async () => {
    const environmentId = await seedFailed("smoke_test_disagreed");

    expect(await environments.resetFailedToPending(environmentId, "composition_template_missing")).toBe(false);
    expect((await environments.getById(environmentId))?.status).toBe("failed");
  });

  it("refuses a row that is not failed, so a live composition is never yanked", async () => {
    const environmentId = createdRows.environment(randomUUID());
    const { cliver, rsver } = uniquePair();
    await environments.create({ environmentId, cliver, rsver, templateVersion: "v2" });
    expect(await environments.claimForComposing(environmentId)).toBe(true);

    expect(await environments.resetFailedToPending(environmentId, "composition_template_missing")).toBe(false);
    expect((await environments.getById(environmentId))?.status).toBe("composing");
  });

  it("is idempotent in the honest sense: the second call reports it did nothing", async () => {
    const environmentId = await seedFailed("composition_template_missing");

    expect(await environments.resetFailedToPending(environmentId, "composition_template_missing")).toBe(true);
    expect(await environments.resetFailedToPending(environmentId, "composition_template_missing")).toBe(false);
    expect((await environments.getById(environmentId))?.status).toBe("pending");
  });
});
