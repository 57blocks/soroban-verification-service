import { createRoute, redirect } from "@tanstack/react-router";
import { rootRoute } from "@/app/root-route";
import { ROUTE_PATHS } from "@/app/route-paths";
import { SiteNav } from "@/components/site-nav";
import { isAggregatorEnabled } from "@/config/features";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { AggregatorPage } from "../components/AggregatorPage";

const aggregatorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: ROUTE_PATHS.query,
  beforeLoad: () => {
    if (!isAggregatorEnabled()) {
      throw redirect({ to: "/verify", replace: true });
    }
  },
  component: function AggregatorRoute() {
    useDocumentTitle("Aggregated Verification Results | Soroban Verifier");
    return (
      <>
        <SiteNav />
        <AggregatorPage />
      </>
    );
  },
});

export const aggregatorRoutes = [aggregatorRoute];
