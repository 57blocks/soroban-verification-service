import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";
import { HEX_SHA256 } from "../digest.js";

export function isSourceCodeUriItem(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (typeof item.location !== "string" || item.location.length === 0) return false;
  if (typeof item.url !== "string" || item.url.length === 0) return false;
  return item.sha256 === undefined || (typeof item.sha256 === "string" && HEX_SHA256.test(item.sha256));
}

@ValidatorConstraint({ name: "isSourceCodeUriList", async: false })
class IsSourceCodeUriListConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return Array.isArray(value) && value.every(isSourceCodeUriItem);
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be an array of URIs or {location, url, sha256?} entries`;
  }
}

export function IsSourceCodeUriList(validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: "isSourceCodeUriList",
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsSourceCodeUriListConstraint,
    });
  };
}
