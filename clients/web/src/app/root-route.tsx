import { Outlet, createRootRoute } from "@tanstack/react-router";
import { NotFoundPage } from "@/components/not-found";

/** The single root route every feature hangs its own routes off. */
export const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: NotFoundPage,
});
