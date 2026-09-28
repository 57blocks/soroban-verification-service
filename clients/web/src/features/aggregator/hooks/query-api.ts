import { newHostedClient, type HostedQueryClient, type QueryApiFailure } from "soroban-verification-client";
import { getQueryApiBase } from "@/lib/http";

let client: HostedQueryClient | undefined;

/** Built on first use: `newHostedClient` throws on a bad base, and a module-load throw blanks the console. */
export const queryApi = (): HostedQueryClient =>
  (client ??= newHostedClient({ baseUrl: getQueryApiBase() }));

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
      return (
        "The query API answered something that is not the expected shape — the request may have been " +
        `served by the console rather than routed to query-svc. ${failure.message}`
      );
    default:
      return failure.message;
  }
};
