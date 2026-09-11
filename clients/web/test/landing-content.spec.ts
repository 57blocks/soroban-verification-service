import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { githubRepoUrl } from "@/config/site";
import {
  architectureLayers,
  audienceCards,
  audienceHead,
  architectureHead,
  closingCta,
  footerBlurb,
  heroCopy,
  pipelineHead,
  pipelineStages,
  platformCapabilities,
  platformHead,
  securityCapabilities,
  securityHead,
  selfHostHead,
  selfHostModes,
  trustModelHead,
  trustSignals,
  trustStripItems,
} from "@/features/landing/content";
import { footerColumns } from "@/features/landing/navigation";

/** Walk up from the suite's working directory to the workspace root, whatever runs vitest. */
const repoRoot = (() => {
  let dir = resolve(process.cwd());
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("no pnpm-workspace.yaml above " + process.cwd());
    dir = parent;
  }
  return dir;
})();

/** Every string the landing page renders, flattened — the surface these assertions run over. */
const allCopy = [
  ...heroCopy.lines,
  heroCopy.cta,
  ...Object.values(closingCta),
  footerBlurb,
  ...trustStripItems,
  ...[
    audienceHead,
    pipelineHead,
    architectureHead,
    trustModelHead,
    platformHead,
    securityHead,
    selfHostHead,
  ].flatMap(({ label, title, description }) => [label, title, description]),
  ...audienceCards.flatMap((c) => [c.title, c.description, c.action.label]),
  ...pipelineStages.flatMap((s) => [s.title, s.description]),
  ...architectureLayers.flatMap((l) => [l.title, ...l.items]),
  ...trustSignals.flatMap((s) => [s.title, s.description, s.tag]),
  ...[...platformCapabilities, ...securityCapabilities].flatMap((c) => [
    c.title,
    c.description,
  ]),
  ...selfHostModes.flatMap((m) => [m.title, m.description, m.command]),
  ...footerColumns.flatMap((c) => [c.title, ...c.items.map((i) => i.label)]),
];

/** Every destination the page offers, from both tables that hold one. */
const allHrefs = [
  ...audienceCards.map((c) =>
    c.action.kind === "route" ? c.action.to : c.action.href,
  ),
  ...footerColumns.flatMap((c) => c.items.map((i) => i.href)),
];

/** A link into our own repository has to name a path that is in it. */
describe("every repository link names a path that exists", () => {
  const repoLinks = allHrefs.filter((href) => href.startsWith(githubRepoUrl));

  test("there are some, or this suite is asserting nothing", () => {
    expect(repoLinks.length).toBeGreaterThan(0);
  });

  test.each(repoLinks)("%s", (href) => {
    const path = href
      .slice(githubRepoUrl.length)
      .replace(/^\/(tree|blob)\/[^/]+\//, "");
    expect(existsSync(join(repoRoot, path))).toBe(true);
  });
});

/** The page states what runs, or nothing. */
test("no copy stands in for something unbuilt", () => {
  const placeholders = /coming soon|\bplanned\b|\bTBD\b|\bsoon\b/i;
  expect(allCopy.filter((line) => placeholders.test(line))).toEqual([]);
});

/**
 * Terms this page claimed and no code backs. The rest were features described in copy and never written: no
 * JSONL feed, no Helm chart, no Wrangler gateway, no seccomp/AppArmor profile.
 */
test.each([
  "edge gateway",
  "jsonl",
  "helm",
  "wrangler",
  "seccomp",
  "apparmor",
])("no copy claims %s", (term) => {
  const claiming = allCopy.filter((line) => line.toLowerCase().includes(term));
  expect(claiming).toEqual([]);
});
