import assert from "node:assert/strict";
import { repeatedBuildOption } from "./build-option-conflicts.js";

function test(name: string, fn: () => void): void {
  fn();
  console.log(`ok - ${name}`);
}

test("a second --package, in any spelling, is refused", () => {
  assert.match(repeatedBuildOption(["--package=alpha", "--package=beta"])!, /--package/);
  assert.match(repeatedBuildOption(["--package", "alpha", "-p", "beta"])!, /--package/);
});

test("each single-valued setting is refused when repeated", () => {
  for (const flag of ["--manifest-path", "--profile", "--out-dir"]) {
    assert.match(repeatedBuildOption([`${flag}=a`, "--release", `${flag}=b`])!, new RegExp(flag));
  }
});

test("the same --env name or --meta key twice is refused, different ones are not", () => {
  assert.match(repeatedBuildOption(["--env=A=1", "--env=A=2"])!, /--env A/);
  assert.match(repeatedBuildOption(["--meta=k=v1", "--meta=k=v2"])!, /--meta k/);
  assert.equal(repeatedBuildOption(["--env=A=1", "--env=B=2", "--meta=k=1", "--meta=j=2"]), undefined);
});

test("repeatable flags and an empty recipe pass", () => {
  assert.equal(repeatedBuildOption(["--features=a", "--features=b", "--locked"]), undefined);
  assert.equal(repeatedBuildOption(undefined), undefined);
});
