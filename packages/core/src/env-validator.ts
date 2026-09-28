import { flattenValidationErrors, safeParseDto } from "./validate.js";
import type { ClassConstructor, ValidationError } from "./validate.js";

export class EnvValidationError extends Error {
  constructor(
    message: string,
    public readonly errors: ValidationError[],
  ) {
    super(message);
    this.name = "EnvValidationError";
  }
}

export function createEnvValidator<T extends object>(
  dto: ClassConstructor<T>,
  serviceName: string,
): (config: Record<string, unknown>) => Record<string, unknown> {
  return (config) => {
    const result = safeParseDto(dto, config);
    if (result.success) return config;

    const issues = flattenValidationErrors(result.errors);
    const rendered = issues
      .map((issue) => `  - ${Object.values(issue.constraints).join("; ")}`)
      .join("\n");
    throw new EnvValidationError(
      `[${serviceName}] invalid environment — ${issues.length} problem(s):\n${rendered}\n` +
        `See the repository root .env.example.`,
      result.errors,
    );
  };
}
