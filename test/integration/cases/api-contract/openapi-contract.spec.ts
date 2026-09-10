/** E2E-API-01/02 — deployed OpenAPI contract coverage. */
import { caseBlock } from "../../support/gate.js";
import { env } from "../../support/env.js";
import { fixtures, missingDeployedTarget, submissionFor } from "../../support/fixtures.js";
import { expectErrorEnvelope, expectStatus, http, postJson, sleep, type HttpResult } from "../../support/http.js";
import { submit, waitForTerminal } from "../../support/job.js";
import {
  aggregatedByHashUrl,
  deprecatedAggregatedBulkLoadUrl,
  deprecatedAggregatedByHashUrl,
  deprecatedOwnBulkLoadUrl,
  verifyWasmStatusUrl,
} from "../../support/routes.js";
import {
  readStatusFormsUntilAgreed,
  STATUS_AGREEMENT_TIMEOUT_MS,
} from "../../support/status-agreement.js";

/** RFC 8594's `Sunset`, as `packages/core/src/deprecated-json-routes.ts` spells it. */
const JSON_ROUTE_SUNSET_HTTP_DATE = "Mon, 01 Dec 2026 00:00:00 GMT";

type HttpMethod = "get" | "post";
type OpenApiOperation = { readonly responses?: Record<string, unknown> };
type OpenApiDocument = {
  readonly openapi?: unknown;
  readonly info?: { readonly title?: unknown; readonly version?: unknown };
  readonly paths?: Record<string, Partial<Record<HttpMethod, OpenApiOperation>>>;
};
type OperationExpectation = readonly [path: string, method: HttpMethod];

const verificationOperations: readonly OperationExpectation[] = [
  ["/health", "get"],
  ["/health/live", "get"],
  ["/health/ready", "get"],
  ["/api/verification/v1/health", "get"],
  // The operator's versioned legal documents. Public, ETagged by the sha256 a job binds — added with the
  // route, which this list did not learn about, and `publishedSpec` asserts the documented set EXACTLY,
  // so one undeclared route fails every case in this file rather than one.
  ["/api/verification/v1/legal", "get"],
  ["/api/verification/v1/preflight", "post"],
  ["/api/verification/v1/verifications", "post"],
  ["/api/verification/v1/verifications/{job_id}", "get"],
  ["/api/verification/v1/verifications/{job_id}/log", "get"],
  ["/api/verification/v1/uploads/source", "post"],
  ["/api/verification/v1/wasms", "get"],
  ["/api/verification/v1/wasms.json", "get"],
  ["/api/verification/v1/wasms/{wasm_hash}.json", "get"],
];

const queryOperations: readonly OperationExpectation[] = [
  ["/health", "get"],
  ["/health/live", "get"],
  ["/health/ready", "get"],
  ["/api/query/v1/health", "get"],
  ["/api/query/v1/wasms", "get"],
  ["/api/query/v1/wasms.json", "get"],
  ["/api/query/v1/wasms/{wasm_hash}", "get"],
  ["/api/query/v1/wasms/{wasm_hash}.json", "get"],
  ["/api/query/v1/contracts/{network}/{contract_id}", "get"],
  ["/api/query/v1/verifiers", "get"],
];

const NEVER_SEEN_WASM_HASH = "e".repeat(64);
const VALID_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB";
const WELL_FORMED_WASM_HASH = "a".repeat(64);

const bulkBoundaries = [
  ["documented defaults", "", "asc"],
  ["ascending minimum page", "?order=asc&limit=1", "asc"],
  ["descending maximum page", "?order=desc&limit=200", "desc"],
  ["syntactically valid cursor", `?order=asc&limit=1&cursor=0-${WELL_FORMED_WASM_HASH}`, "asc"],
] as const;

const bulkInvalid = [
  ["invalid order", "?order=sideways", "invalid_order"],
  ["zero limit", "?limit=0", "invalid_limit"],
  ["limit above maximum", "?limit=201", "invalid_limit"],
  ["non-numeric limit", "?limit=one", "invalid_limit"],
  ["malformed cursor", "?cursor=nonsense", "invalid_cursor"],
] as const;

caseBlock(
  {
    id: "E2E-API-01",
    title: "the deployed OpenAPI documents match safe public probes",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_QUERY_URL"],
    prerequisites: ["P1"],
  },
  () => {
    it("verification OpenAPI lists exactly its routed operations", async () => {
      await verificationSpec();
    });

    it("query OpenAPI lists exactly its routed operations", async () => {
      await querySpec();
    });

    it("verification health returns its documented positive shape", async () => {
      const spec = await verificationSpec();
      const response = await http(`${env.verifyUrl}/api/verification/v1/health`);
      expectDocumentedStatus(spec, "/api/verification/v1/health", "get", response);
      expectHealth(response);
    });

    it.each(bulkBoundaries)("verification bulk accepts %s", async (_name, suffix, order) => {
      const spec = await verificationSpec();
      const response = await http(`${env.verifyUrl}/api/verification/v1/wasms${suffix}`);
      expectDocumentedStatus(spec, "/api/verification/v1/wasms", "get", response);
      expectBulkPage(response, order);
    });

    it.each(bulkInvalid)("verification bulk rejects %s", async (_name, suffix, error) => {
      const spec = await verificationSpec();
      const response = await http(`${env.verifyUrl}/api/verification/v1/wasms${suffix}`);
      expectSafeError(spec, "/api/verification/v1/wasms", "get", response, 400, error, "verification");
    });

    it.each([
      ["missing network", { contract_id: VALID_CONTRACT_ID }, "invalid_network"],
      ["invalid network", { network: "futurenet", contract_id: VALID_CONTRACT_ID }, "invalid_network"],
      ["missing target identifier", { network: "testnet" }, "missing_target"],
    ] as const)("verification preflight rejects %s", async (_name, body, error) => {
      const spec = await verificationSpec();
      const response = await postJson(`${env.verifyUrl}/api/verification/v1/preflight`, body);
      expectSafeError(spec, "/api/verification/v1/preflight", "post", response, 400, error, "verification");
    });

    it.each([
      ["missing target", {}, "invalid_request"],
      ["missing target network", { target: { contract_id: VALID_CONTRACT_ID } }, "invalid_request"],
      ["invalid target network", { target: { network: "futurenet", contract_id: VALID_CONTRACT_ID } }, "invalid_request"],
      ["missing target identifier", { target: { network: "testnet" } }, "invalid_request"],
      ["malformed Wasm hash", { target: { network: "testnet", wasm_hash: "not-a-wasm-hash" } }, "invalid_request"],
      ["non-boolean dry_run", { target: { network: "testnet", wasm_hash: WELL_FORMED_WASM_HASH }, dry_run: "true" }, "invalid_request"],
    ] as const)("verification submit rejects %s", async (_name, body, error) => {
      const spec = await verificationSpec();
      const response = await postJson(`${env.verifyUrl}/api/verification/v1/verifications`, body);
      expectSafeError(spec, "/api/verification/v1/verifications", "post", response, 400, error, "verification");
    });

    it("verification upload rejects an empty archive", async () => {
      const spec = await verificationSpec();
      const response = await http(`${env.verifyUrl}/api/verification/v1/uploads/source`, {
        method: "POST",
        headers: { "content-type": "application/gzip" },
      });
      expectSafeError(spec, "/api/verification/v1/uploads/source", "post", response, 400, "invalid_upload", "verification");
    });

    it.each([
      ["status", "/api/verification/v1/verifications/not-a-uuid", "/api/verification/v1/verifications/{job_id}"],
      ["log", "/api/verification/v1/verifications/not-a-uuid/log", "/api/verification/v1/verifications/{job_id}/log"],
    ] as const)("verification %s route rejects a malformed job id", async (_name, url, operationPath) => {
      const spec = await verificationSpec();
      const response = await http(`${env.verifyUrl}${url}`);
      expectSafeError(spec, operationPath, "get", response, 400, "invalid_job_id", "verification");
    });

    it("verification own Wasm status rejects a malformed hash with the Registry error shape", async () => {
      const spec = await verificationSpec();
      const response = await http(verifyWasmStatusUrl("not-a-wasm-hash"));
      expectStatus(response, 400);
      expectDocumentedStatus(spec, "/api/verification/v1/wasms/{wasm_hash}.json", "get", response);
      // RC2's narrow body: the two identifiers, `error`, `message`. `schema` joined it later.
      expect(response.json).toEqual({
        schema: "stellar-verification-error",
        schema_version: "1.0",
        error: "400_invalid_wasm_hash",
        message: "wasm_hash must be a lowercase-hex SHA-256.",
      });
      // `status_code` staying out is a property of THIS ROUTE, not of the document type.
      expect(response.json).not.toHaveProperty("status_code");
    });

    it("verification own Wasm status returns a documented not_found envelope for a never-seen hash", async () => {
      const spec = await verificationSpec();
      const response = await http(verifyWasmStatusUrl(NEVER_SEEN_WASM_HASH));
      expectStatus(response, 404);
      expectDocumentedStatus(spec, "/api/verification/v1/wasms/{wasm_hash}.json", "get", response);
      // SEP §8: every non-2xx body of an API route carries the envelope. The Registry API draft this
      // replaced defined no body here, and `expectDocumentedStatus` never reads one — so this assertion,
      // not that one, is what holds the route to the SEP.
      expect(expectErrorEnvelope(response).error).toBe("not_found");
      // `status_code` is a property of the general envelope; these two read routes omit it.
      expect(response.json).not.toHaveProperty("status_code");
    });

    it("query health returns its documented positive shape", async () => {
      const spec = await querySpec();
      const response = await http(`${env.queryUrl}/api/query/v1/health`);
      expectDocumentedStatus(spec, "/api/query/v1/health", "get", response);
      expectHealth(response);
    });

    it("query TVL returns its documented positive shape", async () => {
      const spec = await querySpec();
      const response = await http(`${env.queryUrl}/api/query/v1/verifiers`);
      expectDocumentedStatus(spec, "/api/query/v1/verifiers", "get", response);
      expectStatus(response, 200);
      expect(response.json?.schema).toBe("stellar-trusted-verifiers-list");
      expect(Array.isArray(response.json?.verifiers)).toBe(true);
      expect(typeof response.json?.updated_at).toBe("string");
    });

    it("query by hash returns its documented no-data shape", async () => {
      const spec = await querySpec();
      const response = await http(`${env.queryUrl}/api/query/v1/wasms/${NEVER_SEEN_WASM_HASH}`);
      expectDocumentedStatus(spec, "/api/query/v1/wasms/{wasm_hash}", "get", response);
      expectWasmStatus(response, NEVER_SEEN_WASM_HASH);
    });

    /**
     * The three spellings later deprecated; why they must still answer is in
     * `packages/core/src/deprecated-json-routes.ts`. Removed with them after 2026-12-01. The
     * verifier's own `/v1/wasms/{hash}.json` keeps its suffix and is `E2E-PUB-15`'s, not this table's.
     */
    it.each([
      ["the verifier's own bulk load", () => deprecatedOwnBulkLoadUrl()],
      ["the aggregate bulk load", () => deprecatedAggregatedBulkLoadUrl()],
      ["the aggregate per-hash view", () => deprecatedAggregatedByHashUrl(NEVER_SEEN_WASM_HASH)],
    ] as const)("the deprecated .json spelling of %s still answers, and says when it stops", async (_name, url) => {
      const response = await http(url());
      if (response.status === 503) return; // the aggregate index is still building; its own tests cover that
      expectStatus(response, 200);
      expect(response.headers.get("deprecation")).toBe("true");
      expect(response.headers.get("sunset")).toBe(JSON_ROUTE_SUNSET_HTTP_DATE);
    });

    it("the deprecated per-hash spelling answers its own route, not `wasm_hash = \"<hash>.json\"`", async () => {
      // The echoed key, not the status code: Express's `:wasm_hash` takes the dot with it, so a wrong
      // declaration order answers 200 with an empty aggregate for `"<hash>.json"`.
      const response = await http(deprecatedAggregatedByHashUrl(NEVER_SEEN_WASM_HASH));
      if (response.status === 503) return;
      expectWasmStatus(response, NEVER_SEEN_WASM_HASH);
    });

    it.each([
      ["invalid network", "futurenet", VALID_CONTRACT_ID, "invalid_network"],
      ["malformed contract id", "testnet", "not-a-contract", "invalid_contract_id"],
    ] as const)("query by contract rejects %s", async (_name, network, contractId, error) => {
      const spec = await querySpec();
      const response = await http(`${env.queryUrl}/api/query/v1/contracts/${network}/${contractId}`);
      expectSafeError(spec, "/api/query/v1/contracts/{network}/{contract_id}", "get", response, 400, error, "query");
    });

    it.each(bulkBoundaries)("query bulk accepts %s", async (_name, suffix, order) => {
      const spec = await querySpec();
      const response = await http(`${env.queryUrl}/api/query/v1/wasms${suffix}`);
      expectDocumentedStatus(spec, "/api/query/v1/wasms", "get", response);
      expectQueryBulkPageOrUnavailable(response, order);
    });

    it.each(bulkInvalid)("query bulk handles %s", async (_name, suffix, error) => {
      const spec = await querySpec();
      const response = await http(`${env.queryUrl}/api/query/v1/wasms${suffix}`);
      if (response.status === 503) {
        expectDocumentedStatus(spec, "/api/query/v1/wasms", "get", response);
        const unavailable = expectErrorEnvelope(response);
        expect(unavailable.error).toBe("aggregation_unavailable");
        expect(unavailable.status_code).toBe(503);
        return;
      }
      expectSafeError(spec, "/api/query/v1/wasms", "get", response, 400, error, "query");
    });
  },
);

caseBlock(
  {
    id: "E2E-API-02",
    title: "a run-scoped valid submission matches the deployed write contract",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_QUERY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingDeployedTarget("F-LEG-1"),
  },
  () => {
    it(
      "returns documented queued fields, reaches a terminal job, and is queryable",
      async () => {
        const verificationDocument = await verificationSpec();
        const queryDocument = await querySpec();
        const body = await submissionFor("F-LEG-1");
        const accepted = await submit(body);

        expectStatus(accepted.response, 202);
        expectDocumentedStatus(verificationDocument, "/api/verification/v1/verifications", "post", accepted.response);
        expect(accepted.response.json).toEqual(
          expect.objectContaining({ status: "queued", target: body.target, message: expect.any(String) }),
        );
        expect(typeof accepted.response.json?.job_id).toBe("string");
        expect(accepted.jobId).toBe(accepted.response.json?.job_id);

        const terminal = await waitForTerminal(accepted.jobId!);
        expect(terminal.body.status).toBe("verified");
        const wasmHash = terminal.body.result?.wasm_hash ?? fixtures.contracts["F-LEG-1"].wasm_hash;
        expect(typeof wasmHash).toBe("string");

        // Once published, it must return the result-root document's exact bytes, including formatting and any
        // archive-backfill fields the static tree gained after the job completed.
        const {
          dynamicRead: ownStatus,
          staticRead: staticStatus,
          uppercaseRead: uppercaseStatus,
        } = await readStatusFormsUntilAgreed(wasmHash!);
        expectStatus(ownStatus, 200);
        expectDocumentedStatus(verificationDocument, "/api/verification/v1/wasms/{wasm_hash}.json", "get", ownStatus);
        expectStatus(staticStatus, 200);
        expect(ownStatus.text).toBe(staticStatus.text);

        expectStatus(uppercaseStatus, 200);
        expect(uppercaseStatus.text).toBe(staticStatus.text);

        const aggregate = await waitForAggregateResponse(wasmHash!);
        expectDocumentedStatus(queryDocument, "/api/query/v1/wasms/{wasm_hash}", "get", aggregate);
        expectWasmStatus(aggregate, wasmHash!);
      },
      env.jobTimeoutMs + STATUS_AGREEMENT_TIMEOUT_MS + 60_000,
    );
  },
);

async function verificationSpec(): Promise<OpenApiDocument> {
  return publishedSpec(env.verifyUrl!, "/api/verification/v1/openapi.json", "Soroban Verification API", verificationOperations);
}

async function querySpec(): Promise<OpenApiDocument> {
  return publishedSpec(env.queryUrl!, "/api/query/v1/openapi.json", "Soroban Query API", queryOperations);
}

async function publishedSpec(
  origin: string,
  path: string,
  title: string,
  expectedOperations: readonly OperationExpectation[],
): Promise<OpenApiDocument> {
  const response = await http(`${origin}${path}`);
  expectStatus(response, 200);
  expect(response.headers.get("content-type")).toContain("application/json");

  const spec = response.json as OpenApiDocument;
  expect(typeof spec?.openapi).toBe("string");
  expect(spec.info?.title).toBe(title);
  expect(typeof spec.info?.version).toBe("string");
  expect(spec.paths).toBeDefined();

  const actualOperations = Object.entries(spec.paths ?? {})
    .flatMap(([operationPath, item]) =>
      (["get", "post"] as const).filter((method) => item[method] !== undefined).map((method) => `${method.toUpperCase()} ${operationPath}`),
    )
    .sort();
  const expected = expectedOperations.map(([operationPath, method]) => `${method.toUpperCase()} ${operationPath}`).sort();
  expect(actualOperations).toEqual(expected);
  for (const [operationPath, method] of expectedOperations) {
    expect(Object.keys(operationFor(spec, operationPath, method).responses ?? {})).not.toHaveLength(0);
  }
  return spec;
}

function expectSafeError(
  spec: OpenApiDocument,
  path: string,
  method: HttpMethod,
  response: HttpResult,
  status: number,
  errorCode: string,
  _service: "verification" | "query",
): void {
  expectStatus(response, status);
  expectDocumentedStatus(spec, path, method, response);
  // One envelope, both services (RC6); `expectErrorEnvelope` asserts the two identifiers.
  const error = expectErrorEnvelope(response);
  expect(error.error).toBe(errorCode);
  expect(error.status_code).toBe(status);
  // Kept as a parameter so the call sites still read as "this is the query API's error", and unused on purpose.
  expect(error.schema).toBe("stellar-verification-error");
  expect(error.schema_version).toBe("1.0");
}

function expectDocumentedStatus(spec: OpenApiDocument, path: string, method: HttpMethod, response: HttpResult): void {
  const operation = operationFor(spec, path, method);
  if (operation.responses?.[String(response.status)] !== undefined || operation.responses?.default !== undefined) return;
  throw new Error(
    `${method.toUpperCase()} ${path} returned ${response.status}, but its OpenAPI operation declares ` +
      `[${Object.keys(operation.responses ?? {}).sort().join(", ")}]. Response body: ${truncate(response.text)}`,
  );
}

function operationFor(spec: OpenApiDocument, path: string, method: HttpMethod): OpenApiOperation {
  const operation = spec.paths?.[path]?.[method];
  if (!operation) throw new Error(`OpenAPI document has no ${method.toUpperCase()} ${path} operation.`);
  return operation;
}

function expectHealth(response: HttpResult): void {
  expectStatus(response, 200);
  expect(response.json).toEqual(expect.objectContaining({ status: "ok" }));
  expect(typeof response.json?.version).toBe("string");
}

function expectBulkPage(response: HttpResult, order: "asc" | "desc"): void {
  expectStatus(response, 200);
  // Both bulk pages are `stellar-verification-page`; the version is the envelope's only.
  expect(response.json?.schema).toBe("stellar-verification-page");
  expect(response.json?.schema_version).toBe("1.0");
  expect(response.json?.order).toBe(order);
  expect(Array.isArray(response.json?.records)).toBe(true);
  expect(response.json?.cursor === null || typeof response.json?.cursor === "string").toBe(true);
}

function expectQueryBulkPageOrUnavailable(response: HttpResult, order: "asc" | "desc"): void {
  if (response.status === 503) {
    const error = expectErrorEnvelope(response);
    expect(error.error).toBe("aggregation_unavailable");
    expect(error.status_code).toBe(503);
    return;
  }
  expectBulkPage(response, order);
}

function expectWasmStatus(response: HttpResult, wasmHash: string): void {
  expectStatus(response, 200);
  // CV1 — the document names its own type beside its version.
  expect(response.json?.schema).toBe("stellar-verification-aggregate");
  expect(response.json?.schema_version).toBe("1.0");
  expect(response.json?.wasm_hash).toBe(wasmHash);
  expect(typeof response.json?.updated_at).toBe("string");
  expect(Array.isArray(response.json?.source_code_verifications)).toBe(true);
  expect(Array.isArray(response.json?.unavailable_verifiers)).toBe(true);
  expect(typeof response.json?.agreement).toBe("string");
}

async function waitForAggregateResponse(wasmHash: string): Promise<HttpResult> {
  const deadline = Date.now() + 60_000;
  let latest: HttpResult | undefined;
  while (Date.now() < deadline) {
    latest = await http(aggregatedByHashUrl(wasmHash));
    if (latest.status === 200 && Array.isArray(latest.json?.source_code_verifications) && latest.json.source_code_verifications.length > 0) return latest;
    await sleep(env.pollIntervalMs);
  }
  throw new Error(`Query aggregation did not expose ${wasmHash} within 60 seconds. Last response: ${latest?.text}`);
}

function truncate(text: string, max = 800): string {
  return text.length <= max ? text : `${text.slice(0, max)}... (${text.length} bytes total)`;
}
