/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `""` means same origin as this page; absent means the bundle was built unconfigured. */
  readonly VITE_VERIFY_API_URL?: string;
  readonly VITE_QUERY_API_URL?: string;
  readonly VITE_ENABLE_AGGREGATOR?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
