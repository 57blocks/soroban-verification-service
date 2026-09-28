import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { AXIOS_INSTANCE } from "@scvs/verify-api-client";
import { getApiBase } from "./lib/http";
import { Toaster } from "./components/ui/sonner";
import { router } from "./app/router";
import "./fonts";
import "./index.css";

const build = document.querySelector<HTMLMetaElement>('meta[name="build"]')?.content;
if (build) console.info(`soroban-verify console, build ${build}`);

AXIOS_INSTANCE.defaults.baseURL = getApiBase();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
      {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
    </QueryClientProvider>
  </StrictMode>,
);
