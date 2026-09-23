import type {
  AggregatedWasmStatus,
  AggregatedRegistryVerification,
  AgreementSummary,
  UnavailableVerifier,
} from "@scvs/core/aggregate";
import type { Network } from "@scvs/core/enums";
import type { ResultPointer } from "@scvs/core/result";
import {
  PeerTrustedVerifiersList,
  PeerVerifierManifest,
  TrustedVerifiersList,
  TRUSTED_VERIFIERS_LIST_SCHEMA,
  TRUSTED_VERIFIERS_LIST_SCHEMA_LEGACY,
  TRUSTED_VERIFIERS_LIST_SCHEMA_VERSION,
  VerifierManifest,
  manifestRootOf,
  resultRootOf,
  type PeerTrustedVerifier,
  type ResolvedVerifier,
  type TrustedVerifier,
} from "@scvs/storage-layout/shapes";

export { newClient, SchemaValidationError } from "./client.js";
export type { SoveClient, SoveClientOptions, VerifierDiscovery } from "./client.js";

// The hosted mode: the same questions asked of a Public Query API rather than of the result roots
// themselves (TRD §8.3). `AggregateReader` is what both modes answer.
export { newHostedClient, queryApiFailureOf, QueryApiError, QUERY_API_V1 } from "./hosted.js";
export type {
  AggregateReader,
  HostedClientOptions,
  HostedQueryClient,
  QueryApiFailure,
} from "./hosted.js";

// `newClient` applies a policy by default; these let a consumer inspect, tighten or reuse it.
export {
  checkUrl,
  createGuardedFetch,
  normalizePolicy,
  originsFromVerifiers,
  readBoundedBytes,
  FetchPolicyError,
  ResponseTooLargeError,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
} from "./fetch-policy.js";
export type { FetchPolicy, FetchPolicyInput } from "./fetch-policy.js";

// `results_urls` hash verification, and the destination a UI needs before navigating.
export {
  fetchAndVerifyResultUrl,
  UnverifiableEntryError,
  HashMismatchError,
} from "./result-urls.js";
export type { ResultUrlEntry, VerifiedResultUrl, VerifyResultUrlOptions } from "./result-urls.js";

// The Registry API read surface. The document shape comes from `packages/core`.
export {
  aggregateWasmStatus,
  readStatusObject,
  statusObjectUrl,
  validateStatusObject,
  RegistryDocumentError,
} from "./registry-read.js";
export type {
  AggregateWasmStatusInput,
  RegistryValidationMode,
  StatusObjectReadOptions,
} from "./registry-read.js";
// `RegistryStatusObject` is the producer shape and `PeerRegistryStatusObject` the consumer one.
export {
  RegistryStatusObject,
  PeerRegistryStatusObject,
  RegistryVerification,
  PeerRegistryVerification,
  RegistryVerifier,
  RegistryResultUrl,
  registryVerificationStatuses,
  registryStatusOrUnverified,
  baseProjection,
  isSameVerifier,
  toResultUrl,
  parseStrictRegistryStatusObject,
  REGISTRY_SCHEMA,
  REGISTRY_SCHEMA_MAJOR,
  REGISTRY_SCHEMA_VERSION,
  RECIPE_SOURCES,
  IMAGE_TRUST_LEVELS,
  RESULT_URL_TYPES,
} from "@scvs/core/registry";
export type { RegistryVerificationStatus, RecipeSource, ImageTrustLevel, ResultUrlType } from "@scvs/core/registry";

export {
  PeerTrustedVerifiersList,
  PeerVerifierManifest,
  TrustedVerifiersList,
  TRUSTED_VERIFIERS_LIST_SCHEMA,
  TRUSTED_VERIFIERS_LIST_SCHEMA_LEGACY,
  TRUSTED_VERIFIERS_LIST_SCHEMA_VERSION,
  VerifierManifest,
  manifestRootOf,
  resultRootOf,
};

// The consumer classes for an aggregate someone else assembled. `PeerAggregatedWasmStatus` is what
// `newHostedClient` validates with; `AggregatedWasmStatus` above is the shape we ourselves emit.
export {
  AGGREGATE_SCHEMA,
  AGGREGATE_SCHEMA_MAJOR,
  AGGREGATE_SCHEMA_VERSION,
  computeAgreement,
  displayStatusOf,
  PeerAggregatedWasmStatus,
  PeerUnavailableVerifier,
  agreementSummaries,
} from "@scvs/core/aggregate";

export type {
  Network,
  PeerTrustedVerifier,
  ResolvedVerifier,
  TrustedVerifier,
  ResultPointer,
  AggregatedWasmStatus,
  AggregatedRegistryVerification,
  AgreementSummary,
  UnavailableVerifier,
};

