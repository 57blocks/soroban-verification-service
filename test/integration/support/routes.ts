import { env } from "./env.js";

function verify(path: string): string {
  if (!env.verifyUrl) throw new Error("SCVS_E2E_VERIFY_URL is not set");
  return `${env.verifyUrl}${path}`;
}

function queryUrl(path: string): string {
  if (!env.queryUrl) throw new Error("SCVS_E2E_QUERY_URL is not set");
  return `${env.queryUrl}${path}`;
}

function statics(key: string): string {
  if (!env.resultRoot) throw new Error("SCVS_E2E_RESULT_ROOT is not set");
  return `${env.resultRoot}/${key.replace(/^\/+/, "")}`;
}

export const preflightUrl = () => verify("/api/verification/v1/preflight");

export const submitUrl = () => verify("/api/verification/v1/verifications");

export const jobUrl = (jobId: string) => verify(`/api/verification/v1/verifications/${jobId}`);

export const jobLogUrl = (jobId: string) => verify(`/api/verification/v1/verifications/${jobId}/log`);

export const jobEventsUrl = (jobId: string) => verify(`/api/verification/v1/verifications/${jobId}/events`);

export const uploadSourceUrl = () => verify("/api/verification/v1/uploads/source");

export const aggregatedByHashUrl = (wasmHash: string) =>
  queryUrl(`/api/query/v1/wasms/${wasmHash.toLowerCase()}`);

export const deprecatedAggregatedByHashUrl = (wasmHash: string) =>
  queryUrl(`/api/query/v1/wasms/${wasmHash.toLowerCase()}.json`);

export const aggregatedByAddressUrl = (network: string, contractId: string) =>
  queryUrl(`/api/query/v1/contracts/${network}/${contractId}`);

export const aggregatedBulkLoadUrl = (params?: {
  order?: string;
  limit?: number | string;
  cursor?: string;
}) => queryUrl(`/api/query/v1/wasms${searchSuffix(params)}`);

export const deprecatedAggregatedBulkLoadUrl = () => queryUrl("/api/query/v1/wasms.json");

export const ownBulkLoadUrl = (params?: { order?: string; limit?: number | string; cursor?: string }) =>
  verify(`/api/verification/v1/wasms${searchSuffix(params)}`);

export const deprecatedOwnBulkLoadUrl = () => verify("/api/verification/v1/wasms.json");

export const verifyWasmStatusUrl = (wasmHash: string) =>
  verify(`/api/verification/v1/wasms/${wasmHash}.json`);

export const verifiersUrl = () => queryUrl("/api/query/v1/verifiers");

export const staticSourceUrl = (sourceFileName: string) => statics(`sources/${sourceFileName}`);

export const staticWasmStatusUrl = (wasmHash: string) => statics(`wasms/${wasmHash.toLowerCase()}.json`);

export const staticReportUrl = (reportSha256: string) => statics(`reports/${reportSha256}.json`);

export const staticPolicyUrl = () => statics("policy.json");

export const staticVerifierManifestUrl = () => statics("verifier-manifest.json");

export const verifyHealthUrl = () => verify("/api/verification/v1/health");

export const verifyV1HealthUrl = () => verify("/api/verification/v1/health");

export const queryHealthUrl = () => queryUrl("/api/query/v1/health");
export const verifyReadyUrl = () => verify("/health/ready");

export const adminProbeUrls = () => [
  verify("/api/verification/v1/admin/build-images"),
  verify("/api/verification/v1/admin/policy"),
  verify("/api/verification/v1/admin/verifiers"),
];

export const adminHostRootProbeUrls = () => [
  verify("/admin/build-images"),
  verify("/admin/policy"),
  verify("/admin/verifiers"),
];

export const hostRootControlUrl = () => verify(`/scvs-e2e-control-${env.runId}`);

function searchSuffix(params?: Record<string, string | number | undefined>): string {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : "";
}
