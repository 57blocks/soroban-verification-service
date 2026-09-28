import { caseBlock } from "../../support/gate.js";
import { fixtures, missingFixture } from "../../support/fixtures.js";
import { env } from "../../support/env.js";
import { expectErrorEnvelope, expectStatus, http } from "../../support/http.js";
import { expectPerTrd } from "../../support/conformance.js";
import {
  aggregatedByAddressUrl,
  aggregatedByHashUrl,
  aggregatedBulkLoadUrl,
  verifiersUrl,
} from "../../support/routes.js";
import type { AggregatedWasmStatus } from "../../support/types.js";

/** CRC-valid contract address that is never deployed. */
const NONEXISTENT_ADDRESS = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const MALFORMED_ADDRESS = "not-a-contract-address";
const NEVER_SEEN_HASH = "e".repeat(64);

caseBlock(
  {
    id: "E2E-QRY-07",
    title: "invalid, absent and degraded are three distinguishable answers",
    mode: "AUTO",
    needs: ["SCVS_E2E_QUERY_URL"],
    prerequisites: ["P1"],
  },
  () => {
    it("rejects a malformed address rather than treating it as a miss", async () => {
      const response = await http(aggregatedByAddressUrl(env.network, MALFORMED_ADDRESS));
      const envelope = expectErrorEnvelope(response);

      expect(["invalid_request", "invalid_contract_id"]).toContain(envelope.error);

      expectPerTrd("ERROR_ENVELOPE_SCHEMA_VERSION", "E2E-QRY-07", () => {
        expect(typeof envelope.schema_version).toBe("string");
      });
    });

    it("reports a well-formed but undeployed address as not found", async () => {
      const response = await http(aggregatedByAddressUrl(env.network, NONEXISTENT_ADDRESS));

      expectStatus(response, 404, 502);
      const envelope = expectErrorEnvelope(response);
      expect(["not_found", "contract_not_found", "address_resolution_failed"]).toContain(envelope.error);
    });

    it("rejects an unknown network name", async () => {
      const response = await http(aggregatedByAddressUrl("futurenet", NONEXISTENT_ADDRESS));
      const envelope = expectErrorEnvelope(response);
      expect(["invalid_network", "invalid_request"]).toContain(envelope.error);
    });
  }
);

caseBlock(
  {
    id: "E2E-QRY-06",
    title: "an address is resolved from the ledger on every request, never cached",
    mode: "AUTO",
    needs: ["SCVS_E2E_QUERY_URL"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-UPG"),
  },
  () => {
    it("returns the same hash on repeated reads, and no address-keyed file exists", async () => {
      const contract = fixtures.contracts["F-UPG"];

      const first = await http(aggregatedByAddressUrl(contract.network, contract.contract_id!));
      const second = await http(aggregatedByAddressUrl(contract.network, contract.contract_id!));

      expectStatus(first, 200);
      expectStatus(second, 200);
      expect((second.json as AggregatedWasmStatus).wasm_hash).toBe(
        (first.json as AggregatedWasmStatus).wasm_hash
      );

      const addressKeyed = await http(`${env.resultRoot}/contracts/${contract.contract_id}.json`);
      expect([403, 404]).toContain(addressKeyed.status);
    });
  }
);

caseBlock(
  {
    id: "E2E-QRY-11",
    title: "every query surface is open — no identity, no cookie, no gate",
    mode: "AUTO",
    needs: ["SCVS_E2E_QUERY_URL"],
    prerequisites: ["P1"],
  },
  () => {
    it("serves an unauthenticated client and sets no tracking cookie", async () => {
      const urls = [
        aggregatedByHashUrl(NEVER_SEEN_HASH),
        aggregatedBulkLoadUrl({ limit: 1 }),
        verifiersUrl(),
      ];

      for (const url of urls) {
        const response = await http(url, { bare: true });
        expect(response.status).toBeLessThan(500);

        expect(response.headers.get("set-cookie")).toBeNull();

        expect(response.status).not.toBe(401);
        expect(response.status).not.toBe(403);
        expect(response.headers.get("www-authenticate")).toBeNull();
      }
    });

    it("sets `Access-Control-Allow-Origin: *` on error responses too (RC5)", async () => {
      const failing = await http(aggregatedByAddressUrl(env.network, MALFORMED_ADDRESS));
      expect(failing.status).toBeGreaterThanOrEqual(400);
      expect(failing.headers.get("access-control-allow-origin")).toBe("*");

      const succeeding = await http(verifiersUrl());
      expect(succeeding.headers.get("access-control-allow-origin")).toBe("*");
    });
  }
);

caseBlock(
  {
    id: "E2E-QRY-12",
    title: "a GET never enqueues work",
    mode: "AUTO",
    needs: ["SCVS_E2E_QUERY_URL"],
    prerequisites: ["P1"],
  },
  () => {
    it("reads a never-seen hash forty times and creates nothing", async () => {
      const before = await http(aggregatedByHashUrl(NEVER_SEEN_HASH));
      expectStatus(before, 200, 404);

      for (let index = 0; index < 20; index += 1) {
        await http(aggregatedByHashUrl(NEVER_SEEN_HASH));
        await http(aggregatedByAddressUrl(env.network, NONEXISTENT_ADDRESS));
      }

      const after = await http(aggregatedByHashUrl(NEVER_SEEN_HASH));
      expect(after.status).toBe(before.status);
      if (after.status === 200) {
        expect((after.json as AggregatedWasmStatus).source_code_verifications).toHaveLength(0);
        expect((after.json as AggregatedWasmStatus).agreement).toBe("no_data");
      }
    });

    it("ignores a plausible enqueue parameter rather than honouring it", async () => {
      const response = await http(`${aggregatedByHashUrl(NEVER_SEEN_HASH)}?enqueue=true&force=true`);
      expectStatus(response, 200, 400, 404);
      if (response.status === 200) {
        expect((response.json as AggregatedWasmStatus).source_code_verifications).toHaveLength(0);
      }
    });
  }
);
