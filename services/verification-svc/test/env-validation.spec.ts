import { createEnvValidator, EnvValidationError } from "@scvs/core";
import { VerificationSvcEnvDto } from "../src/config/env.dto.js";

const validate = createEnvValidator(VerificationSvcEnvDto, "verification-svc");

const KEY = {
  SCVS_ABUSE_FINGERPRINT_KEY: "any-non-empty-value",
  SCVS_LEGAL_DOCUMENTS_SOURCE: "config/legal-documents.example.json",
};

describe("createEnvValidator", () => {
  it("returns the raw object unchanged, not a transformed instance", () => {
    const raw = { ...KEY, PORT: "5000", UNRELATED_SHELL_VAR: "keep me" };
    expect(validate(raw)).toBe(raw);
  });

  it("ignores variables the DTO does not declare", () => {
    expect(() => validate({ ...KEY, HOME: "/root", LANG: "en_US.UTF-8" })).not.toThrow();
  });

  it("rejects a malformed number instead of silently falling back to its default", () => {
    expect(() => validate({ ...KEY, SCVS_JOB_MAX_WAIT_MS: "abc" })).toThrow(
      /SCVS_JOB_MAX_WAIT_MS must be a number/,
    );
  });

  describe("the result-storage backend", () => {
    it("rejects a kind no backend implements", () => {
      expect(() => validate({ ...KEY, SCVS_PUBLISHER_STORAGE: "gcs" })).toThrow(
        /SCVS_PUBLISHER_STORAGE must be one of: filesystem, s3, r2/,
      );
    });

    it("requires a bucket when the kind is an object store", () => {
      expect(() => validate({ ...KEY, SCVS_PUBLISHER_STORAGE: "s3" })).toThrow(
        /SCVS_PUBLISHER_BUCKET is required/,
      );
      expect(() => validate({ ...KEY, SCVS_PUBLISHER_STORAGE: "r2" })).toThrow(
        /SCVS_PUBLISHER_BUCKET is required/,
      );
    });

    it("accepts an object store that names one", () => {
      expect(() =>
        validate({ ...KEY, SCVS_PUBLISHER_STORAGE: "s3", SCVS_PUBLISHER_BUCKET: "example-dev-results" }),
      ).not.toThrow();
    });

    it("asks for no bucket on filesystem", () => {
      expect(() => validate({ ...KEY })).not.toThrow();
      expect(() => validate({ ...KEY, SCVS_PUBLISHER_STORAGE: "filesystem" })).not.toThrow();
    });

    it("still rejects an empty bucket alongside filesystem", () => {
      expect(() => validate({ ...KEY, SCVS_PUBLISHER_BUCKET: "" })).toThrow(/SCVS_PUBLISHER_BUCKET/);
    });
  });

  describe("the HTTP server deadlines", () => {
    it.each([
      "SCVS_REQUEST_TIMEOUT_MS",
      "SCVS_HEADERS_TIMEOUT_MS",
      "SCVS_KEEPALIVE_TIMEOUT_MS",
    ])("rejects %s=0 rather than reading it as Node's \"no deadline\"", (name) => {
      expect(() => validate({ ...KEY, [name]: "0" })).toThrow(
        new RegExp(`${name} must be a positive number of milliseconds`),
      );
    });

    it.each([
      "SCVS_REQUEST_TIMEOUT_MS",
      "SCVS_HEADERS_TIMEOUT_MS",
      "SCVS_KEEPALIVE_TIMEOUT_MS",
    ])("rejects a negative or non-numeric %s", (name) => {
      expect(() => validate({ ...KEY, [name]: "-1" })).toThrow();
      expect(() => validate({ ...KEY, [name]: "abc" })).toThrow();
    });

    it("accepts the three set together to positive values", () => {
      expect(() =>
        validate({
          ...KEY,
          SCVS_REQUEST_TIMEOUT_MS: "120000",
          SCVS_HEADERS_TIMEOUT_MS: "70000",
          SCVS_KEEPALIVE_TIMEOUT_MS: "65000",
        }),
      ).not.toThrow();
    });

    it("leaves the ordering between them to applyHttpServerTimeouts, not this gate", () => {
      expect(() =>
        validate({ ...KEY, SCVS_HEADERS_TIMEOUT_MS: "1", SCVS_KEEPALIVE_TIMEOUT_MS: "65000" }),
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

  it("refuses an environment with no abuse fingerprint key, rather than defaulting one", () => {
    expect(() => validate({})).toThrow(/SCVS_ABUSE_FINGERPRINT_KEY must be set/);
    expect(() => validate({ SCVS_ABUSE_FINGERPRINT_KEY: "" })).toThrow(
      /SCVS_ABUSE_FINGERPRINT_KEY must be set/,
    );
  });
});
