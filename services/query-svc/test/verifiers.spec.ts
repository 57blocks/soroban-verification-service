import { randomUUID } from "node:crypto";
import request from "supertest";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createPrismaClient, TrustedVerifiersRepository } from "@scvs/db-query";
import { readDbEnv } from "@scvs/db";
import { createTestApp } from "./bootstrap.js";

let app: NestExpressApplication;
const prisma = createPrismaClient(readDbEnv());
const verifiers = new TrustedVerifiersRepository(prisma);

// A unique-per-run id so two concurrent runs never collide, and every assertion is scoped to that row rather
// than to whatever the shared database's seeded list happens to hold.
const OUR_ID = `spec-verifiers-${randomUUID()}`;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  try {
    await prisma.trustedVerifier.deleteMany({ where: { verifierId: { in: [OUR_ID] } } });
  } finally {
    await prisma.$disconnect();
    await app.close();
  }
});

const ourEntry = async () => {
  const res = await request(app.getHttpServer()).get("/api/query/v1/verifiers");
  expect(res.status).toBe(200);
  return {
    body: res.body as { schema: string; schema_version: string; verifiers: Record<string, unknown>[] },
    entry: (res.body.verifiers as { id: string }[]).find((verifier) => verifier.id === OUR_ID),
  };
};

describe("GET /api/query/v1/verifiers", () => {
  it("answers a stellar-trusted-verifiers-list document", async () => {
    const { body } = await ourEntry();
    expect(body.schema).toBe("stellar-trusted-verifiers-list");
    expect(body.schema_version).toBe("1.0");
    expect(Array.isArray(body.verifiers)).toBe(true);
    expect(typeof (body as unknown as { updated_at: string }).updated_at).toBe("string");
  });

  it("lists a paused member rather than omitting it", async () => {
    await verifiers.upsertTrustedVerifier({
      verifierId: OUR_ID,
      manifestUrl: "https://verifiers.spec.test/verifier-manifest.json",
      resultsRoot: "https://verifiers.spec.test/",
      bulkLoadUrl: "https://verifiers.spec.test/api/verification/v1/wasms",
      displayName: "Spec Verifier",
      status: "paused",
    });

    const { entry } = await ourEntry();
    expect(entry).toMatchObject({ status: "paused", display_name: "Spec Verifier" });
  });
});
