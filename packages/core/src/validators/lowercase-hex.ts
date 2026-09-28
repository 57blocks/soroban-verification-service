import { Transform } from "class-transformer";

export function LowercaseHex(): PropertyDecorator {
  return Transform(({ value }) => (typeof value === "string" ? value.toLowerCase() : value));
}
