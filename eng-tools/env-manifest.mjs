/** `config/env-manifest.yaml`'s reader and resolver. */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export const MANIFEST_PATH = "config/env-manifest.yaml";

export function loadManifest(root = process.cwd()) {
  const path = join(root, MANIFEST_PATH);
  if (!existsSync(path)) {
    throw new Error(`${MANIFEST_PATH} not found — run this from the repository root.`);
  }
  return parse(readFileSync(path, "utf8"));
}

export const entriesOf = (block) => Object.entries(block ?? {});

export const observabilityOf = (entry) => entry?.observable ?? "presence";

export function effectiveVars(name, service, manifest, problems = []) {
  const allowed = new Map();
  const forbidden = new Set(service.forbidden ?? []);

  const absorb = (block, origin, group) => {
    for (const [varName, entry] of entriesOf(block)) {
      if (entry?.required === "forbidden") forbidden.add(varName);
      else allowed.set(varName, { ...entry, origin, group });
    }
  };

  for (const groupName of service.inherits ?? []) {
    const group = manifest.groups?.[groupName];
    if (!group) {
      problems.push(`service ${name} inherits unknown group "${groupName}"`);
      continue;
    }
    absorb(group.variables, `group:${groupName}`, groupName);
  }
  absorb(service.variables, name, undefined);
  absorb(service.tunables, name, undefined);
  absorb(service.build_variables, name, undefined);

  // Runs last: a per-service `forbidden` beats an inherited allow.
  for (const varName of forbidden) allowed.delete(varName);
  return { allowed, forbidden };
}

export function resolveManifest(manifest) {
  const problems = [];
  const services = Object.entries(manifest.services ?? {});
  const effective = new Map(
    services.map(([name, svc]) => [name, effectiveVars(name, svc, manifest, problems)])
  );

  const manifestNames = new Set();
  for (const group of Object.values(manifest.groups ?? {}))
    for (const [n] of entriesOf(group.variables)) manifestNames.add(n);
  for (const [, svc] of services)
    for (const block of [svc.variables, svc.tunables, svc.build_variables])
      for (const [n] of entriesOf(block)) manifestNames.add(n);

  const forbiddenOnly = new Set();
  for (const name of manifestNames) {
    const declaredAllowed = [...effective.values()].some(({ allowed }) => allowed.has(name));
    if (!declaredAllowed) forbiddenOnly.add(name);
  }

  return {
    manifest,
    services,
    effective,
    manifestNames,
    forbiddenOnly,
    retired: new Set(Object.keys(manifest.retired ?? {})),
    problems,
  };
}
