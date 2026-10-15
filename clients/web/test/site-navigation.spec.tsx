import { render, screen } from "@testing-library/react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SiteNav } from "@/components/site-nav";
import { pageLinks } from "@/config/navigation";
import { docsUrl } from "@/config/site";
import { LandingNav } from "@/features/landing/components/LandingNav";
import { renderInRouter } from "./render-in-router";

const enableLookup = (enabled: boolean) => {
  vi.stubEnv("VITE_ENABLE_AGGREGATOR", enabled ? "true" : "false");
};

afterEach(() => {
  vi.unstubAllEnvs();
});

const hrefOf = (name: string) => screen.getByRole("link", { name }).getAttribute("href");

describe("the page links follow the lookup's flag", () => {
  test("with the lookup on, both pages are offered", () => {
    enableLookup(true);
    expect(pageLinks().map((link) => link.label)).toEqual(["Lookup", "Docs"]);
  });

  test("with it off, the lookup is not offered, because its route redirects away", () => {
    enableLookup(false);
    expect(pageLinks().map((link) => link.label)).toEqual(["Docs"]);
  });
});

describe("the landing nav", () => {
  test("links the lookup and the documentation", async () => {
    enableLookup(true);
    await renderInRouter(<LandingNav />);
    expect(hrefOf("Lookup")).toBe("/query");
    expect(hrefOf("Docs")).toBe(docsUrl);
  });

  test("omits the lookup when it is off", async () => {
    enableLookup(false);
    await renderInRouter(<LandingNav />);
    expect(screen.queryByRole("link", { name: "Lookup" })).toBeNull();
  });

  test("leads to pages, not to sections of the page it sits on", async () => {
    enableLookup(true);
    const { container } = await renderInRouter(<LandingNav />);
    const hrefs = [...container.querySelectorAll("nav a[href]")].map((a) => a.getAttribute("href"));
    expect(hrefs.filter((href) => href?.startsWith("#"))).toEqual([]);
  });
});

describe("the nav every other page carries", () => {
  const renderAt = async (path: "/verify" | "/query") => {
    const root = createRootRoute({ component: Outlet });
    const page = (to: string) =>
      createRoute({ getParentRoute: () => root, path: to, component: () => <SiteNav /> });
    const router = createRouter({
      routeTree: root.addChildren([page("/verify"), page("/query")]),
      history: createMemoryHistory({ initialEntries: [path] }),
    });
    render(<RouterProvider router={router} />);
    await screen.findByRole("link", { name: "Verify" });
  };

  test("marks the page it is on", async () => {
    enableLookup(true);
    await renderAt("/query");
    expect(screen.getByRole("link", { name: "Lookup" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Verify" })).not.toHaveAttribute("aria-current");
  });

  test("offers verify, the lookup and the documentation", async () => {
    enableLookup(true);
    await renderAt("/verify");
    expect(["Verify", "Lookup", "Docs"].map(hrefOf)).toEqual(["/verify", "/query", docsUrl]);
  });
});
