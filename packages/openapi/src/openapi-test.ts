import assert from "node:assert/strict";
import type { OpenAPIObject } from "@nestjs/swagger";
import { AggregatedWasmStatus, SandboxDiagnostics } from "@scvs/core";
import { TrustedVerifiersList } from "@scvs/storage-layout";
import { applyDerivedSchemas } from "./index.js";

// Without these the metadata store is empty and every assertion below passes vacuously.
void AggregatedWasmStatus;
void SandboxDiagnostics;
void TrustedVerifiersList;

function documentWith(...names: string[]): OpenAPIObject {
  const schemas = Object.fromEntries(names.map((name) => [name, {}]));
  return { openapi: "3.0.0", info: { title: "t", version: "1" }, paths: {}, components: { schemas } };
}

function schemasOf(document: OpenAPIObject): Record<string, Record<string, unknown>> {
  return (document.components?.schemas ?? {}) as Record<string, Record<string, unknown>>;
}

function everySchemaHasProperties(): void {
  const schemas = schemasOf(applyDerivedSchemas(documentWith("AggregatedWasmStatus")));
  assert.ok(Object.keys(schemas).length > 1, "the closure pulled in nothing");
  for (const [name, schema] of Object.entries(schemas)) {
    const properties = schema.properties as Record<string, unknown> | undefined;
    assert.ok(
      properties !== undefined && Object.keys(properties).length > 0,
      `${name} derived to an empty schema — a no-op converter, a broken metadata store, or a lost class-transformer storage`,
    );
  }
}

function closureReachesNestedShapes(): void {
  const schemas = schemasOf(applyDerivedSchemas(documentWith("AggregatedWasmStatus")));
  for (const name of ["AggregatedRegistryVerification", "UnavailableVerifier", "RegistryVerifier"]) {
    assert.ok(name in schemas, `${name} was never pulled in`);
  }
  assert.deepEqual(
    schemas.AggregatedRegistryVerification.properties &&
      (schemas.AggregatedRegistryVerification.properties as Record<string, unknown>).verifier,
    { $ref: "#/components/schemas/RegistryVerifier" },
  );
}

function nestedTypesResolve(): void {
  const schemas = schemasOf(applyDerivedSchemas(documentWith("TrustedVerifiersList")));
  assert.deepEqual((schemas.TrustedVerifiersList.properties as Record<string, unknown>).verifiers, {
    type: "array",
    items: { $ref: "#/components/schemas/TrustedVerifier" },
  });
}

function addedAtIsDeclaredAndOptional(): void {
  const schemas = schemasOf(applyDerivedSchemas(documentWith("TrustedVerifiersList")));
  const entry = schemas.TrustedVerifier;
  assert.ok("added_at" in (entry.properties as Record<string, unknown>), "GET /verifiers returns added_at but the schema does not declare it");
  assert.ok(!((entry.required as string[] | undefined) ?? []).includes("added_at"), "added_at must stay optional");
}

function validatorsReachTheSchema(): void {
  const schemas = schemasOf(applyDerivedSchemas(documentWith("UnavailableVerifier")));
  const properties = schemas.UnavailableVerifier.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(properties.reason.enum, ["fetch_failed", "invalid_response", "timeout", "refused"]);
  assert.deepEqual(schemas.UnavailableVerifier.required, ["url", "reason"]);
}

function hintsReachTheSchema(): void {
  const schemas = schemasOf(applyDerivedSchemas(documentWith("SandboxDiagnostics")));
  const properties = schemas.SandboxDiagnostics.properties as Record<string, Record<string, unknown>>;
  assert.equal(properties.exit_code?.nullable, true, "the nullable hint did not reach the schema");
}

function declaredWinsPerProperty(): void {
  const document = documentWith();
  (document.components!.schemas as Record<string, unknown>).UnavailableVerifier = {
    type: "object",
    properties: { url: { type: "string", description: "hand-written" } },
    required: ["url"],
  };
  const schema = schemasOf(applyDerivedSchemas(document)).UnavailableVerifier;
  const properties = schema.properties as Record<string, Record<string, unknown>>;

  assert.equal(properties.url.description, "hand-written", "a declared property was overwritten");
  assert.ok("reason" in properties, "a property only validation knew about was dropped");
  assert.deepEqual(schema.required, ["url", "reason"]);
}

everySchemaHasProperties();
closureReachesNestedShapes();
nestedTypesResolve();
addedAtIsDeclaredAndOptional();
validatorsReachTheSchema();
hintsReachTheSchema();
declaredWinsPerProperty();
console.log("openapi derivation tests passed (non-empty schemas, $ref closure, nested types, added_at, validators, hints, per-property precedence)");
