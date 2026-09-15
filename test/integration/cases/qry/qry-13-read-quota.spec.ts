/** E2E-QRY-13 — the read surface enforces a quota, and the address route's is the tighter one. */
import { caseBlock } from "../../support/gate.js";
import { deploymentParameters, env } from "../../support/env.js";
import { expectErrorEnvelope, http, sleep } from "../../support/http.js";
import type { HttpResult } from "../../support/http.js";
import { aggregatedByAddressUrl, aggregatedByHashUrl } from "../../support/routes.js";

/** CRC-valid, deliberately undeployed: the route refuses it or reports it absent, and never enriches it. */
const NONEXISTENT_ADDRESS = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const NEVER_SEEN_HASH = "d".repeat(64);

const WINDOW_MS = deploymentParameters.windowQueryMs ?? 60_000;
const CONCURRENCY = Number(process.env.SCVS_E2E_PROBE_CONCURRENCY ?? 64);

/** Keep clear of a boundary even when the runner's and the deployment's clocks differ. */
const WINDOW_START_MARGIN_MS = 5_000;

const PROBE_TIMEOUT_MS = 2 * WINDOW_MS + 2 * env.requestTimeoutMs + 30_000;

interface Ceiling {
  readonly admitted: number;
  readonly limited: number;
  readonly limitedResponses: readonly HttpResult[];
  readonly serverErrors: number;
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

/** The counter's window is fixed to wall-clock boundaries, not to the first request. */
async function waitForFreshWindow(): Promise<void> {
  await sleep(WINDOW_MS - (Date.now() % WINDOW_MS) + WINDOW_START_MARGIN_MS);
}

async function probeCeiling(
  send: (index: number) => Promise<HttpResult>,
  attempts: number,
  route: string,
): Promise<Ceiling> {
  const startedAt = Date.now();
  const { results, transportFailures } = await sendBurst(send, attempts);
  const completedAt = Date.now();

  // A burst the client could not deliver is not an observation of the server's counter, and must not be
  // reported as one.
  if (transportFailures.length > 0) {
    throw new Error(
      `${route}: ${transportFailures.length}/${attempts} requests never reached the deployment ` +
        `(${[...new Set(transportFailures)].sort().join(", ")}). That is a client-side transport limit, ` +
        `not a quota observation: lower SCVS_E2E_PROBE_CONCURRENCY (currently ${CONCURRENCY}), raise ` +
        `SCVS_E2E_REQUEST_TIMEOUT_MS if the failures are read timeouts, or run this case from inside the ` +
        `deployment's region.`,
    );
  }

  const limitedResponses = results.filter((response) => response.status === 429);
  return {
    admitted: results.length - limitedResponses.length,
    limited: limitedResponses.length,
    limitedResponses,
    serverErrors: results.filter((response) => response.status >= 500 && response.status !== 503).length,
    attempts,
    startedAt,
    completedAt,
  };
}

function describeProbe(probe: Ceiling): string {
  return (
    `attempts=${probe.attempts} admitted=${probe.admitted} limited=${probe.limited} ` +
    `serverErrors=${probe.serverErrors} burst=${probe.completedAt - probe.startedAt}ms ` +
    `concurrency=${CONCURRENCY}`
  );
}

function expectOneWindow(probe: Ceiling, route: string): void {
  if (Math.floor(probe.startedAt / WINDOW_MS) === Math.floor((probe.completedAt - 1) / WINDOW_MS)) return;
  throw new Error(
    `${route} burst crossed a fixed ${WINDOW_MS} ms window (${probe.completedAt - probe.startedAt} ms). ` +
      "Requests were split across counters, so no conclusion about the enforced quota is possible. Raise " +
      `SCVS_E2E_PROBE_CONCURRENCY (currently ${CONCURRENCY}) so ${probe.attempts} requests fit one window.`,
  );
}

caseBlock(
  {
    id: "E2E-QRY-13/address_route_quota",
    title: "the address route refuses excess with 429, and does not shed it as 5xx",
    mode: "AUTO",
    needs: ["SCVS_E2E_QUERY_URL"],
    prerequisites: ["P1"],
    unless: () =>
      deploymentParameters.quotaQuery
        ? undefined
        : "📐 SCVS_E2E_QUOTA_QUERY is unset — the address route's ceiling is the deployment's own " +
          "(SCVS_QUERY_ADDRESS_THROTTLE_LIMIT), and this case reads it from the deployment rather than " +
          "inventing one",
  },
  () => {
    it(
      "reaches the ceiling and refuses the rest in the shared error envelope",
      async () => {
        const quota = deploymentParameters.quotaQuery!;
        // A fraction of the ceiling rather than a literal, so the probe scales with a retuned deployment.
        const attempts = quota + Math.max(20, Math.ceil(quota * 0.05));

        await waitForFreshWindow();
        const probe = await probeCeiling(
          () => http(aggregatedByAddressUrl(env.network, NONEXISTENT_ADDRESS)),
          attempts,
          "address",
        );
        expectOneWindow(probe, "address");

        if (probe.limited === 0) {
          throw new Error(
            `The address route refused none of ${probe.attempts} requests, though the deployment declares ` +
              `QUOTA_QUERY=${quota}. Every request arrived and the burst stayed inside one ${WINDOW_MS} ms ` +
              `window, so this is an observation of the service, not of the client.\n  · ${describeProbe(probe)}\n` +
              `  · This route is the only one that reaches an upstream RPC per request. If it is unbounded, ` +
              `check that SCVS_QUERY_ADDRESS_THROTTLE_LIMIT is set below SCVS_QUERY_THROTTLE_LIMIT — above ` +
              `it, the @Throttle override widens the budget instead of narrowing it (docs/invariants.md rule 34).`,
          );
        }

        // A quota that sheds load by falling over is not a quota. 503 is excluded above: it is this service's
        // honest "the aggregation index is still building", not a failure under load.
        expect(probe.serverErrors).toBe(0);

        // RC6's vocabulary, and the envelope every other refusal on this service uses.
        for (const response of probe.limitedResponses) {
          expect(expectErrorEnvelope(response).error).toBe("rate_limited");
        }
      },
      PROBE_TIMEOUT_MS,
    );
  },
);

caseBlock(
  {
    id: "E2E-QRY-13/by_hash_is_the_wider_tier",
    title: "reading by hash is budgeted more generously than resolving an address",
    mode: "AUTO",
    needs: ["SCVS_E2E_QUERY_URL"],
    prerequisites: ["P1"],
    unless: () =>
      deploymentParameters.quotaQuery
        ? undefined
        : "📐 SCVS_E2E_QUOTA_QUERY is unset — the relation is measured against the deployment's own " +
          "address-route ceiling, and this case does not get to invent one",
  },
  () => {
    // The first leg spends the address route's budget down to its ceiling.
    afterAll(async () => {
      if (deploymentParameters.quotaQuery) await sleep(WINDOW_MS);
    }, WINDOW_MS + 60_000);

    it(
      "admits strictly more by-hash reads than address reads, in the same units",
      async () => {
        const quota = deploymentParameters.quotaQuery!;
        const attempts = quota + Math.max(20, Math.ceil(quota * 0.05));

        await waitForFreshWindow();
        const address = await probeCeiling(
          () => http(aggregatedByAddressUrl(env.network, NONEXISTENT_ADDRESS)),
          attempts,
          "address",
        );
        expectOneWindow(address, "address");

        if (address.limited === 0) {
          throw new Error(
            `The address route admitted all ${address.attempts} requests without a 429, though the ` +
              `deployment declares QUOTA_QUERY=${quota}.\n  · ${describeProbe(address)}`,
          );
        }

        // Same count, same concurrency, same window: "more generously budgeted" is then a property of the
        // measurement rather than an assumption about it.
        await waitForFreshWindow();
        const byHash = await probeCeiling(
          () => http(aggregatedByHashUrl(NEVER_SEEN_HASH)),
          attempts,
          "by-hash",
        );
        expectOneWindow(byHash, "by-hash");
        expect(byHash.serverErrors).toBe(0);

        // The tiering this service's abuse control is built on: the route that costs an upstream call is the
        // one that runs out first. When by-hash refuses nothing, its admitted count is the whole burst and
        // this assertion still proves it is the looser route.
        expect(address.admitted).toBeLessThan(byHash.admitted);
      },
      PROBE_TIMEOUT_MS,
    );
  },
);
