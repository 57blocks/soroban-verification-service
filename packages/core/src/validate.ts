import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validateSync, type ValidationError } from "class-validator";

export type { ValidationError };

export type ClassConstructor<T> = new (...args: unknown[]) => T;

export class DtoValidationError extends Error {
  constructor(public readonly errors: ValidationError[]) {
    super(
      errors
        .flatMap((error) => Object.values(error.constraints ?? {}))
        .join("; ") || "Validation failed",
    );
    this.name = "DtoValidationError";
  }
}

export function parseDto<T extends object>(cls: ClassConstructor<T>, value: unknown): T {
  const instance = plainToInstance(cls, value);
  const errors = validateSync(instance as object, { forbidUnknownValues: false });
  if (errors.length > 0) throw new DtoValidationError(errors);
  return instance;
}

export function safeParseDto<T extends object>(
  cls: ClassConstructor<T>,
  value: unknown,
): { success: true; data: T } | { success: false; errors: ValidationError[] } {
  const instance = plainToInstance(cls, value);
  const errors = validateSync(instance as object, { forbidUnknownValues: false });
  return errors.length > 0 ? { success: false, errors } : { success: true, data: instance };
}

export type FlatValidationIssue = { property: string; constraints: Record<string, string> };

export function flattenValidationErrors(errors: ValidationError[], prefix = ""): FlatValidationIssue[] {
  const flat: FlatValidationIssue[] = [];
  for (const error of errors) {
    const property = prefix ? `${prefix}.${error.property}` : error.property;
    if (error.constraints) flat.push({ property, constraints: error.constraints });
    if (error.children?.length) flat.push(...flattenValidationErrors(error.children, property));
  }
  return flat;
}

export function createEnumGuard<T extends string>(values: readonly T[]) {
  const set = new Set<string>(values);
  return (value: unknown): value is T => typeof value === "string" && set.has(value);
}

export function createEnumAssert<T extends string>(values: readonly T[], label: string) {
  const guard = createEnumGuard(values);
  return (value: unknown): T => {
    if (!guard(value)) {
      throw new DtoValidationError([
        {
          target: undefined,
          property: label,
          value,
          constraints: { isIn: `${label} must be one of: ${values.join(", ")}` },
        } as ValidationError,
      ]);
    }
    return value;
  };
}
