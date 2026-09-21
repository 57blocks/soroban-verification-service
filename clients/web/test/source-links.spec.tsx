import { render, screen } from "@testing-library/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, test } from "vitest";
import { rootRoute } from "@/app/root-route";
import { SiteNav } from "@/components/site-nav";
import { githubRepoUrl, sourceIsPublic } from "@/config/site";
import { audienceCards } from "@/features/landing/content";
import { landingRoutes } from "@/features/landing/routes";
import { footerColumns, operatorPointer } from "@/features/landing/navigation";
import { renderInRouter } from "./render-in-router";

/**
 * Every rendered destination, not just the ones the content tables hold: the gate is that no *position*
 * offers the repository while it is private, and a new one added in JSX is caught here too.
 */
const repoHrefs = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLAnchorElement>("a[href]")]
    .map((anchor) => anchor.getAttribute("href") ?? "")
    .filter((href) => href.startsWith(githubRepoUrl));

const renderLanding = async () => {
  const memory = createRouter({
    routeTree: rootRoute.addChildren(landingRoutes),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const { container } = render(<RouterProvider router={memory} />);
  await screen.findByRole("heading", { level: 1 });
  return container;
};

describe("a private repository is not linked from anywhere", () => {
  test("`sourceIsPublic` is what this suite is asserting against", () => {
    expect(sourceIsPublic).toBe(false);
  });

  test("the landing page offers no repository link", async () => {
    expect(repoHrefs(await renderLanding())).toEqual([]);
  });

  test("the nav every other page carries offers none either", async () => {
    const { container } = await renderInRouter(<SiteNav />);
    expect(repoHrefs(container)).toEqual([]);
  });
});

/**
 * The links are withheld, not deleted. Flipping `sourceIsPublic` has to bring them back, so the tables that
 * hold them must keep holding them — and `landing-content.spec.ts` keeps checking each names a real path.
 */
describe("withheld, not deleted", () => {
  test("the footer still declares the repository links it is not rendering", () => {
    const hrefs = footerColumns.flatMap((column) => column.items.map((item) => item.href));
    expect(hrefs.filter((href) => href.startsWith(githubRepoUrl))).toHaveLength(4);
  });

  test("the operator pointer is declared, and withheld with the rest", () => {
    expect(operatorPointer.href.startsWith(githubRepoUrl)).toBe(true);
  });

  test("the integrator card still declares its destination", () => {
    const external = audienceCards.map((c) => c.action).filter((a) => a.kind === "external");
    expect(external).toHaveLength(1);
  });
});
