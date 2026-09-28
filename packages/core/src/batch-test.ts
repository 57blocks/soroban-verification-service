// Must load before any decorated class is evaluated.
import "reflect-metadata";
import assert from "node:assert/strict";
import { validateSync } from "class-validator";
import { BatchJobParams } from "./batch.js";
import { SourceUriSourceRef } from "./source.js";
import { VerificationTarget } from "./target.js";

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function target(): VerificationTarget {
  const value = new VerificationTarget();
  value.network = "testnet";
  value.wasm_hash = "a".repeat(64);
  return value;
}

function sourceRef(): SourceUriSourceRef {
  const value = new SourceUriSourceRef();
  value.type = "source_uri";
  value.visibility = "public";
  value.source_sha256 = "b".repeat(64);
  return value;
}

function params(imageDigest: string): BatchJobParams {
  const value = new BatchJobParams();
  value.job_id = "11111111-1111-1111-1111-111111111111";
  value.target = target();
  value.source_ref = sourceRef();
  value.image_digest = imageDigest;
  value.mode = "verify";
  value.upload_url = "https://scvs-staging.s3.amazonaws.com/staging/recipe.json?sig=1";
  value.artifact_upload_url = "https://scvs-staging.s3.amazonaws.com/staging/wasm?sig=1";
  return value;
}

const DIGEST = "sha256:" + "e".repeat(64);

test("BatchJobParams.image_digest validates the real chain-named shape (docker.io)", () => {
  assert.deepEqual(validateSync(params(`docker.io/stellar/stellar-cli@${DIGEST}`)), []);
});

test("BatchJobParams.image_digest validates the real composed-environment shape (ECR)", () => {
  assert.deepEqual(
    validateSync(
      params(`123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/scvs-composed-environments@${DIGEST}`),
    ),
    [],
  );
});

test("BatchJobParams.image_digest rejects a bare digest — this field is a full reference, not just a hash", () => {
  assert.notEqual(validateSync(params(DIGEST)).length, 0);
});

test("BatchJobParams.image_digest rejects a mutable tag", () => {
  assert.notEqual(validateSync(params("docker.io/stellar/stellar-cli:latest")).length, 0);
});

test("BatchJobParams.image_digest rejects a garbled value", () => {
  assert.notEqual(validateSync(params("not-an-image-reference")).length, 0);
});

test("BatchJobParams.image_digest rejects a loopback registry host, even though RegistryVerification.bldimg allows it", () => {
  assert.notEqual(validateSync(params(`localhost/myimage@${DIGEST}`)).length, 0);
});

test("BatchJobParams.image_digest accepts localhost:<port> — the port's colon alone satisfies the host-segment rule", () => {
  assert.deepEqual(validateSync(params(`localhost:5000/myimage@${DIGEST}`)), []);
});

console.log("batch: all cases passed");
