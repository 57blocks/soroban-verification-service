import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildDifferentialLegs } from "./deviation-legs.js";
import { DEVIATIONS, FIXTURES, type Deviation, type DifferentialFixture } from "./fixtures.js";
import {
  BASELINE_ORACLE,
  ORACLES,
  missingOracleReason,
  resolveOracleImage,
  type Oracle,
} from "./oracles.js";
import { runDifferentialFixture as executeDifferentialFixture } from "./runner.js";

type ExpectedFailures = Record<string, { rules: string[]; reason: string }>;

const expectedFailures = JSON.parse(
  readFileSync(resolveExpectedFailuresPath(), "utf8"),
) as ExpectedFailures;

const differentialEnabled = process.env.SCVS_DIFFERENTIAL === "1";
const differentialTimeoutMs = 20 * 60_000;

const CROSS_ORACLE_FIXTURE_ID = "cli-legacy-single-package-current";

describe("differential fixture matrix", () => {
  it("has stable unique fixture ids", () => {
    const ids = FIXTURES.map((fixture) => fixture.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("points every fixture at committed sample source", () => {
    for (const fixture of FIXTURES) {
      expect(existsSync(fixture.sourceDir)).toBe(true);
    }
  });

  it("uses digest-pinned images only", () => {
    for (const fixture of FIXTURES) {
      expect(fixture.image).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
  });

  it("covers every supported differential build class", () => {
    expect(new Set(FIXTURES.map((fixture) => fixture.buildClass))).toEqual(new Set(["cli-legacy"]));
  });

  it("records known mismatches only for declared fixtures", () => {
    const fixtureIds = new Set(FIXTURES.map((fixture) => fixture.id));
    const oracleIds = new Set(ORACLES.map((oracle) => oracle.id));
    for (const [id, failure] of Object.entries(expectedFailures)) {
      const [fixtureId, oracleId] = id.split("@");
      expect(fixtureIds.has(fixtureId!)).toBe(true);
      if (oracleId !== undefined) expect(oracleIds.has(oracleId)).toBe(true);
      expect(failure.rules.length).toBeGreaterThan(0);
      expect(failure.reason.trim()).not.toBe("");
    }
  });

  it("has one BE7 fixture and one deviation-off leg for each deliberate deviation", () => {
    const fixtureByDeviation = new Map<Deviation, DifferentialFixture[]>(
      DEVIATIONS.map((deviation) => [deviation, []]),
    );

    for (const fixture of FIXTURES) {
      for (const deviation of fixture.deviationsUnderTest) {
        fixtureByDeviation.get(deviation)?.push(fixture);
      }
    }

    for (const deviation of DEVIATIONS) {
      const fixtures = fixtureByDeviation.get(deviation) ?? [];
      expect(fixtures.map((fixture) => fixture.id)).toHaveLength(1);
      expect(buildDifferentialLegs(fixtures[0]).filter((leg) => leg.kind === "deviation-off")).toEqual([
        expect.objectContaining({
          kind: "deviation-off",
          disabledDeviation: deviation,
          switch: { disable: deviation },
        }),
      ]);
    }
  });

  it("keeps the deviation-off switch out of production source", () => {
    expect(noProductionDeviationSwitch()).toBe(true);
  });

  it("keeps the pinned reference binary out of service runtime code", () => {
    expect(noRuntimeReferenceBinary()).toBe(true);
  });
});

describe("differential oracles", () => {
  it("has stable unique oracle ids", () => {
    const ids = ORACLES.map((oracle) => oracle.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9.-]+$/);
  });

  it("records a well-formed (cliver, rsver) beside every oracle", () => {
    for (const oracle of ORACLES) {
      expect(oracle.cliver).toMatch(/^\d+\.\d+\.\d+$/);
      expect(oracle.rsver).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("★ pins every committed oracle image by digest, never by tag", () => {
    for (const oracle of ORACLES.filter((candidate) => candidate.image)) {
      expect(oracle.image).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
  });

  it("gives every unpinned oracle an environment variable to supply it through", () => {
    for (const oracle of ORACLES.filter((candidate) => !candidate.image)) {
      expect(oracle.env).toMatch(/^SCVS_DIFFERENTIAL_ORACLE_[A-Z0-9_]+$/);
      expect(missingOracleReason(oracle)).toContain(oracle.tag);
    }
  });

  it("★ refuses a supplied reference that is not digest-pinned instead of using it", () => {
    // `image: undefined` matters: a plain spread keeps the digest and never exercises the refusal.
    const oracle: Oracle = {
      ...ORACLES[1]!,
      image: undefined,
      env: "SCVS_DIFFERENTIAL_ORACLE_SPEC_FIXTURE",
    };
    const previous = process.env[oracle.env!];
    try {
      process.env[oracle.env!] = "docker.io/stellar/stellar-cli:25.1.0";
      expect(resolveOracleImage(oracle)).toBeUndefined();
      expect(missingOracleReason(oracle)).toContain("not digest-pinned");
    } finally {
      if (previous === undefined) delete process.env[oracle.env!];
      else process.env[oracle.env!] = previous;
    }
  });

  it("names a fixture the cross-toolchain legs can actually re-run", () => {
    expect(FIXTURES.map((fixture) => fixture.id)).toContain(CROSS_ORACLE_FIXTURE_ID);
  });

  it("builds every committed fixture against the baseline oracle", () => {
    const baseline = resolveOracleImage(BASELINE_ORACLE);
    expect(baseline).toBeDefined();
    for (const fixture of FIXTURES) expect(fixture.image).toBe(baseline);
  });
});

const maybeDescribe = differentialEnabled ? describe : describe.skip;

maybeDescribe("differential harness", () => {
  it.each(FIXTURES)("$id matches the pinned reference or remains expected", async (fixture) => {
    const result = await runDifferentialFixture(fixture).catch((error: unknown) => ({
      matched: false,
      rules: fixture.rules,
      error: error instanceof Error ? error.message : String(error),
    }));
    const expected = expectedFailures[fixture.id];
    if (expected) {
      expect(result.matched).toBe(false);
      expect(result.rules.some((rule) => expected.rules.includes(rule))).toBe(true);
      return;
    }
    expect(result).toEqual(expect.objectContaining({
      matched: true,
      rules: fixture.rules,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
  }, differentialTimeoutMs);
});

maybeDescribe("differential harness — cross-toolchain", () => {
  for (const oracle of ORACLES.filter((candidate) => candidate.id !== BASELINE_ORACLE.id)) {
    const reason = missingOracleReason(oracle);
    const id = `${CROSS_ORACLE_FIXTURE_ID}@${oracle.id}`;
    const title = `${id} — ${oracle.cliver} / ${oracle.rsver}`;

    if (reason) {
      it.skip(`${title} · SKIPPED: ${reason}`, () => undefined);
      continue;
    }

    it(
      `${title} matches the official CLI in its own image`,
      async () => {
        const base = FIXTURES.find((candidate) => candidate.id === CROSS_ORACLE_FIXTURE_ID);
        if (!base) throw new Error(`No fixture named ${CROSS_ORACLE_FIXTURE_ID} to run cross-oracle.`);
        const fixture: DifferentialFixture = {
          ...base,
          id,
          image: resolveOracleImage(oracle)!,
        };
        const result = await runDifferentialFixture(fixture).catch((error: unknown) => ({
          matched: false,
          rules: fixture.rules,
          error: error instanceof Error ? error.message : String(error),
        }));

        const expected = expectedFailures[id];
        if (expected) {
          expect(result.matched).toBe(false);
          expect(result.rules.some((rule) => expected.rules.includes(rule))).toBe(true);
          return;
        }
        expect(result).toEqual(
          expect.objectContaining({ matched: true, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
        );
      },
      differentialTimeoutMs,
    );
  }
});

async function runDifferentialFixture(
  fixture: DifferentialFixture,
): Promise<{ matched: boolean; rules: string[]; error?: string }> {
  const legs = buildDifferentialLegs(fixture);
  if (fixture.deviationsUnderTest.length && legs.filter((leg) => leg.kind === "deviation-off").length === 0) {
    throw new Error(`BE7 fixture ${fixture.id} has no deviation-off leg.`);
  }
  return executeDifferentialFixture(fixture);
}

function resolveExpectedFailuresPath(): string {
  return join(repoRoot(), "services", "builder", "test", "differential", "expected-failures.json");
}

function noRuntimeReferenceBinary(): boolean {
  return !hasForbiddenSourceReference("docker/prebuilt/bin/stellar");
}

function noProductionDeviationSwitch(): boolean {
  return !hasForbiddenSourceReference("TestOnlyDeviationSwitch") &&
    !hasForbiddenSourceReference("deviation-off") &&
    !hasForbiddenSourceReference("deviationsUnderTest");
}

function hasForbiddenSourceReference(pattern: string): boolean {
  const root = join(repoRoot(), "services");
  if (!existsSync(root)) return false;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "dist" || entry.name === "node_modules") continue;
        stack.push(path);
        continue;
      }
      if (!entry.isFile() || !path.endsWith(".ts") || !path.includes(`${join("src")}`)) continue;
      if (readFileSync(path, "utf8").includes(pattern)) return true;
    }
  }
  return false;
}

function repoRoot(): string {
  let current = resolve(process.cwd());
  while (true) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error("Unable to locate repository root");
    current = parent;
  }
}
