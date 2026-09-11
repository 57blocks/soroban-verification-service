import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createS3Client,
  getObjectBytes,
  getObjectText,
  listObjectKeys,
  objectExists,
  putObjectBytes,
  putObjectText,
  type S3Client,
} from "@scvs/aws";

/**
 * Storage-backend abstraction used by publish.ts/read.ts — same shape as the old
 * `apps/api/src/publisher-storage.ts` `PublisherStorage` type.
 */
export type ResultStorage = {
  kind: "filesystem" | "s3" | "r2" | "gcs";
  publicRoot: string;
  readText(path: string): Promise<string | undefined>;
  writeText(path: string, content: string, contentType: string): Promise<void>;
  // Binary sibling of readText/writeText — for content that isn't UTF-8 text (e.g. the source tarball this
  // package's publishSource writes).
  readBytes(path: string): Promise<Uint8Array | undefined>;
  writeBytes(path: string, content: Uint8Array, contentType: string): Promise<void>;
  // Existence check with no content transfer — for a caller that only needs to know "is this already
  // published", not read it.
  exists(path: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
};

export type FilesystemResultStorageConfig = {
  root: string;
  publicRoot: string;
};

export type S3ResultStorageConfig = {
  bucket: string;
  publicRoot: string;
  prefix?: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  /** Reuse an already-constructed client instead of building one from the fields above. */
  client?: S3Client;
};

export type ResultStorageConfig =
  | ({ kind: "filesystem" } & FilesystemResultStorageConfig)
  | ({ kind: "s3" | "r2" } & S3ResultStorageConfig);

/** Builds the local-disk or S3-backed `ResultStorage` implementation for the given config. */
export function createResultStorage(config: ResultStorageConfig): ResultStorage {
  if (config.kind === "filesystem") {
    return new FilesystemResultStorage(config.root, config.publicRoot);
  }
  const client = config.client ?? createS3Client({
    endpoint: config.endpoint,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    forcePathStyle: config.forcePathStyle,
  });
  return new S3ResultStorage(config.kind, client, config.bucket, config.prefix || "", config.publicRoot);
}

class FilesystemResultStorage implements ResultStorage {
  readonly kind = "filesystem" as const;

  constructor(
    private readonly root: string,
    readonly publicRoot: string,
  ) {}

  async readText(path: string): Promise<string | undefined> {
    try {
      return await readFile(join(this.root, path), "utf8");
    } catch {
      return undefined;
    }
  }

  async writeText(path: string, content: string, _contentType: string): Promise<void> {
    const target = join(this.root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }

  async readBytes(path: string): Promise<Uint8Array | undefined> {
    try {
      return await readFile(join(this.root, path));
    } catch {
      return undefined;
    }
  }

  async writeBytes(path: string, content: Uint8Array, _contentType: string): Promise<void> {
    const target = join(this.root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(join(this.root, path));
      return true;
    } catch {
      return false;
    }
  }

  async list(prefix: string): Promise<string[]> {
    try {
      return (await readdir(join(this.root, prefix))).map((name) => `${prefix.replace(/\/+$/, "")}/${name}`);
    } catch {
      return [];
    }
  }
}

class S3ResultStorage implements ResultStorage {
  constructor(
    readonly kind: "s3" | "r2",
    private readonly client: S3Client,
    private readonly bucket: string,
    private readonly prefix: string,
    readonly publicRoot: string,
  ) {}

  async readText(path: string): Promise<string | undefined> {
    return getObjectText(this.client, this.bucket, this.key(path));
  }

  async writeText(path: string, content: string, contentType: string): Promise<void> {
    await putObjectText(this.client, this.bucket, this.key(path), content, contentType, cacheControlForPath(path));
  }

  async readBytes(path: string): Promise<Uint8Array | undefined> {
    return getObjectBytes(this.client, this.bucket, this.key(path));
  }

  async writeBytes(path: string, content: Uint8Array, contentType: string): Promise<void> {
    await putObjectBytes(this.client, this.bucket, this.key(path), content, contentType);
  }

  async exists(path: string): Promise<boolean> {
    return objectExists(this.client, this.bucket, this.key(path));
  }

  async list(prefix: string): Promise<string[]> {
    const normalizedPrefix = normalizePrefix(this.key(prefix));
    const keys = await listObjectKeys(this.client, this.bucket, normalizedPrefix);
    return keys.map((key) => this.unkey(key));
  }

  private key(path: string): string {
    return [this.prefix, path].map((part) => part.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
  }

  private unkey(key: string): string {
    if (!this.prefix) return key;
    const prefix = `${this.prefix.replace(/^\/+|\/+$/g, "")}/`;
    return key.startsWith(prefix) ? key.slice(prefix.length) : key;
  }
}

function normalizePrefix(value: string): string {
  return value.replace(/^\/+/, "").replace(/\/?$/, "/");
}

function cacheControlForPath(path: string): string {
  if (path.startsWith("reports/")) return "public, max-age=31536000, immutable";
  return "public, max-age=60";
}
