import { caseBlock } from "../../support/gate.js";
import { fixtures, missingFixture } from "../../support/fixtures.js";
import { expectStatus, http } from "../../support/http.js";
import { preflight } from "../../support/job.js";
import {
  aggregatedByAddressUrl,
  aggregatedByHashUrl,
  staticWasmStatusUrl,
} from "../../support/routes.js";
import type { AggregatedWasmStatus } from "../../support/types.js";

const FIXTURE_ID = "F-MAINNET-READ-ONLY";
const EXPECTED_CLIVER = "27.0.0#5a7c5fe76530bf4248477ac812fc757146b98cc4";
const EXPECTED_RSVER = "1.97.1";

caseBlock(
  {
    id: "E2E-NET-01/read_only_mainnet",
    title: "preflight, metadata, address resolution, storage and hash query read mainnet without a signer",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_QUERY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture(FIXTURE_ID),
  },
  () => {
    const target = fixtures.contracts[FIXTURE_ID];

    it("preflight reads the public mainnet contract and its cli-legacy toolchain metadata", async () => {
      const response = await preflight({
        network: "mainnet",
        contract_id: target.contract_id,
        wasm_hash: target.wasm_hash,
      });
      expectStatus(response, 200);

      const body = response.json;
      expect(body.target?.network).toBe("mainnet");
      expect(body.target?.contract_id).toBe(target.contract_id);
      expect(body.wasm_hash).toBe(target.wasm_hash);
      expect(body.available_fields?.cliver).toBe(EXPECTED_CLIVER);
      expect(body.available_fields?.rsver).toBe(EXPECTED_RSVER);
      expect(body.build_environment?.kind).toBe("compose");
      expect(body.build_environment?.intent?.pair).toEqual({
        cliver: EXPECTED_CLIVER,
        rsver: EXPECTED_RSVER,
      });

      expect(body.missing_fields).toEqual(expect.arrayContaining(["source_sha256", "source_uri"]));
      expect(body.missing_fields).not.toContain("bldimg");
    });

    it("resolves the mainnet address to the same deployed Wasm hash", async () => {
      const response = await http(aggregatedByAddressUrl("mainnet", target.contract_id!));
      expectStatus(response, 200);

      const body = response.json as AggregatedWasmStatus;
      expect(body.wasm_hash).toBe(target.wasm_hash);
      expect(Array.isArray(body.source_code_verifications)).toBe(true);
      expect(Array.isArray(body.unavailable_verifiers)).toBe(true);
    });

    it("queries that resolved mainnet Wasm hash without a network selector", async () => {
      const response = await http(aggregatedByHashUrl(target.wasm_hash!));
      expectStatus(response, 200);

      const body = response.json as AggregatedWasmStatus;
      expect(body.wasm_hash).toBe(target.wasm_hash);
      expect(Array.isArray(body.source_code_verifications)).toBe(true);
      expect(["single", "unanimous_verified", "unanimous_mismatched", "disputed", "unverified_only", "no_data"])
        .toContain(body.agreement);
    });

    it("does not expose a mainnet-partitioned status-object namespace", async () => {
      const unpartitioned = staticWasmStatusUrl(target.wasm_hash!);
      const partitioned = unpartitioned.replace("/wasms/", "/wasms/mainnet/");
      expect(unpartitioned).not.toContain("/wasms/mainnet/");

      expectStatus(await http(unpartitioned), 200, 403, 404);
      expectStatus(await http(partitioned), 403, 404);
    });
  }
);
