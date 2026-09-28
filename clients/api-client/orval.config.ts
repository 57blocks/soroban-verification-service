import { defineConfig } from "orval";

export default defineConfig({
  verifyApi: {
    input: {
      target: "../../services/verification-svc/openapi.json",
    },
    output: {
      mode: "single",
      target: "./src/generated/verify-api.ts",
      client: "react-query",
      httpClient: "axios",
      clean: true,
      // Emits `in: header` parameters (getBuildLog's x-build-log-token); orval omits them by default.
      headers: true,
      override: {
        mutator: {
          path: "./src/http.ts",
          name: "verifyApiClient",
        },
      },
    },
  },
});
