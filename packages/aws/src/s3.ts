import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

// Re-exported so downstream packages (e.g. @scvs/storage-layout's S3-backed ResultStorage) can reference the
// client type without adding their own @aws-sdk/client-s3 dependency.
export type { S3Client };

export type S3ClientConfig = {
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
};

/** Plain S3 client factory. */
export function createS3Client(config: S3ClientConfig = {}): S3Client {
  const hasStaticCredentials = Boolean(config.accessKeyId && config.secretAccessKey);
  return new S3Client({
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    region: config.region || "us-east-1",
    ...(config.forcePathStyle !== undefined ? { forcePathStyle: config.forcePathStyle } : {}),
    ...(hasStaticCredentials
      ? {
          credentials: {
            accessKeyId: config.accessKeyId as string,
            secretAccessKey: config.secretAccessKey as string,
          },
        }
      : {}),
  });
}

/** Reads an object as UTF-8 text; resolves `undefined` (rather than throwing) when the key is missing. */
export async function getObjectText(client: S3Client, bucket: string, key: string): Promise<string | undefined> {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return await response.Body?.transformToString();
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/** Reads an object as UTF-8 text, **refusing to buffer more than `maxBytes`**. */
export async function getObjectTextBounded(
  client: S3Client,
  bucket: string,
  key: string,
  maxBytes: number,
): Promise<{ text: string } | { tooLarge: number } | undefined> {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const declared = response.ContentLength;
    if (declared !== undefined && declared > maxBytes) {
      return { tooLarge: declared };
    }
    const text = await response.Body?.transformToString();
    if (text === undefined) return undefined;
    // `ContentLength` is the authority above, but an object stored without one still must not be allowed
    // through unbounded — checked again on what was actually read.
    if (Buffer.byteLength(text) > maxBytes) return { tooLarge: Buffer.byteLength(text) };
    return { text };
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/** Reads an object as raw bytes — the binary sibling of `getObjectText`, for archive/tarball downloads. */
export async function getObjectBytes(client: S3Client, bucket: string, key: string): Promise<Uint8Array | undefined> {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return await response.Body?.transformToByteArray();
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/** Reads an object as raw bytes, **refusing to buffer more than `maxBytes`**. */
export async function getObjectBytesBounded(
  client: S3Client,
  bucket: string,
  key: string,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; size: number } | { tooLarge: number } | undefined> {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const declared = response.ContentLength;
    if (declared !== undefined && declared > maxBytes) {
      return { tooLarge: declared };
    }
    const bytes = await response.Body?.transformToByteArray();
    if (!bytes) return undefined;
    // A missing/lying `ContentLength` must not defeat the bound, so check the real length too.
    if (bytes.byteLength > maxBytes) return { tooLarge: bytes.byteLength };
    return { bytes, size: bytes.byteLength };
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/**
 * Checks whether an object exists via HeadObject — no bytes transferred, for existence checks that would
 * otherwise pay a full GetObject just to test presence.
 */
export async function objectExists(client: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/** Writes UTF-8 text to an object, optionally setting Content-Type / Cache-Control. */
export async function putObjectText(
  client: S3Client,
  bucket: string,
  key: string,
  content: string,
  contentType: string,
  cacheControl?: string,
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: content,
      ContentType: contentType,
      ...(cacheControl ? { CacheControl: cacheControl } : {}),
    }),
  );
}

/** Writes raw bytes to an object — the binary sibling of `putObjectText`, for archive/tarball uploads. */
export async function putObjectBytes(
  client: S3Client,
  bucket: string,
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

/** Deletes a single object; resolves silently if the key is already gone. */
export async function deleteObject(client: S3Client, bucket: string, key: string): Promise<void> {
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

/** Lists every object key under `prefix`, paginating via ContinuationToken. */
export async function listObjectKeys(client: S3Client, bucket: string, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let ContinuationToken: string | undefined;
  do {
    const response = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken }),
    );
    for (const item of response.Contents || []) {
      if (item.Key) keys.push(item.Key);
    }
    ContinuationToken = response.NextContinuationToken;
  } while (ContinuationToken);
  return keys;
}

/** Matches the SDK's "not found" shapes: `NoSuchKey`/`NotFound` error names or an HTTP 404. */
export function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { name?: unknown; $metadata?: { httpStatusCode?: number } };
  return value.name === "NoSuchKey" || value.name === "NotFound" || value.$metadata?.httpStatusCode === 404;
}

/** A conditional write's outcome that is not success: `fatal` is thrown, the other two are retried. */
export type ConditionalWriteFailure = "conflict" | "vanished" | "fatal";

const CONFLICT_ERROR_NAMES = new Set(["PreconditionFailed", "ConditionalRequestConflict"]);
// `NoSuchKey` alone. `NotFound` is HeadObject's shape — a HEAD carries no body to name the code — so it is
// not this case; `isNotFound` still accepts it for `objectExists`, which is a HEAD.
const MISSING_ERROR_NAMES = new Set(["NoSuchKey"]);
// A bucket or credential failure can surface as 404 exactly like a missing key, so the NAME decides and the
// status code is only the fallback for a response carrying none.
const FATAL_ERROR_NAMES = new Set([
  "NoSuchBucket",
  "AccessDenied",
  "InvalidAccessKeyId",
  "SignatureDoesNotMatch",
  "AllAccessDisabled",
]);

/** Whether a failed conditional write may be replayed against a freshly read version, or must propagate. */
export function classifyConditionalWriteError(
  error: unknown,
  mode: "if-match" | "if-none-match",
): ConditionalWriteFailure {
  if (!error || typeof error !== "object") return "fatal";
  const value = error as { name?: unknown; $metadata?: { httpStatusCode?: number } };
  const name = typeof value.name === "string" ? value.name : undefined;
  if (name) {
    if (FATAL_ERROR_NAMES.has(name)) return "fatal";
    if (CONFLICT_ERROR_NAMES.has(name)) return "conflict";
    // Only If-Match can race a delete; If-None-Match treats an absent object as its success condition, so a
    // "missing" error from it is something else.
    if (MISSING_ERROR_NAMES.has(name)) return mode === "if-match" ? "vanished" : "fatal";
    return "fatal";
  }
  switch (value.$metadata?.httpStatusCode) {
    case 412:
    case 409:
      return "conflict";
    case 404:
      return mode === "if-match" ? "vanished" : "fatal";
    default:
      return "fatal";
  }
}

/** An opaque token identifying the exact stored bytes a later conditional write may be pinned to. */
export type ObjectVersion = string;

/** `conflict` and `vanished` both mean "re-read, recompute, retry"; they differ only for logging. */
export type ConditionalWriteResult = "written" | "conflict" | "vanished";

/**
 * Reads an object with the version token `putObjectTextConditional` pins against. The token comes from the
 * raw response, never from the parsed body: bytes that will not parse still have a version, and treating
 * them as an absent object is what lets a create-if-absent write replace a document that is really there.
 */
export async function getObjectTextVersioned(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<{ text: string; version: ObjectVersion } | undefined> {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const text = await response.Body?.transformToString();
    if (text === undefined) return undefined;
    if (!response.ETag) {
      throw new Error(`getObjectTextVersioned: ${bucket}/${key} returned no ETag — cannot pin a conditional write`);
    }
    return { text, version: response.ETag };
  } catch (error) {
    if (isMissingKey(error)) return undefined;
    throw error;
  }
}

/** A genuinely absent key, unlike `isNotFound`'s "any 404" — which a missing bucket also answers with. */
function isMissingKey(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { name?: unknown; $metadata?: { httpStatusCode?: number } };
  const name = typeof value.name === "string" ? value.name : undefined;
  // Only a response carrying no name at all falls back to the status code.
  if (name) return MISSING_ERROR_NAMES.has(name);
  return value.$metadata?.httpStatusCode === 404;
}

/**
 * Writes only if the stored object is still at `expected`; `null` requires that it not exist at all. The two
 * replayable outcomes come back as values, anything else propagates.
 */
export async function putObjectTextConditional(
  client: S3Client,
  bucket: string,
  key: string,
  content: string,
  contentType: string,
  expected: ObjectVersion | null,
  cacheControl?: string,
): Promise<ConditionalWriteResult> {
  const mode = expected === null ? "if-none-match" : "if-match";
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: content,
        ContentType: contentType,
        ...(cacheControl ? { CacheControl: cacheControl } : {}),
        ...(expected === null ? { IfNoneMatch: "*" } : { IfMatch: expected }),
      }),
    );
    return "written";
  } catch (error) {
    const failure = classifyConditionalWriteError(error, mode);
    if (failure === "fatal") throw error;
    return failure;
  }
}
