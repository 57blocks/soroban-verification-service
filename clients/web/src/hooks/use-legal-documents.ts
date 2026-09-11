import { useQuery } from "@tanstack/react-query";
import { getLegalDocuments } from "@scvs/verify-api-client";
import { isApiBaseConfigured } from "@/lib/http";
import type { LegalBundle, LegalDocument } from "@/lib/legal";

/**
 * The operator's legal documents. Called through the **generated** client, unlike the build log: this is a
 * plain GET with no header, so orval's output can carry it and the `AXIOS_INSTANCE` workaround that route
 * needs must not be copied here.
 *
 * Shared rather than feature-local because two features read it — the legal pages render the documents and
 * the console binds the version — which is what `src/hooks` is for.
 */
export const useLegalDocuments = () => {
  const query = useQuery({
    queryKey: ["legal"],
    enabled: isApiBaseConfigured(),
    // The bundle changes when an operator deploys new text, which is not something a refocus should chase.
    refetchOnWindowFocus: false,
    staleTime: 5 * 60_000,
    // `.data`: the generated client's mutator returns `Promise<AxiosResponse<T>>`, not the unwrapped body —
    // the same reason `useVerificationConsole` reads `res.data` off the submit mutation.
    queryFn: async ({ signal }) => toBundle((await getLegalDocuments(signal)).data),
  });

  return {
    bundle: query.data,
    isLoading: query.isLoading,
    // An unconfigured API base is not a failure to report as one — the page says the same thing either way.
    isError: query.isError || !isApiBaseConfigured(),
  };
};

type WireDocument = {
  slug: LegalDocument["slug"];
  title: string;
  document_title: string;
  intro: string;
  sections: LegalDocument["sections"];
  open_items: string[];
};

type WireBundle = {
  version: string;
  effective_date?: string | null;
  operator_name: string;
  service_name: string;
  history_url?: string | null;
  contact_url?: string | null;
  documents: WireDocument[];
};

const toBundle = (wire: unknown): LegalBundle => {
  const bundle = wire as WireBundle;
  const documents = Object.fromEntries(
    bundle.documents.map((document) => [
      document.slug,
      {
        slug: document.slug,
        title: document.title,
        documentTitle: document.document_title,
        intro: document.intro,
        sections: document.sections,
        openItems: document.open_items,
      } satisfies LegalDocument,
    ]),
  ) as LegalBundle["documents"];

  return {
    version: bundle.version,
    effectiveDate: bundle.effective_date ?? null,
    operatorName: bundle.operator_name,
    serviceName: bundle.service_name,
    historyUrl: bundle.history_url ?? null,
    contactUrl: bundle.contact_url ?? null,
    documents,
  };
};
