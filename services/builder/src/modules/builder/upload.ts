import type { BuildArtifact } from "@scvs/core";

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

export async function uploadRecipeArtifact(uploadUrl: string, artifact: BuildArtifact): Promise<UploadResult> {
  return uploadArtifact(uploadUrl, JSON.stringify(artifact, null, 2), "application/json");
}

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
