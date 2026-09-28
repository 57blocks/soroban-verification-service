import { createRouter } from "@tanstack/react-router";
import { landingRoutes } from "@/features/landing";
import { legalRoutes } from "@/features/legal";
import { aggregatorRoutes } from "@/features/aggregator";
import { verificationRoutes } from "@/features/verification";
import { rootRoute } from "./root-route";

const routeTree = rootRoute.addChildren([
  ...landingRoutes,
  ...verificationRoutes,
  ...legalRoutes,
  ...aggregatorRoutes,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
