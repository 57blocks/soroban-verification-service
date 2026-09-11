import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * All three are properties of what this package *can reach*, and all three fail the same way — not with a
 * broken test elsewhere, but silently, the next time someone adds a convenient import.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..");
const SRC = join(PACKAGE_ROOT, "src");

/** Anything that would hand this package a credential, a database, or a signing capability. */
const FORBIDDEN_DEPENDENCIES = [
  "@scvs/db",
  "@scvs/aws",
  "@scvs/storage-layout",
  "@aws-sdk/client-s3",
  "@aws-sdk/client-batch",
  "@aws-sdk/s3-request-presigner",
  "@prisma/client",
  "prisma",
  "arweave",
];

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      sourceFiles(path, found);
    } else if (entry.endsWith(".ts")) {
      found.push(path);
    }
  }
  return found;
}

function escapeRegExp(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function importSpecifierPattern(name: string): RegExp {
  return new RegExp(`from\\s+["']${escapeRegExp(name)}(?:/[^"']*)?["']`);
}

describe("TB1 — nothing here can reach the database, object storage, or a credential", () => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it.each(FORBIDDEN_DEPENDENCIES)("does not depend on %s", (name) => {
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain(name);
    // devDependencies too: a test-only AWS client still puts the SDK in the image's node_modules if anyone ever
    // builds this package without `--prod`, and it makes the forbidden import *available*.
    expect(Object.keys(manifest.devDependencies ?? {})).not.toContain(name);
  });

  it("imports none of them anywhere under src/", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const contents = readFileSync(file, "utf8");
      for (const name of FORBIDDEN_DEPENDENCIES) {
        // Match an import specifier, not a mention: every one of these names appears in prose in this package's
        // comments, which is exactly how a naive substring check would become useless noise.
        if (importSpecifierPattern(name).test(contents)) offenders.push(`${file.replace(PACKAGE_ROOT, "")} -> ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("importSpecifierPattern — the escape that TB1 depends on", () => {
  it("escapes every regex metacharacter, not just up to the first ]", () => {
    const name = "a+b(c)d?e.f*g";
    const pattern = importSpecifierPattern(name);
    expect(pattern.test(`import x from "${name}";`)).toBe(true);
    // Distinguishes a literal match from the metacharacters going unescaped and matching as operators instead.
    expect(pattern.test(`import x from "aXXbXcXdXeXfXXg";`)).toBe(false);
  });

  it("still ignores a prose mention", () => {
    const pattern = importSpecifierPattern("@scvs/db");
    expect(pattern.test("// this package never imports @scvs/db")).toBe(false);
  });
});

describe("TB2 — the only way bytes leave is a presigned PUT", () => {
  it("has exactly one module performing network writes, and it uses plain fetch", () => {
    const upload = readFileSync(join(SRC, "modules/builder/upload.ts"), "utf8");
    expect(upload).toContain('method: "PUT"');
    // No SDK, no signing: the URL arrives pre-signed on `BatchJobParams`, which is the whole point — a sandbox
    // that could sign its own requests could write anywhere the signer can.
    expect(upload).not.toMatch(/from\s+["']@aws-sdk/);
    expect(upload).not.toMatch(/from\s+["']@scvs\/aws/);
  });

  it("writes to the network from nowhere else", () => {
    const sanctioned = [
      "modules/builder/upload.ts",
      "modules/builder/fetch-source.ts",
      "modules/builder/job-params.ts",
    ];
    // The failure was benign only because the sanctioned list is asserted both ways.
    const EGRESS_CALLS = [/\bfetch\s*\(/, /\bcreateGuardedFetch\s*\(/];
    const callers = sourceFiles(SRC)
      .filter((file) => {
        const contents = readFileSync(file, "utf8");
        return EGRESS_CALLS.some((pattern) => pattern.test(contents));
      })
      .map((file) => file.slice(SRC.length + 1).split("\\").join("/"));

    // Both halves of the assertion matter.
    expect(callers.sort()).toEqual(sanctioned.sort());
  });
});

describe("S2, S19 — no business credential is even nameable here", () => {
  it("declares no credential-shaped variable in its env DTO", () => {
    const dto = readFileSync(join(SRC, "config/env.dto.ts"), "utf8");
    const declared = [...dto.matchAll(/^\s{2}([A-Z][A-Z0-9_]+)\??:/gm)].map((match) => match[1]);

    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) {
      expect(name).not.toMatch(/^AWS_/);
      expect(name).not.toMatch(/^POSTGRES_/);
      expect(name).not.toMatch(/(SECRET|PASSWORD|PRIVATE_KEY|CREDENTIAL|WALLET|TOKEN)/);
    }
  });
});
