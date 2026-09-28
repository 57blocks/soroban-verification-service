import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";

@ValidatorConstraint({ name: "presentOnlyWhen", async: false })
class PresentOnlyWhenConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const [predicate, , valueCheck] = args.constraints as PresentOnlyWhenConstraints;
    if (!predicate(args.object)) return value === undefined;
    if (value === undefined) return false;
    return valueCheck ? valueCheck(value) : true;
  }

  defaultMessage(args: ValidationArguments): string {
    const [predicate, description] = args.constraints as PresentOnlyWhenConstraints;
    return predicate(args.object)
      ? `${args.property} is required when ${description}, and must be well-formed`
      : `${args.property} must be omitted unless ${description}`;
  }
}

type PresentOnlyWhenConstraints = [
  (object: unknown) => boolean,
  string,
  ((value: unknown) => boolean) | undefined,
];

export function PresentOnlyWhen(
  predicate: (object: never) => boolean,
  description: string,
  valueCheck?: (value: unknown) => boolean,
  validationOptions?: ValidationOptions,
) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: "presentOnlyWhen",
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [predicate, description, valueCheck],
      validator: PresentOnlyWhenConstraint,
    });
  };
}
