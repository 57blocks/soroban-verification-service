import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resultStorageConfigFromEnv } from "./result-storage-env.js";
import type { ResultStorageConfig, S3ResultStorageConfig } from "./storage-backend.js";

/**
 * The reader answers with the exact shape `createResultStorage` takes, or throws. What it must never do is
 * return something a caller has to translate or null-assert its way through — that is what produced two
 * translators with two different failure behaviours.
 */

const KEYS = [
  "SCVS_PUBLISHER_STORAGE",
  "SCVS_PUBLIC_RESULT_ROOT",
  "SCVS_RESULT_ROOT",
  "SCVS_ARTIFACT_DIR",
  "SCVS_PUBLISHER_BUCKET",
  "SCVS_PUBLISHER_PREFIX",
  "SCVS_R2_ENDPOINT",
  "SCVS_R2_ACCOUNT_ID",
  "SCVS_R2_REGION",
  "SCVS_R2_ACCESS_KEY_ID",
  "SCVS_R2_SECRET_ACCESS_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
] as const;

function test(name: string, env: Record<string, string>, fn: () => void): void {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    fn();
    console.log(`ok - ${name}`);
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** The union's object arm, so a case can read `bucket` without a null assertion — the thing this replaced. */
function objectArm(config: ResultStorageConfig): S3ResultStorageConfig {
  assert.notEqual(config.kind, "filesystem");
  if (config.kind === "filesystem") throw new Error("unreachable");
  return config;
}

test("an empty environment is a working filesystem backend", {}, () => {
  assert.deepEqual(resultStorageConfigFromEnv(), {
    kind: "filesystem",
    root: join(tmpdir(), "scvs-artifacts", "public"),
    publicRoot: "http://localhost:5000/public",
  });
});

test("SCVS_ARTIFACT_DIR moves the default root", { SCVS_ARTIFACT_DIR: "/srv/scvs" }, () => {
  assert.deepEqual(resultStorageConfigFromEnv(), {
    kind: "filesystem",
    root: join("/srv/scvs", "public"),
    publicRoot: "http://localhost:5000/public",
  });
});

test("SCVS_RESULT_ROOT wins over the artifact dir", { SCVS_ARTIFACT_DIR: "/srv/scvs", SCVS_RESULT_ROOT: "/mnt/results" }, () => {
  assert.deepEqual(resultStorageConfigFromEnv(), {
    kind: "filesystem",
    root: "/mnt/results",
    publicRoot: "http://localhost:5000/public",
  });
});

test("the public root loses its trailing slashes", { SCVS_PUBLIC_RESULT_ROOT: "https://results.test///" }, () => {
  assert.equal(resultStorageConfigFromEnv().publicRoot, "https://results.test");
});

test("s3 with a bucket is a complete object config", { SCVS_PUBLISHER_STORAGE: "s3", SCVS_PUBLISHER_BUCKET: "sv-dev-results" }, () => {
  const config = objectArm(resultStorageConfigFromEnv());
  assert.equal(config.bucket, "sv-dev-results");
  // The empty prefix is load-bearing: the result tree sits at the bucket root.
  assert.equal(config.prefix, "");
  assert.equal(config.endpoint, undefined);
});

test("an account id derives the R2 endpoint", { SCVS_PUBLISHER_STORAGE: "r2", SCVS_PUBLISHER_BUCKET: "b", SCVS_R2_ACCOUNT_ID: "acct" }, () => {
  assert.equal(objectArm(resultStorageConfigFromEnv()).endpoint, "https://acct.r2.cloudflarestorage.com");
});

test("an explicit endpoint wins over the account id", { SCVS_PUBLISHER_STORAGE: "r2", SCVS_PUBLISHER_BUCKET: "b", SCVS_R2_ACCOUNT_ID: "acct", SCVS_R2_ENDPOINT: "https://explicit.test" }, () => {
  assert.equal(objectArm(resultStorageConfigFromEnv()).endpoint, "https://explicit.test");
});

test("the kind is normalised before it is judged", { SCVS_PUBLISHER_STORAGE: "S3", SCVS_PUBLISHER_BUCKET: "b" }, () => {
  assert.equal(resultStorageConfigFromEnv().kind, "s3");
});

// Both of these used to pass boot. One service then threw on its first publish and the other logged an error
// and answered 503 to every wasm-status read for the life of the process.
test("an object backend with no bucket throws", { SCVS_PUBLISHER_STORAGE: "s3" }, () => {
  assert.throws(() => resultStorageConfigFromEnv(), /requires SCVS_PUBLISHER_BUCKET/);
});

test("a kind with no backend throws", { SCVS_PUBLISHER_STORAGE: "gcs", SCVS_PUBLISHER_BUCKET: "b" }, () => {
  assert.throws(() => resultStorageConfigFromEnv(), /has no backend/);
});
