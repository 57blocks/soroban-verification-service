import type { ArtifactRecipeFacts } from "../types";
import { stringArray } from "./diagnostics.util";

export type ProvenanceField = {
  key: string;
  label: string;
  value: string;
  href?: string;
};

export type ProvenanceGroup = {
  key: "declared" | "recipe";
  title: string;
  origin: string;
  fields: ProvenanceField[];
};

const httpHref = (value: string) => (/^https?:\/\//.test(value) ? value : undefined);

const repoHref = (repo: string) => {
  const gh = /^github:([\w.-]+\/[\w.-]+)$/.exec(repo);
  return gh ? `https://github.com/${gh[1]}` : httpHref(repo);
};

const parsePairs = (entries: string[]): Map<string, string> => {
  const pairs = new Map<string, string>();
  for (const entry of entries) {
    const split = entry.indexOf("=");
    if (split <= 0) continue;
    const key = entry.slice(0, split).trim();
    const value = entry.slice(split + 1).trim();
    if (key && value) pairs.set(key, value);
  }
  return pairs;
};

const RECIPE_ORIGINS: Record<
  NonNullable<ArtifactRecipeFacts["recipeSource"]>,
  { title: string; origin: string }
> = {
  on_chain_metadata: {
    title: "Reproduced from the contract's own recipe",
    origin: "provenance.recipe_source: on_chain_metadata",
  },
  submitted: {
    title: "Supplied with the submission",
    origin: "provenance.recipe_source: submitted",
  },
};

type ProvenanceInput = {
  recipe: ArtifactRecipeFacts;
  sourceUri: string | null;
  sourceSha256: string | null;
  diagnostics?: Record<string, unknown> | undefined;
};

export const rebuildProvenance = ({
  recipe,
  sourceUri,
  sourceSha256,
  diagnostics,
}: ProvenanceInput): ProvenanceGroup[] => {
  const groups: ProvenanceGroup[] = [];

  const declared: ProvenanceField[] = [];
  if (recipe.pair?.cliver) {
    declared.push({
      key: "cliver",
      label: "Stellar CLI (cliver)",
      value: recipe.pair.cliver,
    });
  }
  if (recipe.pair?.rsver) {
    declared.push({ key: "rsver", label: "Rust (rsver)", value: recipe.pair.rsver });
  }
  const chainMetadata = parsePairs(recipe.metadataReplay);
  for (const [key, value] of chainMetadata) {
    const href = key === "source_repo" ? repoHref(value) : httpHref(value);
    declared.push({
      key: `meta_${key}`,
      label: key === "source_repo" ? "Source repository" : key,
      value,
      ...(href ? { href } : {}),
    });
  }
  if (declared.length) {
    groups.push({
      key: "declared",
      title: "Declared by the contract",
      origin: "Read from its on-chain contractmetav0 — a submitter cannot choose these.",
      fields: declared,
    });
  }

  const recipeFields: ProvenanceField[] = [];
  if (sourceUri) {
    recipeFields.push({
      key: "source_uri",
      label: "Source archive",
      value: sourceUri,
      ...(httpHref(sourceUri) ? { href: sourceUri } : {}),
    });
  }
  if (sourceSha256) {
    recipeFields.push({
      key: "source_sha256",
      label: "Source SHA-256",
      value: sourceSha256,
    });
  }
  if (recipe.buildOptions.length) {
    recipeFields.push({
      key: "bldopt",
      label: "Build options",
      value: recipe.buildOptions.join(" "),
    });
  }
  const manifestPath =
    typeof diagnostics?.container_manifest_path === "string"
      ? diagnostics.container_manifest_path
      : undefined;
  if (manifestPath) {
    recipeFields.push({ key: "manifest", label: "Manifest", value: manifestPath });
  }
  if (recipeFields.length && recipe.recipeSource) {
    groups.push({ key: "recipe", ...RECIPE_ORIGINS[recipe.recipeSource], fields: recipeFields });
  } else if (recipeFields.length) {
    groups.push({
      key: "recipe",
      title: "Build inputs",
      origin: "This report did not state where the recipe came from.",
      fields: recipeFields,
    });
  }

  return groups;
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
