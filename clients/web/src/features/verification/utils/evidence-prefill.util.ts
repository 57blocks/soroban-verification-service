import type { VerifyFormValues } from "../types";

export const evidencePrefill = (fields?: Record<string, unknown>): Partial<VerifyFormValues> => {
  if (!fields) return {};
  const joinArgs = (value: unknown) =>
    typeof value === "string"
      ? value
      : Array.isArray(value)
        ? value.filter((item) => typeof item === "string").join(" ")
        : undefined;

  const next: Partial<VerifyFormValues> = {
    source_sha256: typeof fields.source_sha256 === "string" ? fields.source_sha256 : undefined,
    source_uri: typeof fields.source_uri === "string" ? fields.source_uri : undefined,
    bldarg: joinArgs(fields.bldarg),
    bldopt: joinArgs(fields.bldopt),
  };
  return Object.fromEntries(
    Object.entries(next).filter(([, value]) => value !== undefined),
  ) as Partial<VerifyFormValues>;
};
