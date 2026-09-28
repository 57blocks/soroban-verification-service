import { caseBlock } from "../../support/gate.js";
import { deploymentParameters, env } from "../../support/env.js";
import { expectErrorEnvelope, expectStatus, http, postJson, sleep } from "../../support/http.js";
import type { HttpResult } from "../../support/http.js";
import {
  adminHostRootProbeUrls,
  adminProbeUrls,
  aggregatedByHashUrl,
  hostRootControlUrl,
  submitUrl,
} from "../../support/routes.js";
import { readPolicy } from "../../support/result-tree.js";

caseBlock(
  {
    id: "E2E-SEC-14/no_management_surface",
    title: "there is no `/admin/*` surface — not even a guarded one",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL"],
    prerequisites: ["P1", "P10"],
  },
  () => {
    it("404s every management path in the service's namespace, on every method", async () => {
      for (const url of adminProbeUrls()) {
        for (const method of ["GET", "POST", "DELETE"]) {
          const response = await http(url, { method });

          expect(response.status).not.toBe(401);
          expect(response.status).not.toBe(403);
          expect([404, 405]).toContain(response.status);
          if (response.status === 404) expect(expectErrorEnvelope(response).error).toBe("not_found");
        }
      }
    });

    it("404s `/admin/*` at the host root too, indistinguishably from any other unrouted path", async () => {
      for (const method of ["GET", "POST", "DELETE"]) {
        const control = await http(hostRootControlUrl(), { method });
        expect(control.status).toBe(404);
        for (const url of adminHostRootProbeUrls()) {
          const response = await http(url, { method });
          expect(response.status).not.toBe(401);
          expect(response.status).not.toBe(403);
          expect(response.status).toBe(404);
          expect(response.text).toBe(control.text);
        }
      }
    });

    it("serves an OpenAPI document with no path under `/admin/`", async () => {
      const spec = await http(`${env.verifyUrl}/api/verification/v1/openapi.json`);
      expectStatus(spec, 200);
      const paths = Object.keys(spec.json?.paths ?? {});
      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths) {
        expect(path.startsWith("/admin")).toBe(false);
      }
    });
  }
);

caseBlock(
  {
    id: "E2E-SEC-14/policy_matches_boot_configuration",
    title: "`policy.json` describes what the process actually booted with",
    mode: "AUTO",
    needs: ["SCVS_E2E_RESULT_ROOT"],
    prerequisites: ["P1"],
  },
  () => {
    it("is stable across the run — a change without a redeploy would mean a mutation path exists", async () => {
      const before = await http(`${env.resultRoot}/policy.json`);
      expectStatus(before, 200);

      const policy = await readPolicy();
      expect(policy.schema).toBe("stellar-verifier-policy-v1");
      expect(Array.isArray(policy.build_images.accepted_trust_levels)).toBe(true);

      expect(policy.build_images.digest_pinned_only).toBe(true);
      expect(policy.build_images.tag_only_allowed).toBe(false);

      const after = await http(`${env.resultRoot}/policy.json`);
      expect(after.text).toBe(before.text);
    });
  }
);

const PROBE_MARGIN = Math.max(20, Math.ceil((deploymentParameters.quotaSubmit ?? 0) * 0.05));

const PROBE_ATTEMPTS = (deploymentParameters.quotaSubmit ?? 0) + PROBE_MARGIN;

const PROBE_CONCURRENCY = Number(process.env.SCVS_E2E_PROBE_CONCURRENCY ?? 64);

const SUBMIT_WINDOW_MS = deploymentParameters.windowSubmitMs ?? 60_000;

const ONE_LEG_TIMEOUT_MS = SUBMIT_WINDOW_MS + 2 * env.requestTimeoutMs + 30_000;

const PROBE_TIMEOUT_MS = 2 * SUBMIT_WINDOW_MS + 2 * env.requestTimeoutMs + 30_000;

const WINDOW_START_MARGIN_MS = 5_000;

interface Ceiling {
  readonly admitted: number;
  readonly limited: number;
  readonly refusedByValidation: number;
  readonly limitedResponses: readonly HttpResult[];
  readonly serverErrors: number;
  readonly serverErrorResponses: readonly HttpResult[];
  readonly attempts: number;
  readonly startedAt: number;
  readonly completedAt: number;
}

type BurstOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

async function sendBurst<T>(
  send: (index: number) => Promise<T>,
  attempts: number,
  concurrency: number
): Promise<BurstOutcome<T>[]> {
  const outcomes: BurstOutcome<T>[] = new Array(attempts);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= attempts) return;
      try {
        outcomes[index] = { ok: true, value: await send(index) };
      } catch (error) {
        outcomes[index] = { ok: false, error };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, attempts) }, worker));
  return outcomes;
}

/** The quota window is aligned to wall-clock boundaries, not to the first request. */
async function waitForFreshWindow(windowMs: number): Promise<void> {
  const remainder = Date.now() % windowMs;
  await sleep(windowMs - remainder + WINDOW_START_MARGIN_MS);
}

function describeTransportFailure(error: unknown): string {
  const cause = (error as { cause?: { name?: string; code?: string } } | undefined)?.cause;
  return cause?.code ?? cause?.name ?? String(error).split("\n")[0];
}

async function probeCeiling(
  send: (index: number) => Promise<HttpResult>,
  attempts: number
): Promise<Ceiling> {
  const startedAt = Date.now();
  const outcomes = await sendBurst(send, attempts, PROBE_CONCURRENCY);
  const completedAt = Date.now();

  let admitted = 0;
  let limited = 0;
  let refusedByValidation = 0;
  let serverErrors = 0;
  const limitedResponses: HttpResult[] = [];
  const serverErrorResponses: HttpResult[] = [];
  const transportFailures: string[] = [];

  for (const outcome of outcomes) {
    if (!outcome.ok) {
      transportFailures.push(describeTransportFailure(outcome.error));
      continue;
    }
    const response = outcome.value;
    if (response.status === 429) {
      limited += 1;
      limitedResponses.push(response);
    } else {
      admitted += 1;
      if (response.status === 400 && response.json?.error === "invalid_request") {
        refusedByValidation += 1;
      }
    }
    if (response.status >= 500) {
      serverErrors += 1;
      serverErrorResponses.push(response);
    }
  }

  if (transportFailures.length > 0) {
    throw new Error(
      `${transportFailures.length}/${attempts} requests never reached the deployment ` +
        `(${[...new Set(transportFailures)].sort().join(", ")}). This is a client-side transport ` +
        `limit, not a quota observation: lower SCVS_E2E_PROBE_CONCURRENCY (currently ` +
        `${PROBE_CONCURRENCY}), raise SCVS_E2E_REQUEST_TIMEOUT_MS if the failures are read timeouts, ` +
        `or run this case from inside the deployment's region. Do not read the ${admitted + limited} ` +
        `responses that did arrive as a ceiling.`
    );
  }

  return {
    admitted,
    limited,
    refusedByValidation,
    limitedResponses,
    serverErrors,
    serverErrorResponses,
    attempts,
    startedAt,
    completedAt,
  };
}

function describeProbe(probe: Ceiling): string {
  return (
    `attempts=${probe.attempts} admitted=${probe.admitted} limited=${probe.limited} ` +
    `refusedByValidation=${probe.refusedByValidation} serverErrors=${probe.serverErrors} ` +
    `burst=${probe.completedAt - probe.startedAt}ms concurrency=${PROBE_CONCURRENCY}`
  );
}

function quotaProbeBody(index: number) {
  return {
    target: { network: `invalid-for-quota-probe-${index}`, contract_id: `C${"A".repeat(54)}` },
  };
}

function expectRefusedNotShed(probe: Ceiling, route: string): void {
  if (probe.serverErrors === 0) return;

  const shown = probe.serverErrorResponses.slice(0, 3).map((response) => {
    const body = response.json
      ? `service error envelope: ${JSON.stringify(response.json)}`
      : `not JSON — a proxy page or an empty body: ` +
        JSON.stringify(response.text.slice(0, 200).replace(/\s+/g, " "));
    return `${response.status} after ${response.durationMs}ms · ${body}`;
  });

  throw new Error(
    `${route}: ${probe.serverErrors}/${probe.attempts} requests were answered 5xx, while ` +
      `${probe.limited} were refused with 429. S15 requires the excess to be rate-limited, not shed.\n` +
      `  · ${describeProbe(probe)}\n` +
      `  · ${shown.join("\n  · ")}\n` +
      `  · A 5xx carrying the service's own JSON envelope is a failure in the quota tier. An HTML page ` +
      `from a reverse proxy is the front door shedding the burst — weigh that against the deployment's ` +
      `task count and SCVS_E2E_PROBE_CONCURRENCY (currently ${PROBE_CONCURRENCY}) before reading it as ` +
      `a statement about the quota.`
  );
}

function expectOneWindow(probe: Ceiling, windowMs: number, route: string): void {
  const startedWindow = Math.floor(probe.startedAt / windowMs);
  const completedWindow = Math.floor((probe.completedAt - 1) / windowMs);
  if (startedWindow === completedWindow) return;

  throw new Error(
    `${route} burst crossed a fixed ${windowMs} ms window (${probe.completedAt - probe.startedAt} ms). ` +
      "This is not a valid S15 measurement: requests were split across counters, so no conclusion " +
      "about the enforced quota or caller fingerprint is possible. Raise SCVS_E2E_PROBE_CONCURRENCY " +
      `(currently ${PROBE_CONCURRENCY}) so ${probe.attempts} requests fit one window from here.`
  );
}

caseBlock(
  {
    id: "E2E-SEC-11",
    title: "the submission quota is enforced, and excess is rate-limited rather than 5xx",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL"],
    prerequisites: ["P1"],
    unless: () =>
      deploymentParameters.quotaSubmit
        ? undefined
        : "📐 QUOTA_SUBMIT is not published in policy.json and SCVS_E2E_QUOTA_SUBMIT is unset — " +
          "the case says to obtain it from the deployment, not to guess",
  },
  () => {
    it(
      "accepts no more than the quota, and refuses the rest cleanly",
      async () => {
        const quota = deploymentParameters.quotaSubmit!;

        await waitForFreshWindow(SUBMIT_WINDOW_MS);

        const submit = await probeCeiling(
          (index) => postJson(submitUrl(), quotaProbeBody(index)),
          PROBE_ATTEMPTS
        );
        expectOneWindow(submit, SUBMIT_WINDOW_MS, "submission");

        if (submit.limited === 0) {
          throw new Error(
            `The submission route refused none of ${submit.attempts} requests, though the deployment ` +
              `declares QUOTA_SUBMIT=${quota}. Every request reached the deployment and the burst stayed ` +
              `inside one ${SUBMIT_WINDOW_MS} ms window, so this is an observation of the service and not ` +
              `of the client.\n` +
              `  · ${describeProbe(submit)}\n` +
              `  · Read the counter directly: \`select route, window_start, count from abuse_control ` +
              `where window_start > now() - interval '30 minutes' order by window_start desc\`. One row ` +
              `at ~${submit.attempts} means the live limit is not ${quota}. A row at ~${quota} with ` +
              `requests missing means they were counted somewhere else — a neighbouring window_start ` +
              `(raise WINDOW_START_MARGIN_MS) or a second submitter_fingerprint. Since a later fix this ` +
              `probe's requests all key on ONE fingerprint (the address the ALB observed), so a split ` +
              `across two now means the deployment is running a build from before that fix, where ` +
              `req.ip was the proxy's peer address and one client's burst fragmented across proxy ` +
              `nodes — check which build the deployment is actually running. No row at all means ` +
              `AbuseGuard failed open — grep the service log for "failing open".`
          );
        }

        expectRefusedNotShed(submit, "submission");

        for (const response of submit.limitedResponses) {
          expect(["rate_limited", "request_failed"]).toContain(response.json?.error);
        }

        expect(submit.refusedByValidation).toBe(submit.admitted - submit.serverErrors);

        expect(submit.refusedByValidation).toBeLessThanOrEqual(quota + 1);
      },
      ONE_LEG_TIMEOUT_MS
    );
  }
);

caseBlock(
  {
    id: "E2E-SEC-12",
    title: "submission is throttled more tightly than query (S15)",
    mode: "AUTO",
    needs: ["SCVS_E2E_VERIFY_URL", "SCVS_E2E_QUERY_URL"],
    prerequisites: ["P1"],
    unless: () =>
      deploymentParameters.quotaSubmit
        ? undefined
        : "📐 QUOTA_SUBMIT is not published in policy.json and SCVS_E2E_QUOTA_SUBMIT is unset — " +
          "S15's relation is measured against the deployment's own submission ceiling, and this case " +
          "does not get to invent one. A literal ramp is what made it unrunnable before: see the " +
          "probe's note above, and SCVS_THROTTLE_LIMIT's note in config/env-manifest.yaml",
  },
  () => {
    afterAll(async () => {
      if (deploymentParameters.quotaSubmit) await sleep(SUBMIT_WINDOW_MS);
    }, SUBMIT_WINDOW_MS + 60_000);

    it(
      "reaches the submission ceiling before the query ceiling, in the same units",
      async () => {
        const quota = deploymentParameters.quotaSubmit!;

        await waitForFreshWindow(SUBMIT_WINDOW_MS);
        const submit = await probeCeiling(
          (index) => postJson(submitUrl(), quotaProbeBody(index)),
          PROBE_ATTEMPTS
        );
        expectOneWindow(submit, SUBMIT_WINDOW_MS, "submission");

        if (submit.limited === 0) {
          throw new Error(
            `The submission route admitted all ${submit.attempts} requests without a 429, though the ` +
              `deployment declares QUOTA_SUBMIT=${quota}. The burst stayed within one window, so inspect ` +
              `the live configuration and AbuseGuard's error logs: it either enforces another quota or ` +
              `failed open while counting this caller.\n  · ${describeProbe(submit)}`
          );
        }

        expectRefusedNotShed(submit, "submission");

        await waitForFreshWindow(SUBMIT_WINDOW_MS);
        const query = await probeCeiling(
          () => http(aggregatedByHashUrl("0".repeat(64))),
          PROBE_ATTEMPTS
        );
        expectOneWindow(query, SUBMIT_WINDOW_MS, "query");
        expectRefusedNotShed(query, "query");

        expect(submit.admitted).toBeLessThan(query.admitted);
      },
      PROBE_TIMEOUT_MS
    );
  }
);
