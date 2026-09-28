export type LegalBlock = string | { list: string[] };

export type LegalSection = {
  id: string;
  heading: string;
  blocks: LegalBlock[];
};

export type LegalDocument = {
  slug: "terms" | "privacy";
  title: string;
  documentTitle: string;
  intro: string;
  sections: LegalSection[];
  openItems: string[];
};

export type LegalBundle = {
  version: string;
  effectiveDate: string | null;
  operatorName: string;
  serviceName: string;
  historyUrl: string | null;
  contactUrl: string | null;
  documents: Record<LegalDocument["slug"], LegalDocument>;
};
