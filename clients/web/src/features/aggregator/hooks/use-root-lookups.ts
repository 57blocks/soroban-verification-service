import { useQueries } from "@tanstack/react-query";
import {
  createGuardedFetch,
  readBoundedBytes,
  normalizePolicy,
  readStatusObject,
  FetchPolicyError,
  RegistryDocumentError,
  type PeerRegistryStatusObject,
} from "@scvs/sdk";
import { isWasmHash } from "./use-hash-lookup";
import type { AdditionalRoot } from "./use-additional-roots";

/** The policy these fetches run under. */
const policy = normalizePolicy({ allowedSchemes: ["https:", "http:"], blockPrivateRanges: false });

export type RootResult =
  | { root: AdditionalRoot; phase: "loading" }
  | { root: AdditionalRoot; phase: "absent" }
  | { root: AdditionalRoot; phase: "answered"; document: PeerRegistryStatusObject }
  | { root: AdditionalRoot; phase: "failed"; error: string };

class NotPublishedError extends Error {}

/** A root answered with a document about different bytes. Its own claim, not a transport problem. */
class WrongSubjectError extends Error {
  constructor(readonly answered: string) {
    super(`answered for ${answered}, which is not the hash that was asked about`);
  }
}

/** Each additional root asked directly, in parallel, for one hash. */
export const useRootLookups = (
  roots: readonly AdditionalRoot[],
  wasmHash: string | null,
  /** Bumped with the aggregate's, so one Refresh re-asks both sources rather than one. */
  attempt = 0,
): RootResult[] => {
  const hash = wasmHash?.trim().toLowerCase() ?? "";
  // The same gate the aggregate lookup applies, not merely "non-empty".
  const askable = isWasmHash(hash);

  const results = useQueries({
    queries: roots.map((root) => ({
      queryKey: ["additional-root", root.url, hash, attempt],
      enabled: askable,
      retry: false,
      queryFn: async () => {
        const guarded = createGuardedFetch(policy, fetch);
        const document = await readStatusObject(root.url, hash, async (url) => {
          const response = await guarded(url);
          // SO4 forbids an empty entry list, so a root says "nothing for this hash" with a 404.
          if (response.status !== 200) {
            await response.body?.cancel();
            if (response.status === 404) throw new NotPublishedError();
            throw new Error(`answered ${response.status}`);
          }
          // `policy.maxResponseBytes` is enforced here and nowhere else — `createGuardedFetch` checks the URL,
          // the redirect mode and the timeout, none of which bound a body.
          const bytes = await readBoundedBytes(response, policy.maxResponseBytes);
          return JSON.parse(new TextDecoder().decode(bytes));
        });

        // The check `aggregateWasmStatus` makes and this path would otherwise skip: a root does not get to
        // answer for a hash nobody asked about.
        if (document.wasm_hash.toLowerCase() !== hash) {
          throw new WrongSubjectError(document.wasm_hash);
        }
        return document;
      },
    })),
  });

  return results.map((query, index) => {
    const root = roots[index]!;
    if (query.isPending) return { root, phase: "loading" };
    if (query.isError) {
      return query.error instanceof NotPublishedError
        ? { root, phase: "absent" }
        : { root, phase: "failed", error: describe(query.error) };
    }
    return { root, phase: "answered", document: query.data };
  });
};

const describe = (error: unknown): string => {
  if (error instanceof FetchPolicyError) return `refused by the fetch policy: ${error.message}`;
  if (error instanceof WrongSubjectError) return error.message;
  if (error instanceof RegistryDocumentError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
};
