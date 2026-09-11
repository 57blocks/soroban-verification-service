/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * The API origin, no `/v1` suffix. `""` means "same origin as this page" and is what deployed
   * builds use — see `src/lib/http.ts`. Absent means the bundle was built unconfigured, which the
   * console reports as an error rather than guessing.
   */
  readonly VITE_VERIFY_API_URL?: string;
  /**
   * The query API's origin, used only by the aggregator page. `""` — the default, and what
   * every deployed environment uses — means "same origin as this page". Set it in development,
   * where query-svc is a separate port from verification-svc.
   */
  readonly VITE_QUERY_API_URL?: string;
  /**
   * `"true"` enables the aggregator (`/query`) in a **local** build. Containers do not
   * use this: they read `SCVS_ENABLE_AGGREGATOR` from the environment at start-up, which
   * `src/config/features.ts` prefers over this value. Unset leaves the route unreachable.
   */
  readonly VITE_ENABLE_AGGREGATOR?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
