import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";
import { HEX_SHA256 } from "../digest.js";

/** Shape only: `type`/`location` are not checked against the producer vocabularies. */
export function isResultUrlItem(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (typeof item.type !== "string" || item.type.length === 0) return false;
  if (typeof item.url !== "string" || item.url.length === 0) return false;
  if (item.location !== undefined && (typeof item.location !== "string" || item.location.length === 0)) {
    return false;
  }
  return item.sha256 === undefined || (typeof item.sha256 === "string" && HEX_SHA256.test(item.sha256));
}

@ValidatorConstraint({ name: "isResultUrlList", async: false })
class IsResultUrlListConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return Array.isArray(value) && value.every(isResultUrlItem);
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be an array of URIs or {type, url, location?, sha256?} entries`;
  }
}

export function IsResultUrlList(validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: "isResultUrlList",
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsResultUrlListConstraint,
    });
  };
}
