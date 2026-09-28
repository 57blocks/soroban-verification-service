export const legalBundleFixture = (effectiveDate: string | null = null) => ({
  // The generated client resolves the whole `AxiosResponse`; a bare-body mock would hide a missing `.data`.
  data: legalBundleBody(effectiveDate),
});

const legalBundleBody = (effectiveDate: string | null) => ({
  schema: "scvs-legal-documents-v1",
  version: "TEST-2026-09-08",
  effective_date: effectiveDate,
  operator_name: "Test Operator",
  service_name: "Test Verifier",
  history_url: null,
  contact_url: null,
  documents: (["terms", "privacy"] as const).map((slug) => ({
    slug,
    title: slug === "terms" ? "Terms of Service" : "Privacy Notice",
    document_title: slug,
    intro: "Placeholder.",
    sections: [{ id: "s", heading: "1. S", blocks: ["A paragraph."] }],
    open_items: [],
  })),
});
