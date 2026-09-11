import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";

/**
 * Class-level replacement for the two `.superRefine()` calls the old Zod DTOs used ("need at least one of
 * contract_id/wasm_hash").
 */
@ValidatorConstraint({ name: "atLeastOneOf", async: false })
class AtLeastOneOfConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const [fields] = args.constraints as [string[]];
    const object = args.object as Record<string, unknown>;
    return fields.some((field) => object[field] !== undefined && object[field] !== "");
  }

  defaultMessage(args: ValidationArguments): string {
    const [fields] = args.constraints as [string[]];
    return `Either ${fields.join(" or ")} is required`;
  }
}

export function AtLeastOneOf(fields: string[], validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: "atLeastOneOf",
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [fields],
      validator: AtLeastOneOfConstraint,
    });
  };
}
