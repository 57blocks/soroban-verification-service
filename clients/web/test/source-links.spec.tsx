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
import { audienceCards, visibleAudienceCards } from "@/features/landing/content";
import { landingRoutes } from "@/features/landing/routes";
import {
  footerColumns,
  operatorPointer,
  visibleFooterColumns,
  visibleOperatorPointer,
} from "@/features/landing/navigation";
import { renderInRouter } from "./render-in-router";

const repoHrefs = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLAnchorElement>("a[href]")]
    .map((anchor) => anchor.getAttribute("href") ?? "")
    .filter((href) => href.startsWith(githubRepoUrl));

const footerRepoHrefs = footerColumns
  .flatMap((column) => column.items.map((item) => item.href))
  .filter((href) => href.startsWith(githubRepoUrl));

const audienceRepoHrefs = audienceCards
  .map((card) => card.action)
  .flatMap((action) => (action.kind === "external" ? [action.href] : []))
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

describe("the public repository is linked", () => {
  test("`sourceIsPublic` is what this suite is asserting against", () => {
    expect(sourceIsPublic).toBe(true);
  });

  test("the landing page links the repository, the footer's source links and the integrator card", async () => {
    expect(new Set(repoHrefs(await renderLanding()))).toEqual(
      new Set([githubRepoUrl, ...footerRepoHrefs, ...audienceRepoHrefs]),
    );
  });

  test("the nav every other page carries links it too", async () => {
    const { container } = await renderInRouter(<SiteNav />);
    expect(repoHrefs(container)).toEqual([githubRepoUrl]);
  });
});

describe("nothing is withheld", () => {
  test("the footer renders every repository link it declares", () => {
    expect(footerRepoHrefs).toHaveLength(3);
    expect(visibleFooterColumns()).toEqual(footerColumns);
  });

  test("the operator pointer leads to the self-hosting guide", () => {
    expect(operatorPointer.href).toBe("/docs/self-hosting/overview");
    expect(visibleOperatorPointer()).toBe(operatorPointer);
  });

  test("the integrator card keeps its destination", () => {
    expect(audienceRepoHrefs).toHaveLength(1);
    expect(visibleAudienceCards()).toEqual(audienceCards);
  });
});
