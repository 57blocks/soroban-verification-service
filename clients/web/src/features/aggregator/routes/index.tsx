import { createRoute, redirect } from "@tanstack/react-router";
import { rootRoute } from "@/app/root-route";
import { ROUTE_PATHS } from "@/app/route-paths";
import { isAggregatorEnabled } from "@/config/features";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { AggregatorPage } from "../components/AggregatorPage";

/**
 * One route, behind one flag. The flag is checked here rather than only at mount, so a deployment with it off
 * has no reachable page at all.
 */
const aggregatorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: ROUTE_PATHS.query,
  beforeLoad: () => {
    if (!isAggregatorEnabled()) {
      throw redirect({ to: "/verify", replace: true });
    }
  },
  component: function AggregatorRoute() {
    useDocumentTitle("Aggregated Verification Results | Soroban Verify");
    return <AggregatorPage />;
  },
});

export const aggregatorRoutes = [aggregatorRoute];
