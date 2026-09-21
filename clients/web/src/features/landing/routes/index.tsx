import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "@/app/root-route";
import { ROUTE_PATHS } from "@/app/route-paths";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { LandingPage } from "../components/LandingPage";

const landingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: ROUTE_PATHS.landing,
  component: function LandingRoute() {
    useDocumentTitle("Soroban Verifier — Contract Source Verification Service");
    return <LandingPage />;
  },
});

export const landingRoutes = [landingRoute];
