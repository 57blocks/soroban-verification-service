import { useQuery } from "@tanstack/react-query";
import { fetchAndVerifyResultUrl } from "@scvs/sdk";
import type { ArtifactRecipeFacts, PublishedArtifactState } from "../types";

type ArtifactDocument = {
  result?: { status_summary?: unknown };
  provenance?: { recipe_source?: unknown; build_isolation?: unknown };
  source?: {
    source_sha256?: unknown;
    is_public?: unknown;
    source_file_name?: unknown;
    source_uri?: unknown;
  };
  build_recipe?: {
    build_environment?: {
      kind?: unknown;
      trust_level?: unknown;
      image_digest?: unknown;
      recipe_sha256?: unknown;
      recipe?: {
        template_version?: unknown;
        pair?: { cliver?: unknown; rsver?: unknown };
        components?: unknown;
      };
    };
    build_options?: { bldopt?: unknown; metadata_replay?: unknown };
  };
};

const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

/** `recipe_source` decides a provenance heading, so an unrecognised value is null, never a guess. */
const recipeSource = (value: unknown): ArtifactRecipeFacts["recipeSource"] =>
  value === "on_chain_metadata" || value === "submitted" ? value : null;

const components = (value: unknown): ArtifactRecipeFacts["components"] =>
  (Array.isArray(value) ? value : []).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const kind = str(record.kind);
    return kind ? [{ kind, source: str(record.source), sha256: str(record.sha256) }] : [];
  });

const readRecipe = (document: ArtifactDocument): ArtifactRecipeFacts => {
  const environment = document.build_recipe?.build_environment;
  const recipe = environment?.recipe;
  const pair = recipe?.pair;

  return {
    recipeSource: recipeSource(document.provenance?.recipe_source),
    buildIsolation: str(document.provenance?.build_isolation),
    pair: pair ? { cliver: str(pair.cliver), rsver: str(pair.rsver) } : null,
    environment: environment
      ? {
          kind: str(environment.kind),
          trustLevel: str(environment.trust_level),
          templateVersion: str(recipe?.template_version),
          imageDigest: str(environment.image_digest),
          recipeSha256: str(environment.recipe_sha256),
        }
      : null,
    components: components(recipe?.components),
    buildOptions: strings(document.build_recipe?.build_options?.bldopt),
    metadataReplay: strings(document.build_recipe?.build_options?.metadata_replay),
  };
};

/** The published report artifact for a job, read from the URL the job itself carries. */
export const usePublishedArtifact = (
  artifactUrl: string | undefined,
  artifactSha256: string | undefined,
): PublishedArtifactState => {
  const query = useQuery({
    queryKey: ["published-artifact", artifactUrl, artifactSha256],
    enabled: Boolean(artifactUrl),
    retry: false,
    staleTime: Infinity,
    queryFn: async () => {
      const verified = await fetchAndVerifyResultUrl(
        { type: "report", url: artifactUrl!, ...(artifactSha256 ? { sha256: artifactSha256 } : {}) },
        // Without a declared hash there is nothing to check the bytes against, and the SDK refuses rather than
        // pretending.
        artifactSha256 ? undefined : { allowUnverified: true },
      );

      const document = JSON.parse(new TextDecoder().decode(verified.bytes)) as ArtifactDocument;
      return {
        status: str(document.result?.status_summary),
        source: {
          isPublic: typeof document.source?.is_public === "boolean" ? document.source.is_public : null,
          sourceSha256: str(document.source?.source_sha256),
          fileName: str(document.source?.source_file_name),
          sourceUri: str(document.source?.source_uri),
        },
        recipe: readRecipe(document),
      };
    },
  });

  if (!artifactUrl) return { phase: "not_published" };
  if (query.isPending) return { phase: "loading" };
  if (query.isError) {
    return {
      phase: "unreadable",
      error:
        query.error instanceof Error ? query.error.message : "The published artifact could not be read.",
    };
  }

  return {
    phase: "published",
    status: query.data.status,
    source: query.data.source,
    recipe: query.data.recipe,
  };
};
