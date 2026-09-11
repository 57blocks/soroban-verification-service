import { Transform } from "class-transformer";

/** Lowercases a hex string on the way in — a `class-transformer` transform, deliberately, not a validator. */
export function LowercaseHex(): PropertyDecorator {
  return Transform(({ value }) => (typeof value === "string" ? value.toLowerCase() : value));
}
