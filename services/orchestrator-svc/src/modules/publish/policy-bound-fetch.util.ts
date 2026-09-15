// Lives in @scvs/core now, so query-svc's pinned fetch (packages/core/src/pinned-fetch.ts) can reuse the same
// DNS-rebinding defense instead of re-implementing it. This file is a re-export so this module's existing
// importers (fetch-source-bytes.util.ts, source-resolution.service.ts, this directory's own spec) keep the
// paths they had.
export * from "@scvs/core/policy-bound-fetch";
