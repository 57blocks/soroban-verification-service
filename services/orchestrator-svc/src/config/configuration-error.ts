/** A required environment variable is absent — an operator's mistake, not a submission's. */
export class ConfigurationError extends Error {
  constructor(
    readonly envName: string,
    message: string,
  ) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/** `instanceof` on its own is not safe here. */
export function isConfigurationError(error: unknown): error is ConfigurationError {
  return (
    error instanceof ConfigurationError ||
    (error instanceof Error && error.name === "ConfigurationError" && "envName" in error)
  );
}
