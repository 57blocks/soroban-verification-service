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
import { buildStampPlugin } from "./build-stamp";

const envDir = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDir);
  const proxy = devProxyServerConfig(resolveDevProxy(env));

  const ignored = ignoredEnvFileWarning(
    fileURLToPath(new URL(".", import.meta.url)),
    envDir,
    existsSync,
  );
  if (ignored) console.warn(ignored);

  return {
    plugins: [react(), spaRoutesPlugin(), buildStampPlugin()],
    envDir,
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
      // A second react-query copy is a second context: every generated hook throws "No QueryClient set".
      dedupe: ["@tanstack/react-query", "react", "react-dom", "axios"],
    },
    server: {
      port: process.env.PORT ? Number(process.env.PORT) : 5173,
      ...(proxy ? { proxy } : {}),
    },
  };
});
