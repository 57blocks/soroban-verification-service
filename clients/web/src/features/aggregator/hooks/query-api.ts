import { newHostedClient, type HostedQueryClient, type QueryApiFailure } from "@scvs/sdk";
import { getQueryApiBase } from "@/lib/http";

/**
 * The query API, read through the SDK's hosted mode — the same door an integrator uses, so a defect in it
 * surfaces on our own page rather than in someone's bug report.
 */
let client: HostedQueryClient | undefined;

/**
 * Built on first use, not at module load: `newHostedClient` throws on a base it cannot resolve, and a throw
 * during module evaluation would blank the whole console rather than one panel.
 */
export const queryApi = (): HostedQueryClient =>
  (client ??= newHostedClient({ baseUrl: getQueryApiBase() }));

/**
 * Reader copy for the codes the SDK reports about itself. A code query-svc declared keeps the service's own
 * sentence — see the per-route copy in `use-contract-lookup`.
 */
export const transportFailureCopy = (failure: QueryApiFailure): string => {
  switch (failure.code) {
    case "unreachable":
      return `The query API could not be reached: ${failure.message}`;
    case "timeout":
      return `The query API did not answer in time: ${failure.message}`;
    case "refused":
      return `The request was refused before it was sent: ${failure.message}`;
    case "response_too_large":
      return `The query API answered with more data than this page will read: ${failure.message}`;
    case "invalid_response":
      // The console and query-svc share one origin, and nginx answers `try_files … /index.html` with 200
      // text/html for any path the load balancer did not route here — so a 200 can be this page.
      return (
        "The query API answered something that is not the expected shape — the request may have been " +
        `served by the console rather than routed to query-svc. ${failure.message}`
      );
    default:
      return failure.message;
  }
};
