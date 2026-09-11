import { sourceArchiveAccept } from "../constants";

/** The suffixes out of the picker's accept list; the MIME entries beside them are advisory to it. */
const acceptedSuffixes = sourceArchiveAccept
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.startsWith("."));

/** Derived from the accept list rather than restated, so the picker's filter and this refusal cannot disagree. */
export const isAcceptedSourceArchiveName = (name: string): boolean =>
  acceptedSuffixes.some((suffix) => name.toLowerCase().endsWith(suffix));

/** What to submit instead, for the refusal toast. */
export const acceptedSourceArchiveSuffixes = acceptedSuffixes;

/** The code verification-svc answers with when the submitted archive is not the one the deployed Wasm records. */
export const sourceArchiveNotChainRecorded = "source_archive_not_chain_recorded";

/** Why a picked archive cannot be the chain's. */
export const chainSourceMismatchMessage = (chain: string, computed: string): string =>
  `The source archive you selected hashes to ${computed.toLowerCase()}, but this contract records ` +
  `source_sha256=${chain.toLowerCase()} on chain.`;

/** Returns the refusal, or `null` when there is nothing to refuse. */
export const chainSourceRefusal = (
  chainSourceSha256: string | undefined,
  computedSha256: string | undefined,
): string | null => {
  if (!chainSourceSha256 || !computedSha256) return null;
  if (chainSourceSha256.toLowerCase() === computedSha256.toLowerCase()) return null;
  return chainSourceMismatchMessage(chainSourceSha256, computedSha256);
};
