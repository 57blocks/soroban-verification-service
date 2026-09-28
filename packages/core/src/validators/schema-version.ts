import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";

@ValidatorConstraint({ name: "supportedSchemaMajor", async: false })
class SupportedSchemaMajorConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const [major] = args.constraints as [number];
    return parseSchemaVersion(value)?.major === major;
  }

  defaultMessage(args: ValidationArguments): string {
    const [major] = args.constraints as [number];
    return `${args.property} must be a MAJOR.MINOR version with MAJOR ${major}; any MINOR is accepted`;
  }
}

export function parseSchemaVersion(value: unknown): { major: number; minor: number } | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (match === null) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

export function SupportedSchemaMajor(major: number, validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: "supportedSchemaMajor",
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [major],
      validator: SupportedSchemaMajorConstraint,
    });
  };
}
