import { createEnvValidator, EnvValidationError } from "@scvs/core";
import { VerificationSvcEnvDto } from "../src/config/env.dto.js";

/** Guards the boot-time environment gate. */
const validate = createEnvValidator(VerificationSvcEnvDto, "verification-svc");

/**
 * The two variables this service cannot default. An empty HMAC key is the reversible unsalted hash the
 * fingerprint replaced; an absent legal bundle means the console would take submissions while showing
 * nobody any terms. Both are boot failures rather than fallbacks, and cases about *other* variables carry
 * them so they fail for their own reason.
 */
const KEY = {
  SCVS_ABUSE_FINGERPRINT_KEY: "any-non-empty-value",
  SCVS_LEGAL_DOCUMENTS_SOURCE: "config/legal-documents.example.json",
};

describe("createEnvValidator", () => {
  it("returns the raw object unchanged, not a transformed instance", () => {
    // @nestjs/config assigns whatever `validate` returns back onto process.env, so returning a
    // class-transformer instance would write coerced values and drop every undeclared key.
    const raw = { ...KEY, PORT: "5000", UNRELATED_SHELL_VAR: "keep me" };
    expect(validate(raw)).toBe(raw);
  });

  it("ignores variables the DTO does not declare", () => {
    // process.env carries the whole shell; only declared keys are the contract.
    expect(() => validate({ ...KEY, HOME: "/root", LANG: "en_US.UTF-8" })).not.toThrow();
  });

  it("rejects a malformed number instead of silently falling back to its default", () => {
    // `numberEnv()` cannot tell "abc" from an unset variable — before this gate, SCVS_JOB_MAX_WAIT_MS=abc
    // quietly became one hour.
    expect(() => validate({ ...KEY, SCVS_JOB_MAX_WAIT_MS: "abc" })).toThrow(
      /SCVS_JOB_MAX_WAIT_MS must be a number/,
    );
  });

  // The three HTTP deadlines are declared on SharedEnvDto, so every service that extends it inherits these
  // rules; verification-svc's validator is where they are exercised.
  describe("the HTTP server deadlines", () => {
    it.each([
      "SCVS_HTTP_REQUEST_TIMEOUT_MS",
      "SCVS_HTTP_HEADERS_TIMEOUT_MS",
      "SCVS_HTTP_KEEP_ALIVE_TIMEOUT_MS",
    ])("rejects %s=0 rather than reading it as Node's \"no deadline\"", (name) => {
      // A `0` is the exact fail-open rule 32 removes: it would boot clean and hold connections forever.
      expect(() => validate({ ...KEY, [name]: "0" })).toThrow(
        new RegExp(`${name} must be a positive number of milliseconds`),
      );
    });

    it.each([
      "SCVS_HTTP_REQUEST_TIMEOUT_MS",
      "SCVS_HTTP_HEADERS_TIMEOUT_MS",
      "SCVS_HTTP_KEEP_ALIVE_TIMEOUT_MS",
    ])("rejects a negative or non-numeric %s", (name) => {
      expect(() => validate({ ...KEY, [name]: "-1" })).toThrow();
      expect(() => validate({ ...KEY, [name]: "abc" })).toThrow();
    });

    it("accepts the three set together to positive values", () => {
      expect(() =>
        validate({
          ...KEY,
          SCVS_HTTP_REQUEST_TIMEOUT_MS: "120000",
          SCVS_HTTP_HEADERS_TIMEOUT_MS: "70000",
          SCVS_HTTP_KEEP_ALIVE_TIMEOUT_MS: "65000",
        }),
      ).not.toThrow();
    });

    it("leaves the ordering between them to applyHttpServerTimeouts, not this gate", () => {
      // An inverted pair is individually well-formed, so the DTO passes it and the boot-time helper is what
      // refuses it. Asserting that here keeps the split deliberate rather than an oversight.
      expect(() =>
        validate({ ...KEY, SCVS_HTTP_HEADERS_TIMEOUT_MS: "1", SCVS_HTTP_KEEP_ALIVE_TIMEOUT_MS: "65000" }),
      ).not.toThrow();
    });
  });

  it("reports every problem at once, not just the first", () => {
    try {
      validate({ ...KEY, PORT: "x", SCVS_ABUSE_WINDOW_MS: "y", SCVS_JOB_MAX_WAIT_MS: "z" });
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const message = (error as EnvValidationError).message;
      expect(message).toContain("3 problem(s)");
      expect(message).toContain("PORT must be a number");
      expect(message).toContain("SCVS_ABUSE_WINDOW_MS must be a number");
      expect(message).toContain("SCVS_JOB_MAX_WAIT_MS must be a number");
      expect((error as EnvValidationError).errors).toHaveLength(3);
    }
  });

  it("accepts an environment with none of the optional variables set", () => {
    // Every other variable this service reads has a default — the Postgres requirement belongs to DbModule's
    // factory, not this gate.
    expect(() => validate(KEY)).not.toThrow();
  });

  it("refuses an environment with no legal-documents source, rather than serving no terms", () => {
    expect(() => validate({ SCVS_ABUSE_FINGERPRINT_KEY: "k" })).toThrow(
      /SCVS_LEGAL_DOCUMENTS_SOURCE must be set/,
    );
    expect(() =>
      validate({ SCVS_ABUSE_FINGERPRINT_KEY: "k", SCVS_LEGAL_DOCUMENTS_SOURCE: "" }),
    ).toThrow(/SCVS_LEGAL_DOCUMENTS_SOURCE must be set/);
  });

  // Relaxing either of these to satisfy a process that needs neither would remove the guarantee from every
  // process that does; `openapi-placeholder-env.ts` is how the OpenAPI generator gets past them instead.
  it("refuses an environment with no abuse fingerprint key, rather than defaulting one", () => {
    expect(() => validate({})).toThrow(/SCVS_ABUSE_FINGERPRINT_KEY must be set/);
    expect(() => validate({ SCVS_ABUSE_FINGERPRINT_KEY: "" })).toThrow(
      /SCVS_ABUSE_FINGERPRINT_KEY must be set/,
    );
  });
});
