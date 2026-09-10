import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "@/app/root-route";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useLegalDocuments } from "@/hooks/use-legal-documents";
import type { LegalDocument } from "@/lib/legal";
import { LegalPage } from "../components/LegalPage";
import { LegalPageLoading, LegalPageUnavailable } from "../components/LegalPageStates";

const SLUGS = ["terms", "privacy"] as const;

/** Used before the operator's bundle has answered, so the heading and tab are never blank. */
const FALLBACK_TITLES: Record<LegalDocument["slug"], string> = {
  terms: "Terms of Service",
  privacy: "Privacy Notice",
};

const legalRoute = (slug: LegalDocument["slug"]) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path: `/${slug}`,
    component: function LegalRoute() {
      const { bundle, isLoading, isError } = useLegalDocuments();
      const doc = bundle?.documents[slug];
      useDocumentTitle(doc?.documentTitle ?? FALLBACK_TITLES[slug]);

      if (isLoading) return <LegalPageLoading title={FALLBACK_TITLES[slug]} />;
      if (isError || !bundle || !doc) return <LegalPageUnavailable title={FALLBACK_TITLES[slug]} />;
      return <LegalPage doc={doc} bundle={bundle} />;
    },
  });

export const legalRoutes = SLUGS.map(legalRoute);
