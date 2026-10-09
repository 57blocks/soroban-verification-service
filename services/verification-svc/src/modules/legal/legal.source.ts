import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { findWorkspaceRoot } from "@scvs/config";

const VARIABLE = "SCVS_LEGAL_DOCUMENTS_SOURCE";

export async function loadLegalDocumentsSource(configured: string | undefined): Promise<{ label: string; raw: string }> {
  const source = configured?.trim();
  if (!source) {
    throw new Error(
      `${VARIABLE} is required: this service serves the operator's legal documents and ships none of its own. ` +
        `Set it to a JSON bundle's path or https: URL, or to the bundle itself (see config/legal-documents.example.json).`,
    );
  }

  if (source.startsWith("{")) {
    // Untrimmed: a job binds the sha256 of these exact bytes, trailing newline included.
    return { label: `${VARIABLE} (inline)`, raw: configured as string };
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    const url = new URL(source);
    if (url.protocol !== "https:") {
      throw new Error(
        `${VARIABLE} must be an https: URL or a file path; got "${url.protocol}//". The bundle is what a ` +
          `submitter's acceptance is recorded against, so it must not be fetched over a rewritable channel.`,
      );
    }
    const response = await fetch(url).catch((error: Error) => {
      throw new Error(`Could not fetch legal documents from ${url}: ${error.message}`);
    });
    if (!response.ok) {
      throw new Error(
        `Could not fetch legal documents from ${url}: HTTP ${response.status} ${response.statusText}`,
      );
    }
    return { label: url.toString(), raw: await response.text() };
  }

  // Workspace-root-relative, not cwd-relative: this runs from a checkout and from `/app` in the image.
  const path = isAbsolute(source) ? source : resolve(requireWorkspaceRoot(source), source);
  const raw = await readFile(path, "utf8").catch((error: Error) => {
    throw new Error(`Could not read legal documents at ${path}: ${error.message}`);
  });
  return { label: path, raw };
}

function requireWorkspaceRoot(source: string): string {
  const root = findWorkspaceRoot();
  if (root) return root;
  throw new Error(
    `${VARIABLE} is the relative path "${source}", but there is no workspace root to resolve it against. ` +
      `Use an absolute path or an https: URL.`,
  );
}
