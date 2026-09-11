import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import {
  devProxyServerConfig,
  ignoredEnvFileWarning,
  resolveDevProxy,
} from "./dev-proxy";
import { spaRoutesPlugin } from "./spa-routes";

// The repository has exactly one `.env`, at the root, read by every service (AGENTS.md).
const envDir = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig(({ mode }) => {
  // Read through `loadEnv` rather than `process.env` so `VITE_DEV_API_PROXY` lives in the same root
  // `.env.local` as the other `VITE_*` variables.
  const env = loadEnv(mode, envDir);
  const proxy = devProxyServerConfig(resolveDevProxy(env));

  const ignored = ignoredEnvFileWarning(
    fileURLToPath(new URL(".", import.meta.url)),
    envDir,
    existsSync,
  );
  if (ignored) console.warn(ignored);

  return {
    plugins: [react(), spaRoutesPlugin()],
    envDir,
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
      // `@scvs/verify-api-client` resolves these from its own `node_modules`, and a second copy of
      // react-query in the bundle is a second context: every generated hook throws "No QueryClient set".
      dedupe: ["@tanstack/react-query", "react", "react-dom", "axios"],
    },
    server: {
      port: process.env.PORT ? Number(process.env.PORT) : 5173,
      ...(proxy ? { proxy } : {}),
    },
  };
});
