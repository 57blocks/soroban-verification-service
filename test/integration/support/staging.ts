/** Whether a private upload's staging object exists — the one observation `E2E-SRC-03` cannot make over HTTP. */
import { env, stagingObserver } from "./env.js";
import { http } from "./http.js";

/** `staging/uploads/<upload_id>/<filename>`. */
export function stagingKeyFor(uploadId: string, filename: string): string {
  return `staging/uploads/${uploadId}/${filename}`;
}

export type StagingObservation =
  | { readonly state: "exists"; readonly bytes?: number }
  | { readonly state: "absent" }
  /** The observer could not answer. Never conflated with `absent` — see `expectObservable`. */
  | { readonly state: "unavailable"; readonly detail: string };

/** The slice of `@aws-sdk/client-s3` this file uses, declared structurally. */
interface S3Like {
  S3Client: new (config: { region: string }) => {
    send(command: unknown): Promise<{ ContentLength?: number }>;
    destroy(): void;
  };
  HeadObjectCommand: new (input: { Bucket: string; Key: string }) => unknown;
}

/** Loaded on first use so the package stays installable, and runnable, without the AWS SDK. */
let s3Module: Promise<S3Like> | undefined;

async function loadS3(): Promise<S3Like | undefined> {
  // A missing module is `unavailable` with an actionable message, not a crash at import time that would take
  // the whole suite down for runs that never touch S3.
  const specifier = "@aws-sdk/client-s3";
  s3Module ??= import(specifier) as Promise<S3Like>;
  try {
    return await s3Module;
  } catch {
    return undefined;
  }
}

async function headViaS3(
  bucket: string,
  region: string,
  key: string
): Promise<StagingObservation> {
  const sdk = await loadS3();
  if (!sdk) {
    return {
      state: "unavailable",
      detail:
        "@aws-sdk/client-s3 is not installed in test/integration. Install it, or use " +
        "SCVS_E2E_STAGING_PROBE_URL instead — it needs no SDK and no bucket credentials.",
    };
  }

  const client = new sdk.S3Client({ region });
  try {
    const head = await client.send(new sdk.HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { state: "exists", bytes: head.ContentLength ?? undefined };
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404) return { state: "absent" };
    // 403 is the one that must not read as `absent`.
    return {
      state: "unavailable",
      detail: `HeadObject on s3://${bucket}/${key} answered ${status ?? "no status"}: ${
        (error as Error).message
      }`,
    };
  } finally {
    client.destroy();
  }
}

async function headViaProbe(probeUrl: string, key: string): Promise<StagingObservation> {
  // One exact key per request, in the query string, and nothing else.
  const url = `${probeUrl}?key=${encodeURIComponent(key)}`;
  const response = await http(url);

  if (response.status === 404) return { state: "absent" };
  if (response.status !== 200) {
    return {
      state: "unavailable",
      detail: `staging probe ${url} answered ${response.status}: ${response.text.slice(0, 200)}`,
    };
  }

  const body = response.json as { exists?: unknown; size?: unknown } | undefined;
  if (typeof body?.exists !== "boolean") {
    return {
      state: "unavailable",
      detail:
        `staging probe ${url} answered 200 without a boolean \`exists\` field. The contract is ` +
        `{"exists": boolean, "size"?: number}; anything else cannot be told from a proxy error page.`,
    };
  }
  if (!body.exists) return { state: "absent" };
  return { state: "exists", bytes: typeof body.size === "number" ? body.size : undefined };
}

/** One observation of one exact key. */
export async function observeStagedUpload(
  uploadId: string,
  filename: string
): Promise<StagingObservation & { readonly key: string }> {
  const key = stagingKeyFor(uploadId, filename);

  switch (stagingObserver.kind) {
    case "probe":
      return { ...(await headViaProbe(stagingObserver.probeUrl, key)), key };
    case "s3":
      return { ...(await headViaS3(stagingObserver.bucket, stagingObserver.region, key)), key };
    case "absent":
      return { state: "unavailable", detail: stagingObserver.describe, key };
  }
}

/** Fails the case when the observer could not answer. */
export function expectObservable(
  observation: StagingObservation & { key: string },
  step: string
): void {
  if (observation.state === "unavailable") {
    throw new Error(
      `[SRC-03] the staging observer could not answer for ${observation.key} at ${step}: ` +
        `${observation.detail}. An unanswerable observation must not be read as "the object is gone".`
    );
  }
}

/** Polls one key until it is absent, or until `deadlineMs` has passed since `since`. */
export async function waitForStagedUploadAbsence(
  uploadId: string,
  filename: string,
  options: { deadlineMs: number; since: number; intervalMs?: number }
): Promise<{ absent: boolean; latencyMs: number; last: StagingObservation & { key: string } }> {
  const intervalMs = options.intervalMs ?? Math.min(env.pollIntervalMs, 2_000);
  const deadline = options.since + options.deadlineMs;
  let last = await observeStagedUpload(uploadId, filename);

  while (Date.now() < deadline) {
    expectObservable(last, "deletion poll");
    if (last.state === "absent") {
      return { absent: true, latencyMs: Date.now() - options.since, last };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    last = await observeStagedUpload(uploadId, filename);
  }

  expectObservable(last, "deletion deadline");
  return {
    absent: last.state === "absent",
    latencyMs: Date.now() - options.since,
    last,
  };
}
