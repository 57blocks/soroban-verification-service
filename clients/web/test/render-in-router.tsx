import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

export const renderInRouter = async (ui: ReactNode) => {
  const root = createRootRoute({ component: Outlet });
  const index = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <div data-testid="routed">{ui}</div>,
  });
  const router = createRouter({
    routeTree: root.addChildren([index]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const rendered = render(<RouterProvider router={router} />);
  await screen.findByTestId("routed");
  return rendered;
};
