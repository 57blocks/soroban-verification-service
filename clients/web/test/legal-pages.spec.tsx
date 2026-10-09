import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { describe, expect, test, vi, beforeEach } from "vitest";
import { rootRoute } from "@/app/root-route";
import { LegalLinks } from "@/components/legal-links";
import { legalLinks } from "@/config/site";
import { SiteFooter } from "@/components/site-footer";
import { footerLegal } from "@/features/landing/content";
import { LegalPage } from "@/features/legal/components/LegalPage";
import { legalRoutes } from "@/features/legal/routes";
import { SubmissionAgreement } from "@/features/verification/components/SubmissionAgreement";
import { renderInRouter } from "./render-in-router";
import type { LegalBundle, LegalDocument } from "@/lib/legal";

const getLegalDocuments = vi.fn();
vi.mock("@scvs/verify-api-client", async () => ({
  getLegalDocuments: (signal?: AbortSignal) => getLegalDocuments(signal),
  jobEventsPath: (await vi.importActual<typeof import("@scvs/verify-api-client")>("@scvs/verify-api-client"))
    .jobEventsPath,
}));
vi.mock("@/lib/http", () => ({
  isApiBaseConfigured: () => true,
  getApiBase: () => "http://api.test",
}));

const hrefs = () => screen.getAllByRole("link").map((link) => link.getAttribute("href"));

const document_ = (slug: LegalDocument["slug"], title: string): LegalDocument => ({
  slug,
  title,
  documentTitle: `${title} | Test Verifier`,
  intro: `An intro with **bold** and a [link](https://example.invalid).`,
  sections: [
    { id: "first", heading: "1. First", blocks: ["A paragraph.", { list: ["One", "Two"] }] },
    { id: "second", heading: "2. Second", blocks: ["Another paragraph."] },
  ],
  openItems: ["An item still open for review."],
});

const bundle = (overrides: Partial<LegalBundle> = {}): LegalBundle => ({
  version: "TEST-2026-09-08",
  effectiveDate: null,
  operatorName: "Test Operator",
  serviceName: "Test Verifier",
  historyUrl: "https://example.invalid/history",
  contactUrl: null,
  documents: {
    terms: document_("terms", "Terms of Service"),
    privacy: document_("privacy", "Privacy Notice"),
  },
  ...overrides,
});

/** Wrapped in `{ data }` because the generated client resolves an `AxiosResponse`, not the body. */
const asResponse = (source: LegalBundle) => ({ data: wireFrom(source) });

const wireFrom = (source: LegalBundle) => ({
  schema: "scvs-legal-documents-v1",
  version: source.version,
  effective_date: source.effectiveDate,
  operator_name: source.operatorName,
  service_name: source.serviceName,
  history_url: source.historyUrl,
  contact_url: source.contactUrl,
  documents: Object.values(source.documents).map((doc) => ({
    slug: doc.slug,
    title: doc.title,
    document_title: doc.documentTitle,
    intro: doc.intro,
    sections: doc.sections,
    open_items: doc.openItems,
  })),
});

const renderRoute = async (path: string) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree: rootRoute.addChildren(legalRoutes),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  getLegalDocuments.mockReset();
});

describe("the two documents are reachable from every page that needs them", () => {
  test.each([
    ["/terms", "Terms of Service"],
    ["/privacy", "Privacy Notice"],
  ])("%s renders %s once the operator's bundle loads", async (path, title) => {
    getLegalDocuments.mockResolvedValue(asResponse(bundle()));
    await renderRoute(path);

    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe(title);
    expect(await screen.findByRole("navigation", { name: /contents/i })).toBeInTheDocument();
    expect(screen.getByTestId("legal-version").textContent).toBe(`Version ${bundle().version}`);
    expect(screen.queryByTestId("legal-unavailable")).toBeNull();
  });

  test("the link table points at those two routes", () => {
    expect(legalLinks.map(({ to }) => to).sort()).toEqual(["/privacy", "/terms"]);
  });

  test("the shared footer links both documents", async () => {
    await renderInRouter(<SiteFooter />);
    expect(hrefs()).toEqual(expect.arrayContaining(["/terms", "/privacy"]));
  });

  test("the landing footer's licence line names the licence the repository actually carries", () => {
    expect(footerLegal).toMatch(/Apache-2\.0/);
    expect(footerLegal).not.toMatch(/MIT/);
  });

  test("the submission control carries the agreement line with both links", async () => {
    await renderInRouter(<SubmissionAgreement />);
    const line = screen.getByTestId("submission-agreement");
    expect(line.textContent).toMatch(/you agree to the Terms of Service/);
    expect(line.textContent).toMatch(/Privacy Notice/);
    expect(hrefs()).toEqual(expect.arrayContaining(["/terms", "/privacy"]));
  });

  test("the consent line's links leave the submission where it is", async () => {
    await renderInRouter(<SubmissionAgreement />);

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    }
  });

  test("the console's footer links do too, and the legal pages' own do not", async () => {
    const { unmount } = await renderInRouter(<LegalLinks newTab />);
    for (const link of screen.getAllByRole("link")) {
      expect(link).toHaveAttribute("target", "_blank");
    }
    unmount();

    await renderInRouter(<LegalLinks />);
    for (const link of screen.getAllByRole("link")) {
      expect(link).not.toHaveAttribute("target");
    }
  });

  test("the legal links render one anchor per document", async () => {
    await renderInRouter(<LegalLinks />);
    expect(hrefs()).toEqual(["/terms", "/privacy"]);
  });
});

describe("a legal page renders its document as data", () => {
  test.each(["terms", "privacy"] as const)(
    "%s has a heading, a contents list, and every section anchored by id",
    async (slug) => {
      const fixture = bundle();
      const doc = fixture.documents[slug];
      await renderInRouter(<LegalPage doc={doc} bundle={fixture} />);

      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(doc.title);
      const contents = screen.getByRole("navigation", { name: /contents/i });
      for (const { id, heading } of doc.sections) {
        expect(contents.textContent).toContain(heading);
        expect(window.document.getElementById(id)).not.toBeNull();
      }
    },
  );

  test("each document links to the other, and not to itself", async () => {
    const fixture = bundle();
    await renderInRouter(<LegalPage doc={fixture.documents.terms} bundle={fixture} />);
    const seeAlso = screen.getByText(/See also/).closest("p");
    const links = [...(seeAlso?.querySelectorAll("a") ?? [])].map((a) => a.getAttribute("href"));
    expect(links).toEqual(["/privacy"]);
  });

  test("inline marks become markup, and never leak as literal asterisks or brackets", async () => {
    const fixture = bundle();
    await renderInRouter(<LegalPage doc={fixture.documents.terms} bundle={fixture} />);
    const article = screen.getByRole("article");
    expect(article.querySelector("strong")).not.toBeNull();
    expect(article.textContent).not.toMatch(/\*\*/);
    expect(article.textContent).not.toMatch(/\]\(/);
  });

  test("the operator's name and version come from the bundle, not from this repository", async () => {
    const fixture = bundle({ operatorName: "Someone Else Entirely", version: "v9" });
    await renderInRouter(<LegalPage doc={fixture.documents.terms} bundle={fixture} />);
    expect(screen.getByRole("article").textContent).toContain("Someone Else Entirely");
    expect(screen.getByTestId("legal-version").textContent).toBe("Version v9");
  });
});

describe("the draft banner follows the operator's effective date, not a constant here", () => {
  test("no effective date shows the banner and the open items", async () => {
    const fixture = bundle({ effectiveDate: null });
    await renderInRouter(<LegalPage doc={fixture.documents.privacy} bundle={fixture} />);
    expect(screen.getByTestId("legal-draft-banner")).toBeInTheDocument();
    expect(screen.getByTestId("legal-open-items")).toBeInTheDocument();
    expect(screen.getByText(/pending legal review/i)).toBeInTheDocument();
  });

  test("an effective date removes both and states the date", async () => {
    const fixture = bundle({ effectiveDate: "2026-09-15" });
    await renderInRouter(<LegalPage doc={fixture.documents.privacy} bundle={fixture} />);
    expect(screen.queryByTestId("legal-draft-banner")).toBeNull();
    expect(screen.queryByTestId("legal-open-items")).toBeNull();
    expect(screen.getByText(/In effect from 2026-09-15/i)).toBeInTheDocument();
  });
});

describe("a legal page that cannot load its text says so", () => {
  test("it renders a stated failure, never an empty document", async () => {
    getLegalDocuments.mockRejectedValue(new Error("no bundle configured"));
    await renderRoute("/terms");

    const panel = await screen.findByTestId("legal-unavailable");
    expect(panel.textContent).toMatch(/could not be loaded/);
    expect(panel.textContent).toMatch(/Submissions are blocked/);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Terms of Service");
    expect(screen.queryByRole("navigation", { name: /contents/i })).toBeNull();
  });

  test("it shows a loading state while the bundle is in flight", async () => {
    getLegalDocuments.mockReturnValue(new Promise(() => {}));
    await renderRoute("/privacy");
    expect(await screen.findByTestId("legal-loading")).toBeInTheDocument();
  });
});

describe("the committed example bundle renders", () => {
  const reference = JSON.parse(
    readFileSync(resolve(__dirname, "../../../config/legal-documents.example.json"), "utf8"),
  ) as ReturnType<typeof wireFrom>;

  const asBundle = (): LegalBundle => ({
    version: reference.version,
    effectiveDate: reference.effective_date,
    operatorName: reference.operator_name,
    serviceName: reference.service_name,
    historyUrl: reference.history_url,
    contactUrl: reference.contact_url,
    documents: Object.fromEntries(
      reference.documents.map((doc) => [
        doc.slug,
        {
          slug: doc.slug,
          title: doc.title,
          documentTitle: doc.document_title,
          intro: doc.intro,
          sections: doc.sections,
          openItems: doc.open_items,
        },
      ]),
    ) as LegalBundle["documents"],
  });

  test.each(["terms", "privacy"] as const)("%s renders every section, with no leaked markup", async (slug) => {
    const fixture = asBundle();
    const doc = fixture.documents[slug];
    await renderInRouter(<LegalPage doc={doc} bundle={fixture} />);

    expect(doc.sections.length).toBeGreaterThan(0);
    for (const { id, heading } of doc.sections) {
      expect(window.document.getElementById(id)).not.toBeNull();
      expect(screen.getByRole("navigation", { name: /contents/i }).textContent).toContain(heading);
    }

    const article = screen.getByRole("article");
    expect(article.textContent).not.toMatch(/\*\*/);
    expect(article.textContent).not.toMatch(/\]\(/);
    expect(article.textContent).not.toContain("${");
  });

  test("its bold, link and list render as elements", async () => {
    const fixture = asBundle();
    await renderInRouter(<LegalPage doc={fixture.documents.terms} bundle={fixture} />);

    const article = screen.getByRole("article");
    expect(article.querySelector("strong")?.textContent).toBe("bold");
    expect(article.querySelector('a[href="https://example.invalid"]')?.textContent).toBe("a link");
    expect(article.querySelectorAll("li").length).toBeGreaterThanOrEqual(2);
  });

  test("it is still a draft, so the banner and the open items show", async () => {
    const fixture = asBundle();
    expect(fixture.effectiveDate).toBeNull();
    await renderInRouter(<LegalPage doc={fixture.documents.terms} bundle={fixture} />);
    expect(screen.getByTestId("legal-draft-banner")).toBeInTheDocument();
    expect(screen.getByTestId("legal-open-items")).toBeInTheDocument();
  });
});

describe("this repository ships the mechanism and no operator's legal text", () => {
  test("the legal feature exports no document content", async () => {
    const content = await import("@/features/legal/content/shared");
    expect(Object.keys(content).sort()).toEqual(["draftBannerCopy", "openItemsHeading"]);
  });

  test("no module under features/legal/content declares a document", async () => {
    const modules = import.meta.glob("../src/features/legal/content/*.ts");
    expect(Object.keys(modules).map((path) => path.split("/").pop()).sort()).toEqual(["shared.ts"]);
  });
});
