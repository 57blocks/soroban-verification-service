import {
  createGuardedFetch,
  normalizePolicy,
  readBoundedBytes,
  type FetchPolicy,
  type FetchPolicyInput,
} from "./fetch-policy.js";

/** A `results_urls` entry in structured form; every field is peer-supplied and untrusted. */
export type ResultUrlEntry = {
  type: string;
  url: string;
  sha256?: string;
};

export type VerifiedResultUrl = {
  type: string;
  url: string;
  /** The origin the bytes actually came from. */
  origin: string;
  /** `true` only when a declared `sha256` matched the bytes. `false` only under `allowUnverified`. */
  verified: boolean;
  sha256?: string;
  bytes: Uint8Array;
};

export type VerifyResultUrlOptions = {
  fetch?: typeof fetch;
  policy?: FetchPolicyInput;
  /** Lowercase hex SHA-256. Defaults to WebCrypto; inject one where `crypto.subtle` is absent. */
  hasher?: (bytes: Uint8Array) => Promise<string>;
  /** Fetch an entry that declares no `sha256`. The result is `verified: false`. Off by default. */
  allowUnverified?: boolean;
};

export class UnverifiableEntryError extends Error {
  constructor(url: string) {
    super(
      `results_urls entry ${url} declares no sha256 and cannot be verified; ` +
        "pass allowUnverified to fetch it anyway",
    );
    this.name = "UnverifiableEntryError";
  }
}

/** The bytes did not hash to the declared value; they are discarded, not returned. */
export class HashMismatchError extends Error {
  constructor(url: string, expected: string, actual: string) {
    super(`results_urls entry ${url} hashed to ${actual}, expected ${expected}`);
    this.name = "HashMismatchError";
  }
}

export async function fetchAndVerifyResultUrl(
  entry: ResultUrlEntry,
  options: VerifyResultUrlOptions = {},
): Promise<VerifiedResultUrl> {
  // Type-checked, not `=== undefined`: a peer may send `null` or a number.
  const declared = typeof entry.sha256 === "string" ? entry.sha256.toLowerCase() : undefined;
  if (declared === undefined && options.allowUnverified !== true) {
    throw new UnverifiableEntryError(entry.url);
  }

  const policy: FetchPolicy = normalizePolicy(options.policy);
  const guarded = createGuardedFetch(policy, options.fetch ?? fetch);
  const response = await guarded(entry.url);
  if (!response.ok) {
    const error = new Error(`Unable to load ${entry.url}: ${response.status}`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }

  const bytes = await readBoundedBytes(response, policy.maxResponseBytes);

  if (declared !== undefined) {
    const hasher = options.hasher ?? webCryptoSha256;
    const actual = (await hasher(bytes)).toLowerCase();
    if (actual !== declared) {
      throw new HashMismatchError(entry.url, declared, actual);
    }
  }

  return {
    type: entry.type,
    url: entry.url,
    origin: new URL(response.url || entry.url).origin,
    verified: declared !== undefined,
    ...(declared !== undefined ? { sha256: declared } : {}),
    bytes,
  };
}

async function webCryptoSha256(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("No WebCrypto for SHA-256 (insecure context?) — pass options.hasher");
  }
  // `digest` honours a view's offset and length, so no copy is needed.
  const digest = await subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
