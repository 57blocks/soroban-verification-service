import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { fixtureInventoryPath, recipeScopeLabel, runScopedBldopt } from "../../support/fixtures.js";

// Not imported from @scvs/config: this suite depends on no @scvs/* package.
function workspaceRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("no pnpm-workspace.yaml above the spec file");
    dir = parent;
  }
  return dir;
}

describe("E2E harness fixture isolation", () => {
  it("resolves a configured run-local inventory from the repository root", () => {
    const relative = "artifacts/e2e-fixtures/perf-01/run/e2e-fixtures.json";

    expect(fixtureInventoryPath(relative)).toBe(join(workspaceRoot(), relative));
  });

  it("keeps the scope stable for repeated submissions in one test", () => {
    const first = runScopedBldopt(["--locked"], "run-a", "case-a", "F-LEG-1");
    const second = runScopedBldopt(["--locked"], "run-a", "case-a", "F-LEG-1");

    expect(second).toEqual(first);
  });

  it("changes the scope between tests and harness runs", () => {
    const baseline = runScopedBldopt([], "run-a", "case-a", "F-LEG-1");
    const anotherTest = runScopedBldopt([], "run-a", "case-b", "F-LEG-1");
    const anotherRun = runScopedBldopt([], "run-b", "case-a", "F-LEG-1");

    expect(anotherTest).not.toEqual(baseline);
    expect(anotherRun).not.toEqual(baseline);
  });

  it("falls back to the spec file when a hook has no test name", () => {
    expect(recipeScopeLabel({ currentTestName: "case-a", testPath: "/cases/arc/a.spec.ts" })).toBe("case-a");
    expect(recipeScopeLabel({ testPath: "/cases/arc/a.spec.ts" })).toBe("/cases/arc/a.spec.ts");
    expect(recipeScopeLabel({})).toBe("suite setup");
  });

  it("gives two spec files distinct hook scopes", () => {
    const arc = runScopedBldopt([], "run-a", recipeScopeLabel({ testPath: "/cases/arc/a.spec.ts" }), "F-LEG-1");
    const pub = runScopedBldopt([], "run-a", recipeScopeLabel({ testPath: "/cases/pub/b.spec.ts" }), "F-LEG-1");

    expect(arc).not.toEqual(pub);
  });

  it("replaces a caller-supplied scope instead of publishing duplicates", () => {
    const result = runScopedBldopt(
      ["--locked", "--env=SCVS_E2E_RECIPE_SCOPE=caller-value"],
      "run-a",
      "case-a",
      "F-LEG-1"
    );

    expect(result).toContain("--locked");
    expect(result.filter((entry) => entry.startsWith("--env=SCVS_E2E_RECIPE_SCOPE="))).toHaveLength(1);
    expect(result).not.toContain("--env=SCVS_E2E_RECIPE_SCOPE=caller-value");
  });
});
