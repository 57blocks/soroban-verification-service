import { caseBlock } from "../../support/gate.js";
import { deploymentParameters, env } from "../../support/env.js";
import { expectErrorEnvelope, http, sleep } from "../../support/http.js";
import type { HttpResult } from "../../support/http.js";
import { aggregatedByAddressUrl } from "../../support/routes.js";

/** Malformed on purpose: a valid address costs one Soroban RPC call per admitted request. */
const MALFORMED_ADDRESS = "not-a-contract-address";

const WINDOW_MS = deploymentParameters.windowQueryMs ?? 60_000;
const CONCURRENCY = Number(process.env.SCVS_E2E_PROBE_CONCURRENCY ?? 64);

/** The quota is per task, so the ceiling behind the balancer is unknown; oversend by this factor. */
const PROBE_MULTIPLIER = Number(process.env.SCVS_E2E_QUERY_PROBE_MULTIPLIER ?? 4);

const WINDOW_START_MARGIN_MS = 5_000;

const PROBE_TIMEOUT_MS = 2 * WINDOW_MS + 2 * env.requestTimeoutMs + 30_000;

const IDLE_TIMEOUT_MS = WINDOW_MS + WINDOW_START_MARGIN_MS + 30_000;

interface Probe {
  readonly admitted: number;
  readonly limited: number;
  readonly limitedResponses: readonly HttpResult[];
  readonly serverErrors: number;
  readonly serverErrorResponses: readonly HttpResult[];
  readonly attempts: number;
  readonly startedAt: number;
  readonly completedAt: number;
}

async function sendBurst(
  send: (index: number) => Promise<HttpResult>,
  attempts: number,
): Promise<{ results: HttpResult[]; transportFailures: string[] }> {
  const results: HttpResult[] = [];
  const transportFailures: string[] = [];
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= attempts) return;
      try {
        results.push(await send(index));
      } catch (error) {
        const cause = (error as { cause?: { name?: string; code?: string } } | undefined)?.cause;
        transportFailures.push(cause?.code ?? cause?.name ?? String(error).split("\n")[0]);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, attempts) }, worker));
  return { results, transportFailures };
}

/** This tier's window starts at a key's first hit, so only a full idle window guarantees fresh ones. */
async function idleUntilEveryWindowHasLapsed(): Promise<void> {
  await sleep(WINDOW_MS + WINDOW_START_MARGIN_MS);
}

async function probeCeiling(attempts: number): Promise<Probe> {
  const startedAt = Date.now();
  const { results, transportFailures } = await sendBurst(
    () => http(aggregatedByAddressUrl(env.network, MALFORMED_ADDRESS)),
    attempts,
  );
  const completedAt = Date.now();

  if (transportFailures.length > 0) {
    throw new Error(
      `${transportFailures.length}/${attempts} requests never reached the deployment ` +
        `(${[...new Set(transportFailures)].sort().join(", ")}). That is a client-side transport limit, not ` +
        `an observation of the quota: lower SCVS_E2E_PROBE_CONCURRENCY (currently ${CONCURRENCY}), raise ` +
        "SCVS_E2E_REQUEST_TIMEOUT_MS if the failures are read timeouts, or run this case from inside the " +
        "deployment's region.",
    );
  }

  const limitedResponses = results.filter((response) => response.status === 429);
  // 503 means the aggregation index is still building, not a failure under load.
  const serverErrorResponses = results.filter(
    (response) => response.status >= 500 && response.status !== 503,
  );
  return {
    admitted: results.length - limitedResponses.length,
    limited: limitedResponses.length,
    limitedResponses,
    serverErrors: serverErrorResponses.length,
    serverErrorResponses,
    attempts,
    startedAt,
    completedAt,
  };
}

function describeProbe(probe: Probe): string {
  return (
    `attempts=${probe.attempts} admitted=${probe.admitted} limited=${probe.limited} ` +
    `serverErrors=${probe.serverErrors} burst=${probe.completedAt - probe.startedAt}ms ` +
    `concurrency=${CONCURRENCY} multiplier=${PROBE_MULTIPLIER}`
  );
}

function expectBurstInsideOneWindow(probe: Probe): void {
  const elapsed = probe.completedAt - probe.startedAt;
  if (elapsed < WINDOW_MS) return;
  throw new Error(
    `The burst took ${elapsed} ms, which is not less than the ${WINDOW_MS} ms window. A window opened by ` +
      "its own first request lapses before its last, so a task counts part of this burst twice from zero " +
      "and nothing about the quota follows. Raise SCVS_E2E_PROBE_CONCURRENCY (currently " +
      `${CONCURRENCY}) so ${probe.attempts} requests complete well inside one window.`,
  );
}

caseBlock(
  {
    id: "E2E-QRY-13",
    title: "the address route refuses excess with 429, and does not shed it as 5xx",
    mode: "AUTO",
    needs: ["SCVS_E2E_QUERY_URL"],
    prerequisites: ["P1"],
    unless: () =>
      deploymentParameters.quotaQuery
        ? undefined
        : "📐 SCVS_E2E_QUOTA_QUERY is unset — the burst is sized from the deployment's declared address-route " +
          "ceiling (SCVS_QUERY_ADDRESS_THROTTLE_LIMIT), and this case sizes itself from the deployment rather " +
          "than inventing a number",
  },
  () => {
    afterAll(idleUntilEveryWindowHasLapsed, IDLE_TIMEOUT_MS);

    it(
      "refuses the excess, in the vocabulary RC6 defines, without falling over",
      async () => {
        const declared = deploymentParameters.quotaQuery!;
        const attempts = declared * PROBE_MULTIPLIER + Math.max(20, Math.ceil(declared * 0.05));

        await idleUntilEveryWindowHasLapsed();
        const probe = await probeCeiling(attempts);
        expectBurstInsideOneWindow(probe);

        if (probe.limited === 0) {
          throw new Error(
            `The address route refused none of ${probe.attempts} requests, though the deployment declares an ` +
              `address-route ceiling of ${declared}. Every request arrived, the burst opened its own window ` +
              "and finished inside it, so this is an observation of the service and not of the client.\n" +
              `  · ${describeProbe(probe)}\n` +
              "  · Two causes are indistinguishable from here, and this case cannot tell them apart: the " +
              "route enforces no quota at all, or this deployment runs more than " +
              `${PROBE_MULTIPLIER} tasks and the burst left every one of them under its own ceiling — the ` +
              "quota is per process, so the reachable ceiling scales with the task count.\n" +
              "  · Check the task count first. If it is at or above the multiplier, raise " +
              "SCVS_E2E_QUERY_PROBE_MULTIPLIER and re-run before reading this as a missing quota.",
          );
        }

        if (probe.serverErrors > 0) {
          const shown = probe.serverErrorResponses.slice(0, 3).map((response) => {
            const body = response.json
              ? `service error envelope: ${JSON.stringify(response.json)}`
              : "not JSON — a proxy page or an empty body: " +
                JSON.stringify(response.text.slice(0, 200).replace(/\s+/g, " "));
            return `${response.status} after ${response.durationMs}ms · ${body}`;
          });
          throw new Error(
            `${probe.serverErrors}/${probe.attempts} requests were answered 5xx, while ${probe.limited} were ` +
              `refused with 429. The excess must be rate-limited, not shed.\n  · ${describeProbe(probe)}\n` +
              `  · ${shown.join("\n  · ")}\n` +
              "  · A 5xx carrying the service's own JSON envelope is a failure in the quota tier. An HTML " +
              "page from a reverse proxy is the front door shedding the burst — weigh that against the " +
              "deployment's task count and SCVS_E2E_PROBE_CONCURRENCY before reading it as a statement " +
              "about the quota.",
          );
        }

        for (const response of probe.limitedResponses) {
          expect(expectErrorEnvelope(response).error).toBe("rate_limited");
        }
      },
      PROBE_TIMEOUT_MS,
    );
  },
);
