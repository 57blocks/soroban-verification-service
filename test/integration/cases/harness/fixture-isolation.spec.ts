import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { fixtureInventoryPath, recipeScopeLabel, runScopedBldopt } from "../../support/fixtures.js";

// The same walk-up `packages/config`'s `findWorkspaceRoot` performs, re-derived here rather than
// imported: this suite is black-box and depends on no `@scvs/*` package. Anchoring on the marker
// instead of the checkout's directory name is what makes the assertion below hold from a `git
// worktree`, where the root is `<repo>/.claude/worktrees/<branch>` and the old literal never matched.
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

  // The label is where the isolation actually came from, and where it was lost: `currentTestName` is undefined
  // in `beforeAll`, so the old literal fallback gave every hook in a run one scope.
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
