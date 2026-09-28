import { randomBytes, randomUUID } from "node:crypto";
import {
  RebuildsRepository,
  createPrismaClient,
  readDbEnv,
  type PrismaClient,
} from "@scvs/db";
import { CreatedRows } from "@scvs/db/testing";

const IMAGE = `docker.io/stellar/stellar-cli@sha256:${"f".repeat(64)}`;

let client: PrismaClient;
let rebuilds: RebuildsRepository;
const createdRows = new CreatedRows();

beforeAll(() => {
  client = createPrismaClient(readDbEnv());
  rebuilds = new RebuildsRepository(client);
});

afterAll(async () => {
  await createdRows.cleanup(client);
  await client.$disconnect();
});

async function seedPendingRebuild(buildMode: "verify" | "build"): Promise<string> {
  const rebuildId = createdRows.rebuild(randomUUID());
  await rebuilds.findOrCreate({
    rebuildId,
    idempotencyKey: `reconcile-${randomBytes(8).toString("hex")}`,
    imageDigest: IMAGE,
    sourceRef: {
      type: "source_uri",
      visibility: "public",
      source_uri: "https://example.test/s.tar.gz",
      source_sha256: randomBytes(32).toString("hex"),
    },
    buildOptions: { bldopt: [], bldarg: [] },
    buildMode,
    mechanismReason: "on_chain_recipe_in_trusted_image",
  });
  return rebuildId;
}

it("moves a pending rebuild off the mode routing can no longer choose", async () => {
  const rebuildId = await seedPendingRebuild("verify");

  expect(await rebuilds.reconcileBuildMode(rebuildId, "build")).toBe(true);
  expect((await rebuilds.getById(rebuildId))?.buildMode).toBe("build");
});

it("does not write when the row already agrees", async () => {
  const rebuildId = await seedPendingRebuild("build");

  expect(await rebuilds.reconcileBuildMode(rebuildId, "build")).toBe(false);
  expect((await rebuilds.getById(rebuildId))?.buildMode).toBe("build");
});

it("leaves a claimed rebuild alone — its mode records an attempt that really ran", async () => {
  const rebuildId = await seedPendingRebuild("verify");
  expect(await rebuilds.claimForDispatch(rebuildId)).toBe(true);

  expect(await rebuilds.reconcileBuildMode(rebuildId, "build")).toBe(false);
  expect((await rebuilds.getById(rebuildId))?.buildMode).toBe("verify");
});
