import { Outlet, createRootRoute } from "@tanstack/react-router";
import { NotFoundPage } from "@/components/not-found";

export const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: NotFoundPage,
});
