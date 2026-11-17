/**
 * The `upload_secret` each upload this run made returned. A submission naming an `upload_id` must send its
 * upload's secret beside the manifest, never inside it, so the harness keeps them here rather than threading
 * them through every fixture that turns an upload into a manifest.
 */
const secrets = new Map<string, string>();

export function rememberUploadSecret(uploadId: string, uploadSecret: string): void {
  secrets.set(uploadId, uploadSecret);
}

/** The body with the `upload_secret` of the upload its manifest names, unless it already carries one. */
export function withUploadSecret<T extends { manifest?: { upload_id?: string }; upload_secret?: string }>(body: T): T {
  const uploadId = body.manifest?.upload_id;
  if (!uploadId || body.upload_secret !== undefined) return body;
  const uploadSecret = secrets.get(uploadId);
  return uploadSecret === undefined ? body : { ...body, upload_secret: uploadSecret };
}
