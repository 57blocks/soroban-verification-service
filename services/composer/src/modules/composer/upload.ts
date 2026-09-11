import type { ComposerArtifact } from "@scvs/core";

/**
 * The composer's only outbound channel for its result: a plain PUT to the presigned URL it was handed
 * (`ComposerJobParams.upload_url`, minted by `ComposerDispatchService`).
 */

export type UploadResult =
  | { ok: true; status: number }
  | { ok: false; status?: number; detail: string };

export async function uploadComposerArtifact(
  uploadUrl: string,
  artifact: ComposerArtifact,
): Promise<UploadResult> {
  try {
    const response = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(artifact, null, 2),
    });
    if (!response.ok) {
      return { ok: false, status: response.status, detail: await safeText(response) };
    }
    return { ok: true, status: response.status };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 2_000);
  } catch {
    return "";
  }
}
