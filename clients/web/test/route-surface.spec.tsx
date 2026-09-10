import { render, screen } from "@testing-library/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRouter,
  rootRouteId,
} from "@tanstack/react-router";
import { describe, expect, test } from "vitest";
import { CONSOLE_ROUTE_PATHS } from "@/app/route-paths";
import { router } from "@/app/router";
import { rootRoute } from "@/app/root-route";
import { landingRoutes } from "@/features/landing/routes";
import { legalRoutes } from "@/features/legal/routes";
import { verificationRoutes } from "@/features/verification/routes";

/**
 * The set nginx is told to serve the entry document for. A route present in one and not the other is a page
 * that works locally and 404s in the deployed image, or the reverse — neither announces itself.
 */
const declared = () => [...CONSOLE_ROUTE_PATHS].sort();

/** Every path the built tree actually answers, `fullPath` being what the router resolves against. */
const mounted = () =>
  Object.entries(router.routesById)
    .filter(([id]) => id !== rootRouteId)
    .map(([, route]) => String(route.fullPath ?? ""))
    .filter(Boolean)
    .map((path) => (path !== "/" && path.endsWith("/") ? path.slice(0, -1) : path))
    .sort();

describe("the console's route surface has one definition", () => {
  test("every mounted route is declared, and every declared path is mounted", () => {
    expect(mounted()).toEqual(declared());
  });

  // The legal routes derive their paths from their content's slug rather than from ROUTE_PATHS, so this pair is
  // the one the test above is load-bearing for.
  test("the legal documents' slugs are the paths that were declared", () => {
    const paths = legalRoutes.map((route) => route.fullPath).sort();
    expect(paths).toEqual(["/privacy", "/terms"]);
  });

  // The landing page is the root route and the console is one segment in — not the other way round, and
  // with no redirect standing between them.
  test("`/` is the landing page and `/verify` is the console", () => {
    expect(router.routesByPath["/"]).toBe(landingRoutes[0]);
    expect(router.routesByPath["/verify"]).toBe(verificationRoutes[0]);
    expect(Object.keys(router.routesByPath)).not.toContain("/verify/submit");
  });
});

describe("the root route renders the landing page rather than redirecting off it", () => {
  test("`/` shows the landing page's own headline, and stays on `/`", async () => {
    const memory = createRouter({
      routeTree: rootRoute.addChildren(landingRoutes),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(<RouterProvider router={memory} />);
    const heading = await screen.findByRole("heading", { level: 1 });
    expect(heading.textContent).toMatch(/Where Soroban source/);
    expect(memory.state.location.pathname).toBe("/");
  });
});

describe("an unrouted path renders the console's own 404", () => {
  test.each(["/admin/policy", "/docs-json", "/verify/jobs/abc/extra", "/verify/submit", "/nope"])(
    "%s",
    async (path) => {
      const memory = createRouter({
        routeTree: rootRoute.addChildren(legalRoutes),
        history: createMemoryHistory({ initialEntries: [path] }),
      });
      render(<RouterProvider router={memory} />);
      expect(await screen.findByTestId("not-found")).toBeInTheDocument();
      expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe(
        "No page at this address",
      );
    },
  );
});
