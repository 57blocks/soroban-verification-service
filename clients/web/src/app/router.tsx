import { createRouter } from "@tanstack/react-router";
import { landingRoutes } from "@/features/landing";
import { legalRoutes } from "@/features/legal";
import { aggregatorRoutes } from "@/features/aggregator";
import { verificationRoutes } from "@/features/verification";
import { rootRoute } from "./root-route";

// Each feature owns its own route definitions (path, search validation, document title); this file only decides
// which features are mounted and in what order.
const routeTree = rootRoute.addChildren([
  ...landingRoutes,
  ...verificationRoutes,
  ...legalRoutes,
  // Flag-off by default and linked from nowhere; its own route guard redirects when the flag is unset, so a
  // default build has no reachable page.
  ...aggregatorRoutes,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
