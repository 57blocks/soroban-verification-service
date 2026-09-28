import { useQuery } from "@tanstack/react-query";
import { getLegalDocuments } from "@scvs/verify-api-client";
import { isApiBaseConfigured } from "@/lib/http";
import type { LegalBundle, LegalDocument } from "@/lib/legal";

export const useLegalDocuments = () => {
  const query = useQuery({
    queryKey: ["legal"],
    enabled: isApiBaseConfigured(),
    refetchOnWindowFocus: false,
    staleTime: 5 * 60_000,
    // The generated client resolves an `AxiosResponse`, not the body.
    queryFn: async ({ signal }) => toBundle((await getLegalDocuments(signal)).data),
  });

  return {
    bundle: query.data,
    isLoading: query.isLoading,
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
