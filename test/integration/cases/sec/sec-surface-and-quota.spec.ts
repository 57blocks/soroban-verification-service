/** E2E-SEC-14/no_management_surface. */
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

          // HA1 — 404, from this network position, **in the service's own error envelope**.
          expect(response.status).not.toBe(401);
          expect(response.status).not.toBe(403);
          expect([404, 405]).toContain(response.status);
          if (response.status === 404) expect(expectErrorEnvelope(response).error).toBe("not_found");
        }
      }
    });

    it("404s `/admin/*` at the host root too, indistinguishably from any other unrouted path", async () => {
      // The probes above ask verification-svc. This one asks the position an outside auditor actually occupies,
      // where nothing routes `/admin/*` and `web` answers.
      for (const method of ["GET", "POST", "DELETE"]) {
        const control = await http(hostRootControlUrl(), { method });
        // The control pins the code rather than only the comparison: two paths that agree on `200` would
        // satisfy indistinguishability while telling an auditor something is there.
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
      // HA3. The document is the other place a management surface leaks — an endpoint can be removed from the
      // router and left in the spec, and integrators build against the spec.
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

      // This is what a submitter reads to know why a tag-only reference was refused (E2E-SUB-05/tag_only).
      expect(policy.build_images.digest_pinned_only).toBe(true);
      expect(policy.build_images.tag_only_allowed).toBe(false);

      // HA2 — byte-identical across the run. There is no operation that should be able to change it, so any
      // change is the finding.
      const after = await http(`${env.resultRoot}/policy.json`);
      expect(after.text).toBe(before.text);
    });
  }
);

/** ── The quota probe, shared by E2E-SEC-11 and E2E-SEC-12 ────────────────────────────────────── */

/** Requests sent past the ceiling, as a FRACTION of it rather than a literal. */
const PROBE_MARGIN = Math.max(20, Math.ceil((deploymentParameters.quotaSubmit ?? 0) * 0.05));

const PROBE_ATTEMPTS = (deploymentParameters.quotaSubmit ?? 0) + PROBE_MARGIN;

/**
 * Raise it when the burst cannot fit one window from where you are running (that is `expectOneWindow`'s
 * failure).
 */
const PROBE_CONCURRENCY = Number(process.env.SCVS_E2E_PROBE_CONCURRENCY ?? 64);

/** The service's own default; `SCVS_E2E_WINDOW_SUBMIT_MS` is the deployment's published value. */
const SUBMIT_WINDOW_MS = deploymentParameters.windowSubmitMs ?? 60_000;

/** One fresh-window wait, one burst, and enough room to report an invalid slow one. */
const ONE_LEG_TIMEOUT_MS = SUBMIT_WINDOW_MS + 2 * env.requestTimeoutMs + 30_000;

/** Two fresh-window waits, two request timeouts, and enough room to report an invalid slow burst. */
const PROBE_TIMEOUT_MS = 2 * SUBMIT_WINDOW_MS + 2 * env.requestTimeoutMs + 30_000;

/** Keep clear of a boundary even when the runner and deployment clocks differ. */
const WINDOW_START_MARGIN_MS = 5_000;

interface Ceiling {
  /** Requests the route did not refuse with `429` — the measured ceiling within this burst. */
  readonly admitted: number;
  /** Refusals seen. Zero means the route never said no within `attempts`. */
  readonly limited: number;
  /**
   * Requests that got past the quota gate and were then refused by the `ValidationPipe` — `400` carrying
   * `invalid_request`.
   */
  readonly refusedByValidation: number;
  /** The `429` responses themselves, for the case that asserts RC6's refusal vocabulary. */
  readonly limitedResponses: readonly HttpResult[];
  /** A quota that sheds load by falling over is not a quota (SEC-11's HA2, asserted here too). */
  readonly serverErrors: number;
  /** The 5xx responses themselves. */
  readonly serverErrorResponses: readonly HttpResult[];
  readonly attempts: number;
  readonly startedAt: number;
  readonly completedAt: number;
}

type BurstOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/** Sends `attempts` requests with at most `concurrency` in flight, and never rejects. */
async function sendBurst<T>(
  send: (index: number) => Promise<T>,
  attempts: number,
  concurrency: number
): Promise<BurstOutcome<T>[]> {
  const outcomes: BurstOutcome<T>[] = new Array(attempts);
  let next = 0;

  // `next++` needs no lock: this is one JS thread and there is no `await` between the read and the increment,
  // so no two workers can claim the same index.
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

/** The counter's window is fixed to wall-clock boundaries, not the first request. */
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

  // A burst the client could not deliver is not an observation of the server's counter, and must not be
  // reported as one.
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

/** The numbers behind a verdict, on one line. */
function describeProbe(probe: Ceiling): string {
  return (
    `attempts=${probe.attempts} admitted=${probe.admitted} limited=${probe.limited} ` +
    `refusedByValidation=${probe.refusedByValidation} serverErrors=${probe.serverErrors} ` +
    `burst=${probe.completedAt - probe.startedAt}ms concurrency=${PROBE_CONCURRENCY}`
  );
}

/** A body the quota gate counts and the `ValidationPipe` then refuses, with nothing in between. */
function quotaProbeBody(index: number) {
  return {
    target: { network: `invalid-for-quota-probe-${index}`, contract_id: `C${"A".repeat(54)}` },
  };
}

/** The criterion is unchanged — no 5xx in the burst. */
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

        // The counter resets on a wall-clock boundary, so a burst that straddles one is counted twice from zero
        // and can admit more than `quota` without the quota being wrong.
        await waitForFreshWindow(SUBMIT_WINDOW_MS);

        const submit = await probeCeiling(
          (index) => postJson(submitUrl(), quotaProbeBody(index)),
          // The same constant SEC-12's two legs use, so "the same number of requests" is one number in this
          // file rather than an equality two call sites have to keep.
          PROBE_ATTEMPTS
        );
        expectOneWindow(submit, SUBMIT_WINDOW_MS, "submission");

        // `limited > 0` is what says the ceiling was reached at all, and it is the number worth having; "how
        // the excess was refused" is only meaningful after it.
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

        // HA2 — the refusal is a 429, not a crash. A quota that sheds load by falling over is not a quota.
        expectRefusedNotShed(submit, "submission");

        // …and it says why, in the vocabulary RC6 defines.
        for (const response of submit.limitedResponses) {
          expect(["rate_limited", "request_failed"]).toContain(response.json?.error);
        }

        // Nothing this probe sent was processed: every request that got past the gate was refused by the pipe.
        expect(submit.refusedByValidation).toBe(submit.admitted - submit.serverErrors);

        // HA1 — no more than the quota got through the gate, counted over the requests that actually reached
        // it.
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
    // The probe deliberately spends the submission budget down to its ceiling.
    afterAll(async () => {
      if (deploymentParameters.quotaSubmit) await sleep(SUBMIT_WINDOW_MS);
    }, SUBMIT_WINDOW_MS + 60_000);

    it(
      "reaches the submission ceiling before the query ceiling, in the same units",
      async () => {
        const quota = deploymentParameters.quotaSubmit!;

        // The same body SEC-11 sends, from the same helper: counted by the quota gate, refused by the pipe, and
        // never processed.
        await waitForFreshWindow(SUBMIT_WINDOW_MS);
        const submit = await probeCeiling(
          (index) => postJson(submitUrl(), quotaProbeBody(index)),
          PROBE_ATTEMPTS
        );
        expectOneWindow(submit, SUBMIT_WINDOW_MS, "submission");

        // Premise before mechanism, as in SEC-11: reaching the ceiling is what this leg is for.
        if (submit.limited === 0) {
          throw new Error(
            `The submission route admitted all ${submit.attempts} requests without a 429, though the ` +
              `deployment declares QUOTA_SUBMIT=${quota}. The burst stayed within one window, so inspect ` +
              `the live configuration and AbuseGuard's error logs: it either enforces another quota or ` +
              `failed open while counting this caller.\n  · ${describeProbe(submit)}`
          );
        }

        expectRefusedNotShed(submit, "submission");

        // The query leg gets the same budget, so "in the same units" is a property of the probe rather than an
        // assumption: same count, same concurrent burst, same window, same fingerprint.
        await waitForFreshWindow(SUBMIT_WINDOW_MS);
        const query = await probeCeiling(
          () => http(aggregatedByHashUrl("0".repeat(64))),
          PROBE_ATTEMPTS
        );
        expectOneWindow(query, SUBMIT_WINDOW_MS, "query");
        expectRefusedNotShed(query, "query");

        // R_submit < R_query. When query does not refuse, its admitted count is the full burst and the same
        // assertion still proves it is the looser route.
        expect(submit.admitted).toBeLessThan(query.admitted);
      },
      PROBE_TIMEOUT_MS
    );
  }
);
