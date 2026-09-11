/**
 * A legal document as data. Paragraphs are strings with two inline marks — `**bold**` and `[label](href)` — and
 * a list is an array of such strings.
 */
export type LegalBlock = string | { list: string[] };

export type LegalSection = {
  /** URL fragment for the section, so a specific clause can be linked to. */
  id: string;
  heading: string;
  blocks: LegalBlock[];
};

export type LegalDocument = {
  slug: "terms" | "privacy";
  title: string;
  /** The browser tab title. */
  documentTitle: string;
  intro: string;
  sections: LegalSection[];
  /** Questions the draft leaves for legal review. Rendered only while the document is a draft. */
  openItems: string[];
};

/**
 * The operator-supplied bundle behind `GET /api/verification/v1/legal`, mapped into this feature's camelCase
 * at the hook boundary. One version and one hash cover both documents: the unit of assent is the pair.
 */
export type LegalBundle = {
  version: string;
  /** Null while the operator's text is a draft — which is also what keeps acceptance optional. */
  effectiveDate: string | null;
  operatorName: string;
  serviceName: string;
  historyUrl: string | null;
  contactUrl: string | null;
  documents: Record<LegalDocument["slug"], LegalDocument>;
};
