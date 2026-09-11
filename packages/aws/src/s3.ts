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
