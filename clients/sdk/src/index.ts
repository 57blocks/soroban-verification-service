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

export { newHostedClient, queryApiFailureOf, QueryApiError, QUERY_API_V1 } from "./hosted.js";
export type {
  AggregateReader,
  HostedClientOptions,
  HostedQueryClient,
  QueryApiFailure,
} from "./hosted.js";

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

export {
  fetchAndVerifyResultUrl,
  UnverifiableEntryError,
  HashMismatchError,
} from "./result-urls.js";
export type { ResultUrlEntry, VerifiedResultUrl, VerifyResultUrlOptions } from "./result-urls.js";

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
  SEP58_HEX_SHA256,
  SOURCE_URI_PATTERN,
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

