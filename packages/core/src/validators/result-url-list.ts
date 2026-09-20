import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";

const HEX_SHA256 = /^[0-9a-f]{64}$/;

/**
 * True for either form a `results_urls` item can take on the wire: a bare URI — the Registry API draft's
 * shape, which every document we published before 2026-09-10 carries — or `{type, url, location?, sha256?}`.
 *
 * `type` and `location` are checked for *shape* and not against `RESULT_URL_TYPES`/`RESULT_URL_LOCATIONS`:
 * both are closed sets for a producer and neither is for a reader, and `upgradeLegacyEntry` is what refuses
 * a vocabulary we cannot re-emit.
 */
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

/**
 * The consumer-side shape of `results_urls`. Refusing the bare string cost a peer — and our own
 * back-catalogue — its whole document, which is the failure the peer/producer split exists to prevent;
 * `toResultUrl` normalises an item before anything relays or re-emits it.
 */
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
