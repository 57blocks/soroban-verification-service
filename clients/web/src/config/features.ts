declare global {
  interface Window {
    __SCVS_RUNTIME_CONFIG__?: { enableAggregator?: string };
  }
}

/** The substituted value, or `undefined` where nothing substituted it. */
const runtimeFlag = (key: keyof NonNullable<Window["__SCVS_RUNTIME_CONFIG__"]>): string | undefined => {
  const value = typeof window === "undefined" ? undefined : window.__SCVS_RUNTIME_CONFIG__?.[key];
  return value === undefined || value.startsWith("__") ? undefined : value;
};

export const isAggregatorEnabled = (): boolean =>
  (runtimeFlag("enableAggregator") ?? import.meta.env.VITE_ENABLE_AGGREGATOR) === "true";
