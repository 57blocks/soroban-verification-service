import type { ArtifactRecipeFacts } from "../types";
import { stringArray } from "./diagnostics.util";

export type ProvenanceField = {
  key: string;
  label: string;
  value: string;
  href?: string;
  onChain?: boolean;
};

export type RebuildInputs = {
  origin: string;
  fields: ProvenanceField[];
};

const httpHref = (value: string) => (/^https?:\/\//.test(value) ? value : undefined);

const repoHref = (repo: string) => {
  const gh = /^github:([\w.-]+\/[\w.-]+)$/.exec(repo);
  return gh ? `https://github.com/${gh[1]}` : httpHref(repo);
};

const parsePairs = (entries: string[]): Map<string, string[]> => {
  const pairs = new Map<string, string[]>();
  for (const entry of entries) {
    const split = entry.indexOf("=");
    if (split <= 0) continue;
    const key = entry.slice(0, split).trim();
    const value = entry.slice(split + 1).trim();
    if (key && value) pairs.set(key, [...(pairs.get(key) ?? []), value]);
  }
  return pairs;
};

const splitOptions = (value: string | undefined) => (value ? value.split(/\s+/).filter(Boolean) : []);

const RECIPE_ORIGINS: Record<NonNullable<ArtifactRecipeFacts["recipeSource"]>, string> = {
  on_chain_metadata: "Reproduced from the contract's own on-chain recipe.",
  submitted: "Recipe supplied with the submission.",
};

type ProvenanceInput = {
  recipe: ArtifactRecipeFacts;
  sourceUri: string | null;
  sourceSha256: string | null;
  diagnostics?: Record<string, unknown> | undefined;
};

// One list of the inputs a rebuild needs; a value also read from contractmetav0 is tagged onChain.
export const rebuildProvenance = ({
  recipe,
  sourceUri,
  sourceSha256,
  diagnostics,
}: ProvenanceInput): RebuildInputs | null => {
  const declared = parsePairs(recipe.metadataReplay);
  const metaValue = (key: string) => declared.get(key)?.at(-1);
  const fields: ProvenanceField[] = [];

  const repo = metaValue("source_repo");
  if (repo) {
    const href = repoHref(repo);
    fields.push({ key: "source_repo", label: "Source repository", value: repo, onChain: true, ...(href ? { href } : {}) });
  }

  const archive = sourceUri ?? metaValue("source_uri") ?? null;
  if (archive) {
    const href = httpHref(archive);
    fields.push({
      key: "source_uri",
      label: "Source archive",
      value: archive,
      onChain: metaValue("source_uri") === archive,
      ...(href ? { href } : {}),
    });
  }

  const sha = sourceSha256 ?? metaValue("source_sha256") ?? null;
  if (sha) {
    fields.push({ key: "source_sha256", label: "Source SHA-256", value: sha, onChain: metaValue("source_sha256") === sha });
  }

  const image = metaValue("bldimg");
  if (image) fields.push({ key: "bldimg", label: "Build image", value: image, onChain: true });

  const cliver = recipe.pair?.cliver ?? metaValue("cliver");
  if (cliver) fields.push({ key: "cliver", label: "Stellar CLI (cliver)", value: cliver, onChain: true });
  const rsver = recipe.pair?.rsver ?? metaValue("rsver");
  if (rsver) fields.push({ key: "rsver", label: "Rust (rsver)", value: rsver, onChain: true });

  const declaredOptions = (declared.get("bldopt") ?? []).flatMap((option) => splitOptions(option));
  const options = [...new Set([...recipe.buildOptions.flatMap((option) => splitOptions(option)), ...declaredOptions])];
  if (options.length) {
    fields.push({
      key: "bldopt",
      label: "Build options",
      value: options.join(" "),
      onChain: options.every((option) => declaredOptions.includes(option)),
    });
  }

  const bldarg = declared.get("bldarg")?.join(" ");
  if (bldarg) fields.push({ key: "bldarg", label: "Build arguments", value: bldarg, onChain: true });

  const manifestPath =
    typeof diagnostics?.container_manifest_path === "string" ? diagnostics.container_manifest_path : undefined;
  if (manifestPath) fields.push({ key: "manifest", label: "Manifest", value: manifestPath });

  if (!fields.length) return null;
  return {
    origin: recipe.recipeSource ? RECIPE_ORIGINS[recipe.recipeSource] : "This report did not state where the recipe came from.",
    fields,
  };
};

export const wasmStatusUrlFromReportUrl = (
  reportUrl: string | undefined,
  wasmHash: string | undefined,
): string | undefined => {
  if (!reportUrl || !wasmHash) return undefined;
  let url: URL;
  try {
    url = new URL(reportUrl);
  } catch {
    return undefined;
  }
  const segments = url.pathname.split("/");
  if (segments.length < 3 || segments[segments.length - 2] !== "reports") return undefined;
  segments.splice(-2, 2, "wasms", `${wasmHash.toLowerCase()}.json`);
  url.pathname = segments.join("/");
  url.search = "";
  url.hash = "";
  return url.toString();
};

export { stringArray };
