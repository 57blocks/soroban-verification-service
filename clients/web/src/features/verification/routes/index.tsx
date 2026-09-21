import { createRoute, redirect } from "@tanstack/react-router";
import { rootRoute } from "@/app/root-route";
import { ROUTE_PATHS } from "@/app/route-paths";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { VerifyConsole } from "../components/VerifyConsole";

type VerifySearch = { job_id?: string; new?: string };

const verifyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: ROUTE_PATHS.verify,
  validateSearch: (search: Record<string, unknown>): VerifySearch => ({
    job_id: typeof search.job_id === "string" ? search.job_id : undefined,
    new: typeof search.new === "string" ? search.new : undefined,
  }),
  // Legacy `?job_id=` links land on the canonical job page instead.
  beforeLoad: ({ search }) => {
    if (search.job_id) {
      throw redirect({
        to: "/verify/jobs/$job_id",
        params: { job_id: search.job_id },
        replace: true,
      });
    }
  },
  component: function VerifyRoute() {
    useDocumentTitle("Submit Soroban Verification | Soroban Verifier");
    const { new: forceNewParam } = verifyRoute.useSearch();
    return <VerifyConsole mode="submit" forceNew={forceNewParam === "1"} />;
  },
});

const verifyJobRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: ROUTE_PATHS.verifyJob,
  component: function VerifyJobRoute() {
    useDocumentTitle("Verification Job | Soroban Verifier");
    const { job_id } = verifyJobRoute.useParams();
    return <VerifyConsole mode="job" initialJobId={job_id} />;
  },
});

export const verificationRoutes = [verifyRoute, verifyJobRoute];
