import type { BuildArtifact } from "@scvs/core";

/** services/builder never holds standing AWS credentials. */

export type UploadResult =
  | { ok: true; status: number }
  | { ok: false; status?: number; detail: string };

export async function uploadArtifact(
  uploadUrl: string,
  body: Uint8Array | Buffer | string,
  contentType?: string,
): Promise<UploadResult> {
  try {
    const response = await fetch(uploadUrl, {
      method: "PUT",
      ...(contentType ? { headers: { "content-type": contentType } } : {}),
      // Buffer is a Uint8Array at runtime; the cast is only needed because TS's DOM `BodyInit` typing doesn't
      // structurally match the generic `Buffer<ArrayBufferLike>` type.
      body: body as BodyInit,
    });
    if (!response.ok) {
      return { ok: false, status: response.status, detail: await safeText(response) };
    }
    return { ok: true, status: response.status };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Convenience wrapper: JSON-serializes the recipe/build-artifact and PUTs it as-is. */
export async function uploadRecipeArtifact(uploadUrl: string, artifact: BuildArtifact): Promise<UploadResult> {
  return uploadArtifact(uploadUrl, JSON.stringify(artifact, null, 2), "application/json");
}

/** PUTs the rebuilt Wasm bytes read straight off disk. */
export async function uploadRebuiltWasm(uploadUrl: string, bytes: Uint8Array): Promise<UploadResult> {
  return uploadArtifact(uploadUrl, bytes, "application/wasm");
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 2_000);
  } catch {
    return "";
  }
}
