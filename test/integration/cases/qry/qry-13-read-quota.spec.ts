/** E2E-QRY-13 — the read surface refuses excess cleanly, through the balancer. */
import { caseBlock } from "../../support/gate.js";
import { deploymentParameters, env } from "../../support/env.js";
import { expectErrorEnvelope, http, sleep } from "../../support/http.js";
import type { HttpResult } from "../../support/http.js";
import { aggregatedByAddressUrl } from "../../support/routes.js";

/**
 * Malformed, not merely undeployed: a CRC-valid address resolves over Soroban RPC once per admitted request,
 * which at this burst size would point thousands of them at the upstream. This one is counted by the quota
 * gate and refused before any `fetch`.
 */
const MALFORMED_ADDRESS = "not-a-contract-address";

const WINDOW_MS = deploymentParameters.windowQueryMs ?? 60_000;
const CONCURRENCY = Number(process.env.SCVS_E2E_PROBE_CONCURRENCY ?? 64);

/**
 * How many times the declared ceiling this burst sends. The quota is per process with no shared tier, so the
 * ceiling a caller meets behind the balancer is the task count times the declared one — unknown here, and the
 * reason `quota + margin` refuses nothing on two tasks. Sized to exceed it below this many tasks; the case
 * asserts refusal, never the ceiling.
 */
const PROBE_MULTIPLIER = Number(process.env.SCVS_E2E_QUERY_PROBE_MULTIPLIER ?? 4);

/** Slack on top of the idle below. Not clock skew — no clock but the deployment's own is involved. */
const WINDOW_START_MARGIN_MS = 5_000;

const PROBE_TIMEOUT_MS = 2 * WINDOW_MS + 2 * env.requestTimeoutMs + 30_000;

interface Probe {
  /** Requests the route did not refuse with `429`. */
  readonly admitted: number;
  readonly limited: number;
  readonly limitedResponses: readonly HttpResult[];
  /** A quota that sheds load by falling over is not a quota. `503` is excluded — see the assertion. */
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

  // `next++` needs no lock: one JS thread, and no `await` between the read and the increment.
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

/**
 * This tier anchors a window to its key's first hit, not to a wall-clock boundary — SEC-11 waits for a
 * boundary because `AbuseGuard` floors to one, and that helper does nothing here. QRY-07 drives this route
 * just before, leaving windows part-spent with an unknown remainder, so a burst starting there would straddle
 * an expiry and meet the ceiling twice. One full window of silence retires them.
 */
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

  // A burst the client could not deliver is not an observation of the server, and must not be reported as one.
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
  // 503 is this service's honest "the aggregation index is still building", not a failure under load.
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

/** The other half: a burst outlasting the window it opened is counted twice from zero on that task. */
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
    it(
      "refuses the excess, in the vocabulary RC6 defines, without falling over",
      async () => {
        const declared = deploymentParameters.quotaQuery!;
        const attempts = declared * PROBE_MULTIPLIER + Math.max(20, Math.ceil(declared * 0.05));

        // Both halves of the window condition — see each helper for what it rules out.
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

        // A quota that sheds load by falling over is not a quota. This is the assertion that holds whatever
        // the task count is, and the reason the case is worth running at all: the refusal has to survive the
        // balancer as the service's own answer, not as the front door giving up.
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

        // …and it says why, in the vocabulary RC6 defines — not `request_failed`, which is what a bare
        // ThrottlerException would have produced.
        for (const response of probe.limitedResponses) {
          expect(expectErrorEnvelope(response).error).toBe("rate_limited");
        }
      },
      PROBE_TIMEOUT_MS,
    );
  },
);
