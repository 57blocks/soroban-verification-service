import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";
import { HEX_SHA256 } from "../digest.js";

/** True for either form a `verified_source_code_uris` item can take on the wire: a bare URI, or `{location, url, sha256?}`. */
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

/**
 * The consumer-side shape of `verified_source_code_uris`: a bare URI string is the only shape published before
 * `location` existed, and a peer may be on either.
 */
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
