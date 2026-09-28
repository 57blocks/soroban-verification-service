import { evaluateNoSecondBuild, expectNoSecondBuild, observeBuild } from "../../support/dedup.js";
import { env } from "../../support/env.js";
import { fixtures, missingFixture, submissionFor } from "../../support/fixtures.js";
import { caseBlock } from "../../support/gate.js";
import {
  expectErrorEnvelope,
  expectStatus,
  http,
  postJson,
  type HttpResult,
} from "../../support/http.js";
import { submitAndWait, waitForTerminal } from "../../support/job.js";
import { submitUrl } from "../../support/routes.js";
import { reportForJob, requireStatusObject } from "../../support/result-tree.js";
import type { SubmitBody } from "../../support/types.js";

const CASE_TIMEOUT = 2 * env.jobTimeoutMs + 120_000;

interface PublicForceAttempt {
  readonly label: string;
  readonly send: (body: SubmitBody) => Promise<HttpResult>;
}

const publicForceAttempts: readonly PublicForceAttempt[] = [
  {
    label: "body.force",
    send: (body) => postJson(submitUrl(), { ...body, force: true }),
  },
  {
    label: "body.force_reverify",
    send: (body) => postJson(submitUrl(), { ...body, force_reverify: true }),
  },
  {
    label: "body.reverify",
    send: (body) => postJson(submitUrl(), { ...body, reverify: true }),
  },
  {
    label: "query.force",
    send: (body) => postJson(`${submitUrl()}?force=true`, body),
  },
  {
    label: "header.X-Force-Reverify",
    send: (body) =>
      postJson(submitUrl(), body, { headers: { "x-force-reverify": "true" } }),
  },
];

function requireQueuedJobId(response: HttpResult, label: string): string {
  const jobId = response.json?.job_id;
  if (typeof jobId === "string") return jobId;
  throw new Error(`${label} returned 202 without a job_id. Body: ${response.text}`);
}

function advertisedInputNames(value: unknown): string[] {
  const names: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    if (!node || typeof node !== "object") return;

    for (const [key, child] of Object.entries(node)) {
      if (key === "properties" && child && typeof child === "object" && !Array.isArray(child)) {
        names.push(...Object.keys(child));
      }
      if (key === "parameters" && Array.isArray(child)) {
        for (const parameter of child) {
          if (parameter && typeof parameter === "object" && typeof parameter.name === "string") {
            names.push(parameter.name);
          }
        }
      }
      visit(child);
    }
  };
  visit(value);
  return names;
}

caseBlock(
  {
    id: "E2E-DEDUP-04/force_reverify_not_user_facing",
    title: "public force-like inputs cannot bypass the terminal verified result",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
    unless: () => missingFixture("F-LEG-1"),
  },
  () => {
    it("does not advertise a force or reverify input in OpenAPI", async () => {
      const spec = await http(`${env.verifyUrl}/api/verification/v1/openapi.json`);
      expectStatus(spec, 200);

      for (const name of advertisedInputNames(spec.json)) {
        expect(name.toLowerCase()).not.toMatch(/force|reverify/);
      }
    });

    it(
      "rejects or ignores every public force form without starting a second build",
      async () => {
        const body = await submissionFor("F-LEG-1");
        const firstRun = await submitAndWait(body);
        expect(firstRun.body.status).toBe("verified");

        const hash = firstRun.body.result?.wasm_hash ?? fixtures.contracts["F-LEG-1"].wasm_hash!;
        const firstReport = await reportForJob(firstRun.body.result, hash);
        if (!firstReport) {
          throw new Error("the baseline verified job exposed no report artifact");
        }

        const first = await observeBuild(firstRun.jobId, firstRun, firstReport.artifact);
        const before = await requireStatusObject(hash);
        const firstArtifactUrl = firstRun.body.result?.artifact_url;
        expect(firstArtifactUrl).toBeDefined();

        for (const attempt of publicForceAttempts) {
          const submittedAt = Date.now();
          const response = await attempt.send(body);

          if (response.status >= 400) {
            expectStatus(response, 400);
            expect(expectErrorEnvelope(response).error).toBe("invalid_request");
          } else {
            expectStatus(response, 202);
            const jobId = requireQueuedJobId(response, attempt.label);
            expect(jobId).not.toBe(firstRun.jobId);

            const terminal = await waitForTerminal(jobId, { startedAt: submittedAt });
            expect(terminal.body.status).toBe("verified");
            expect(terminal.body.result?.artifact_url).toBe(firstArtifactUrl);

            const report = await reportForJob(terminal.body.result, hash);
            if (!report) {
              throw new Error(`${attempt.label} reached verified without a report artifact`);
            }
            const observation = await observeBuild(jobId, terminal, report.artifact);
            expectNoSecondBuild(evaluateNoSecondBuild(first, observation));
          }

          const after = await requireStatusObject(hash);
          expect(after.updated_at).toBe(before.updated_at);
        }
      },
      CASE_TIMEOUT
    );
  }
);
