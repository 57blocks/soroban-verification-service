import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
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

/**
 * Storage-backend abstraction used by publish.ts/read.ts — same shape as the old
 * `apps/api/src/publisher-storage.ts` `PublisherStorage` type.
 */
/** An opaque token identifying the exact stored bytes a conditional write may be pinned to. */
export type StorageVersion = string;

/** `conflict` means someone else wrote since the version was read — re-read, recompute, retry. */
export type StorageWriteResult = "written" | "conflict";

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
  /**
   * Whether this backend's conditional writes hold ACROSS processes. `filesystem` serialises writers within
   * one process but cannot reach past it, so it reports false — a limit callers must be able to test, not
   * only read in a document.
   */
  readonly crossProcessAtomicWrites: boolean;
  /**
   * Reads text with the version token `writeTextIfUnchanged` pins against. The token identifies the stored
   * bytes themselves, so a document that will not parse still has one and cannot be mistaken for an absent
   * object.
   */
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

  // The compare in `writeTextIfUnchanged` and the rename under it are not one atomic step, so a second
  // process can land between them. Within one process the caller's own lock closes that window; across
  // processes nothing here can — POSIX has no compare-and-swap-replace, and a lock file's staleness cannot
  // distinguish a dead holder from a slow one.
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
    // The compare and the rename below are several await points apart. Without this, two writers pinned to
    // the same version both pass the compare and the loser's bytes replace the winner's — the very lost
    // update a conditional write exists to prevent.
    return withFilesystemWriteLock(target, async () => {
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
  readonly crossProcessAtomicWrites = true;

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
    // A vanished object carries the same instruction for the caller as a conflict: re-read and recompute.
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

/**
 * Serialises every conditional write this process makes to ONE absolute path. Keyed by the resolved target
 * rather than held per instance: `buildResultStorage` hands out a fresh `ResultStorage` on several
 * orchestrator paths, and two of them over the same root would otherwise race each other.
 */
const filesystemWriteLocks = new Map<string, Promise<unknown>>();

function withFilesystemWriteLock<T>(target: string, fn: () => Promise<T>): Promise<T> {
  const previous = filesystemWriteLocks.get(target) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  // Swallow so a failed attempt does not poison the chain for the next caller on this path — each caller
  // still observes its own rejection via the returned `next`.
  const tail = next.catch(() => undefined);
  filesystemWriteLocks.set(target, tail);
  // Evict once settled, but only if nobody chained onto this path in the meantime.
  void tail.finally(() => {
    if (filesystemWriteLocks.get(target) === tail) filesystemWriteLocks.delete(target);
  });
  return next;
}

/** The filesystem backend's version token: derived from the content, so it cannot drift from the bytes. */
function versionOf(content: string): StorageVersion {
  return createHash("sha256").update(content).digest("hex");
}
