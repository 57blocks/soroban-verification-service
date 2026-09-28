import {
  excerpt,
  redactAll,
  redactLocalPath,
  redactSecrets,
  summarizeGenericCommand,
} from "../src/modules/builder/redact.js";

describe("redactSecrets", () => {
  it("drops the query string of a presigned upload target", () => {
    const url =
      "https://scvs-staging.s3.us-east-1.amazonaws.com/staging/r1/build/rebuilt.wasm" +
      "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=ASIAEXAMPLE123456789%2F20260811" +
      "&X-Amz-Security-Token=FwoGZXIvYXdzEDMaDF" +
      "&X-Amz-Signature=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

    const redacted = redactSecrets(url);

    expect(redacted).not.toContain("X-Amz-Signature");
    expect(redacted).not.toContain("X-Amz-Security-Token");
    expect(redacted).not.toContain("ASIAEXAMPLE123456789");
    expect(redacted).toContain("scvs-staging.s3.us-east-1.amazonaws.com");
    expect(redacted).toContain("staging/r1/build/rebuilt.wasm");
  });

  it("drops userinfo, which is a credential in the authority component", () => {
    const redacted = redactSecrets("cloning https://someone:ghp_abcdef123456@github.com/o/r.git now");

    expect(redacted).not.toContain("ghp_abcdef123456");
    expect(redacted).not.toContain("someone:");
    expect(redacted).toContain("github.com/o/r.git");
  });

  it("catches bearer tokens, AWS keys and JWTs", () => {
    expect(redactSecrets("Authorization: Bearer sk-live-abc123")).not.toContain("sk-live-abc123");
    // Split across literals so secret scanners do not flag AWS's documented example key.
    expect(redactSecrets("key=" + "AKIAIOSFODNN7" + "EXAMPLE")).not.toContain("AKIAIOSFODNN7" + "EXAMPLE");
    expect(
      redactSecrets("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def"),
    ).toBe("<redacted-jwt>");
  });

  it("catches assignment-shaped secrets", () => {
    expect(redactSecrets("aws_secret_access_key=wJalrXUtnFEMI")).not.toContain("wJalrXUtnFEMI");
    expect(redactSecrets("API_KEY: 'hunter2'")).not.toContain("hunter2");
    expect(redactSecrets("password=hunter2")).not.toContain("hunter2");
  });

  it("leaves ordinary build output alone", () => {
    const output = "   Compiling soroban-sdk v22.0.0\n    Finished `release` profile in 41.20s";

    expect(redactSecrets(output)).toBe(output);
  });
});

describe("redactLocalPath", () => {
  it("takes a temp path whole, because its tail is the submitter's", () => {
    expect(redactLocalPath("/tmp/scvs-src-xyz/Cargo.toml")).toBe("/tmp/<redacted>");
    expect(redactLocalPath("/var/tmp/scvs-1/out")).toBe("/var/tmp/<redacted>");
  });

  it("covers the build fleet's temp paths, not only a developer's", () => {
    expect(redactLocalPath("/tmp/scvs-artifacts/download-x/evil-name.tar.gz")).not.toContain(
      "evil-name",
    );
    expect(redactLocalPath("/home/builder/work/src")).not.toContain("builder");
    expect(redactLocalPath("/Users/someone/src")).toBe("/Users/<redacted>/src");
  });

  it("takes /var/run, /mnt and /media whole", () => {
    expect(redactLocalPath("/var/run/docker.sock")).toBe("/var/run/<redacted>");
    expect(redactLocalPath("/mnt/data/scvs-artifacts/download-x/evil-name.tar.gz")).not.toContain(
      "evil-name",
    );
    expect(redactLocalPath("/media/scvs-1/out")).toBe("/media/<redacted>");
  });

  it("anchors /mnt and /media to a path start, unlike the other prefixes", () => {
    const url = "Downloaded asset from https://example.com/media/img.png";
    expect(redactLocalPath(url)).toBe(url);

    const submitterPath = "error in /workspace/photo-nft/media/upload.rs";
    expect(redactLocalPath(submitterPath)).toBe(submitterPath);

    expect(redactLocalPath("wrote to /mnt/data/out")).toBe("wrote to /mnt/<redacted>");
    expect(redactLocalPath("copied /media/scvs-1/out")).toBe("copied /media/<redacted>");
  });

  it("leaves /workspace alone — it is submitter content, not this service's own path", () => {
    const line = "error[E0433]: failed to resolve in /workspace/contract-b/src/lib.rs";
    expect(redactLocalPath(line)).toBe(line);
  });
});

describe("excerpt", () => {
  it("redacts, not merely truncates", () => {
    const captured =
      "uploading to https://bucket.s3.amazonaws.com/o?X-Amz-Signature=deadbeef\n" +
      "from /tmp/scvs-build-abc/out";

    const result = excerpt(captured);

    expect(result).toBeDefined();
    expect(result).not.toContain("deadbeef");
    expect(result).not.toContain("scvs-build-abc");
  });

  it("still truncates, and still reports empty input as undefined", () => {
    expect(excerpt("")).toBeUndefined();
    expect(excerpt("   \n ")).toBeUndefined();
    const long = excerpt("x".repeat(4000));
    expect(long).toContain("... truncated ...");
    expect(long!.length).toBeLessThan(4000);
  });
});

describe("summarizeGenericCommand", () => {
  it("redacts a presigned URL sitting in an argv", () => {
    const summary = summarizeGenericCommand([
      "curl", "-T", "/tmp/scvs-build-1/out/rebuilt.wasm",
      "https://bucket.s3.amazonaws.com/k?X-Amz-Signature=deadbeef",
    ]);

    expect(summary).not.toContain("deadbeef");
    expect(summary).not.toContain("scvs-build-1");
  });
});

describe("redaction is bounded", () => {
  const PAYLOADS: [string, string][] = [
    ["url-shaped", "a.b-c+d".repeat(150_000)],
    ["jwt-shaped", "-eyJ".repeat(131_072)],
    ["mixed", `${"a.".repeat(65_536)}${"-eyJ".repeat(20_000)}`],
  ];

  it.each(PAYLOADS)("bounds %s input before any regex sees it", (_name, payload) => {
    expect(redactAll(payload + payload)).toBe(redactAll(payload));
    expect(redactAll(payload, 1_024)).toBe(redactAll(payload.slice(0, 1_024), 1_024));
  });

  /** Generous: catastrophic backtracking costs orders of magnitude, and CI's parallel load puts the bounded jwt case near 2 s. */
  const budgetMs = 15_000;

  it.each(PAYLOADS)("survives %s output an attacker sized", (_name, payload) => {
    const started = Date.now();
    excerpt(payload);
    expect(Date.now() - started).toBeLessThan(budgetMs);
  });
});

describe("redactSecrets — cases the first cut missed", () => {
  it("does not fabricate a query marker on a URL that had none", () => {
    const line = "Downloaded soroban-sdk from https://static.crates.io/api/v1/crates/x/download";

    expect(redactSecrets(line)).toBe(line);
  });

  it("keeps what follows a URL on the same line", () => {
    expect(redactSecrets('{"url":"https://h/k?sig=abc","note":"keepme"}')).toBe(
      '{"url":"https://h/k?<redacted>","note":"keepme"}',
    );
  });

  it("redacts a fragment, not only a query string", () => {
    expect(redactSecrets("https://bucket/k#X-Amz-Signature=deadbeefsecret")).not.toContain(
      "deadbeefsecret",
    );
  });

  it("redacts underscore-prefixed secret names", () => {
    expect(redactSecrets("GITHUB_TOKEN=ghp_abcdef1234567890")).not.toContain("ghp_abcdef1234567890");
    expect(redactSecrets("AWS_SESSION_TOKEN=FwoGZXIvYXdzEDMaDF")).not.toContain("FwoGZXIvYXdz");
  });

  it("leaves a URL inside backticks intact apart from its secrets", () => {
    expect(redactSecrets("failed to fetch `https://github.com/o/r.git`")).toBe(
      "failed to fetch `https://github.com/o/r.git`",
    );
  });
});

describe("redactSecrets — internal identifiers", () => {
  it("redacts the single-segment ECR token the three-segment JWT rule cannot see", () => {
    const token = "eyJwYXlsb2FkIjoi" + "NjJPckluSklCUkppRTlrY1JVbkhrQXpoR0lWMEQzS3NWMzF2bnhmTng1SE5sY1VM".repeat(8);

    expect(redactSecrets(token)).toBe("<redacted-ecr-token>");
  });

  it("keeps the ECR registry host and repo while removing the account id", () => {
    const line =
      "Pulling from 123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/sv-dev-composed-environments@sha256:abcd";

    const redacted = redactSecrets(line);

    expect(redacted).not.toContain("123456789012");
    expect(redacted).toContain("<redacted-aws-account>.dkr.ecr.ap-southeast-2.amazonaws.com");
    expect(redacted).toContain("sv-dev-composed-environments");
  });

  it("redacts ECS task names but leaves the short public ecs-agent image alone", () => {
    expect(redactSecrets("ecs-scvs-builder-dev-10-runner-bae1b39dc196fffb2300")).toBe("<redacted-ecs-name>");
    expect(redactSecrets("amazon/amazon-ecs-agent:latest")).toBe("amazon/amazon-ecs-agent:latest");
  });

  it("redacts the value of an internal SCVS_ environment assignment, keeping the name", () => {
    expect(redactSecrets("SCVS_E2E_RECIPE_SCOPE=780b281a50f9bcb8e24feb3a")).toBe(
      "SCVS_E2E_RECIPE_SCOPE=<redacted>",
    );
    expect(redactSecrets("--env=SCVS_E2E_RECIPE_SCOPE=780b281a50f9bcb8e24feb3a")).toContain(
      "SCVS_E2E_RECIPE_SCOPE=<redacted>",
    );
  });

  it("leaves a submitter's own environment assignments and wasm hashes alone", () => {
    expect(redactSecrets("--env=MY_PUBLIC_FLAG=keepme")).toBe("--env=MY_PUBLIC_FLAG=keepme");
    expect(
      redactSecrets("Wasm Hash: 8ecd1857496df2c15aaab4d18d2d7689542a62814245e9b2c613c609b86bd11c"),
    ).toContain("8ecd1857496df2c15aaab4d18d2d7689542a62814245e9b2c613c609b86bd11c");
  });
});

describe("redactAll", () => {
  it("applies both, in either order of appearance", () => {
    const value = "wrote /tmp/scvs-x/f and posted https://h/p?sig=abc";

    const redacted = redactAll(value);

    expect(redacted).not.toContain("scvs-x");
    expect(redacted).not.toContain("sig=abc");
  });
});
