import { caseBlock } from "../../support/gate.js";
import { expectStatus, http } from "../../support/http.js";
import { verifyV1HealthUrl } from "../../support/routes.js";

caseBlock(
  {
    id: "E2E-VERIFY-HEALTH",
    title: "the public verification API reports a live versioned health response",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL"],
    prerequisites: ["P1"],
  },
  () => {
    it("returns `ok` and a non-empty version from /v1/health", async () => {
      const response = await http(verifyV1HealthUrl());
      expectStatus(response, 200);
      expect(response.json).toEqual(
        expect.objectContaining({ status: "ok", version: expect.any(String) })
      );
      expect(response.json.version.length).toBeGreaterThan(0);
    });
  }
);
