/**
 * The wire bundle `GET /api/verification/v1/legal` answers with, for specs that drive the console.
 *
 * Every console spec needs one now: the submit path binds the operator's terms version, and it refuses to
 * submit when no bundle loaded. `effective_date` decides only whether the *server* rejects a submission
 * carrying no accepted version; the console requires the act either way, so a spec that submits must accept.
 */
export const legalBundleFixture = (effectiveDate: string | null = null) => ({
  // The generated client returns the whole `AxiosResponse`, not the unwrapped body — its mutator's type is
  // `Promise<AxiosResponse<T>>`. A mock that resolved the bare bundle agreed with a real bug instead of
  // catching it, so this shape is load-bearing.
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
