import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";

/** Put it on an always-present, non-array property: a custom validator on an array derives `$ref: Array`. */
@ValidatorConstraint({ name: "closedTo", async: false })
class ClosedToConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    return extraKeys(args).length === 0;
  }

  defaultMessage(args: ValidationArguments): string {
    const [, keys, description] = args.constraints as ClosedToConstraints;
    return `when ${description} the object carries exactly ${keys.join(" and ")} — remove ${extraKeys(args).join(", ")}`;
  }
}

function extraKeys(args: ValidationArguments): string[] {
  const [predicate, keys] = args.constraints as ClosedToConstraints;
  const object = args.object as Record<string, unknown>;
  if (!predicate(object)) return [];
  return Object.keys(object).filter((key) => !keys.includes(key) && object[key] !== undefined);
}

type ClosedToConstraints = [(object: unknown) => boolean, readonly string[], string];

export function ClosedTo(
  predicate: (object: never) => boolean,
  keys: readonly string[],
  description: string,
  validationOptions?: ValidationOptions,
) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: "closedTo",
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [predicate, keys, description],
      validator: ClosedToConstraint,
    });
  };
}
