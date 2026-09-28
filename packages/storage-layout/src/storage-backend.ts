import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
  createS3Client,
  getObjectBytes,
  getObjectText,
  getObjectTextVersioned,
  listObjectKeys,
  objectExists,
  putObjectBytes,
  putObjectText,
  putObjectTextConditional,
  type S3Client,
} from "@scvs/aws";

export type StorageVersion = string;

export type StorageWriteResult = "written" | "conflict";

export type ResultStorage = {
  kind: "filesystem" | "s3" | "r2";
  publicRoot: string;
  readText(path: string): Promise<string | undefined>;
  writeText(path: string, content: string, contentType: string): Promise<void>;
  readBytes(path: string): Promise<Uint8Array | undefined>;
  writeBytes(path: string, content: Uint8Array, contentType: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
  // Whether conditional writes hold across processes; `filesystem` serialises only within one process.
  readonly crossProcessAtomicWrites: boolean;
  readTextVersioned(path: string): Promise<{ text: string; version: StorageVersion } | undefined>;
  /** Writes only if the stored bytes are still at `expected`; `null` requires the object to be absent. */
  writeTextIfUnchanged(
    path: string,
    content: string,
    contentType: string,
    expected: StorageVersion | null,
  ): Promise<StorageWriteResult>;
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
  client?: S3Client;
};

export type ResultStorageConfig =
  | ({ kind: "filesystem" } & FilesystemResultStorageConfig)
  | ({ kind: "s3" | "r2" } & S3ResultStorageConfig);

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
  // Only real AWS S3 (no custom endpoint, no injected client) is known to honour conditional writes.
  const conditionalWritesVerified = config.kind === "s3" && !config.endpoint && !config.client;
  return new S3ResultStorage(
    config.kind,
    client,
    config.bucket,
    config.prefix || "",
    config.publicRoot,
    conditionalWritesVerified,
  );
}

class FilesystemResultStorage implements ResultStorage {
  readonly kind = "filesystem" as const;

  readonly crossProcessAtomicWrites = false;

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

  async readTextVersioned(path: string): Promise<{ text: string; version: StorageVersion } | undefined> {
    const text = await this.readText(path);
    if (text === undefined) return undefined;
    return { text, version: versionOf(text) };
  }

  async writeTextIfUnchanged(
    path: string,
    content: string,
    _contentType: string,
    expected: StorageVersion | null,
  ): Promise<StorageWriteResult> {
    const target = join(this.root, path);
    // The compare and the rename are await points apart, so writers to one path must be serialised.
    return withFilesystemWriteLock(resolve(target), async () => {
      const current = await this.readText(path);
      const actual = current === undefined ? null : versionOf(current);
      if (actual !== expected) return "conflict";
      await mkdir(dirname(target), { recursive: true });
      // Write-then-rename so a concurrent reader never observes a half-written document.
      const staging = `${target}.${randomUUID()}.tmp`;
      await writeFile(staging, content, "utf8");
      await rename(staging, target);
      return "written";
    });
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
    readonly crossProcessAtomicWrites: boolean,
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

  async readTextVersioned(path: string): Promise<{ text: string; version: StorageVersion } | undefined> {
    return getObjectTextVersioned(this.client, this.bucket, this.key(path));
  }

  async writeTextIfUnchanged(
    path: string,
    content: string,
    contentType: string,
    expected: StorageVersion | null,
  ): Promise<StorageWriteResult> {
    const result = await putObjectTextConditional(
      this.client,
      this.bucket,
      this.key(path),
      content,
      contentType,
      expected,
      cacheControlForPath(path),
    );
    return result === "written" ? "written" : "conflict";
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

/** Module scope, not per instance: callers construct several storages over one root. */
const filesystemWriteLocks = new Map<string, Promise<unknown>>();

function withFilesystemWriteLock<T>(target: string, fn: () => Promise<T>): Promise<T> {
  const previous = filesystemWriteLocks.get(target) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  // Swallowed so one failure does not poison the chain; each caller still sees its own rejection via `next`.
  const tail = next.catch(() => undefined);
  filesystemWriteLocks.set(target, tail);
  void tail.finally(() => {
    if (filesystemWriteLocks.get(target) === tail) filesystemWriteLocks.delete(target);
  });
  return next;
}

function versionOf(content: string): StorageVersion {
  return createHash("sha256").update(content).digest("hex");
}
