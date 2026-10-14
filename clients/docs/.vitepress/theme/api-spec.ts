const EXAMPLE_ORIGIN = "https://verifier.example.org";

/** Code samples name this deployment's own origin, so the same pages are right on every verifier. */
export const withThisOrigin = <T extends object>(spec: T): T => ({
  ...spec,
  servers: [{ url: typeof window === "undefined" ? EXAMPLE_ORIGIN : window.location.origin }],
});
