/** The one place where "the route the case names" and "the route the deployment serves" may differ. */
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

/** Served at `/api/verification/v1/verifications/{job_id}`. */
export const jobUrl = (jobId: string) => verify(`/api/verification/v1/verifications/${jobId}`);

/** Returns `text/plain`, not JSON. */
export const jobLogUrl = (jobId: string) => verify(`/api/verification/v1/verifications/${jobId}/log`);

export const jobEventsUrl = (jobId: string) => verify(`/api/verification/v1/verifications/${jobId}/events`);

/** Body is raw archive bytes, not multipart. */
export const uploadSourceUrl = () => verify("/api/verification/v1/uploads/source");

/**
 * Cases that mean *the static document* must use `staticWasmStatusUrl` instead — the dynamic route and the
 * published file are not interchangeable.
 */
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

/**
 * Distinct from `aggregatedByHashUrl` above, which is query-svc's aggregated form of the same path name, and
 * from `staticWasmStatusUrl`, which is the published file.
 */
export const verifyWasmStatusUrl = (wasmHash: string) =>
  verify(`/api/verification/v1/wasms/${wasmHash}.json`);

export const verifiersUrl = () => queryUrl("/api/query/v1/verifiers");

/**
 * Retained public source is reachable only as a static object at `sources/{source_sha256}{extension}` under the
 * published result root.
 */
export const staticSourceUrl = (sourceFileName: string) => statics(`sources/${sourceFileName}`);

/** `wasms/{wasm_hash}.json` — `packages/storage-layout/src/keys.ts` `wasmStatusKey`. */
export const staticWasmStatusUrl = (wasmHash: string) => statics(`wasms/${wasmHash.toLowerCase()}.json`);

/** `reports/{report_sha256}.json` — `reportKey`. Immutable; `Cache-Control: …immutable` on write. */
export const staticReportUrl = (reportSha256: string) => statics(`reports/${reportSha256}.json`);

/** `policy.json` at the result root — `verifierPolicyKey`. */
export const staticPolicyUrl = () => statics("policy.json");

/** `verifier-manifest.json` at the result root — `verifierManifestKey`. */
export const staticVerifierManifestUrl = () => statics("verifier-manifest.json");

/** ── health, and the surface that must not exist ────────────────────────────────────────────── */

export const verifyHealthUrl = () => verify("/api/verification/v1/health");

export const verifyV1HealthUrl = () => verify("/api/verification/v1/health");

export const queryHealthUrl = () => queryUrl("/api/query/v1/health");
/** The readiness route is deployment-pinned and has no routed twin — it stays on the bare path. */
export const verifyReadyUrl = () => verify("/health/ready");

/** `E2E-SEC-14/no_management_surface` asserts these 404. */
export const adminProbeUrls = () => [
  verify("/api/verification/v1/admin/build-images"),
  verify("/api/verification/v1/admin/policy"),
  verify("/api/verification/v1/admin/verifiers"),
];

/** The same three paths at the **host root**, where no rule routes them and `web` answers. */
export const adminHostRootProbeUrls = () => [
  verify("/admin/build-images"),
  verify("/admin/policy"),
  verify("/admin/verifiers"),
];

/** A path nothing could plausibly serve, run-scoped so no cached answer for it can predate the run. */
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
