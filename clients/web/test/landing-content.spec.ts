import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { githubRepoUrl } from "@/config/site";
import {
  audienceCards,
  audienceHead,
  closingCta,
  footerBlurb,
  heroCopy,
  pipelineHead,
  pipelineSample,
  pipelineStages,
  resultCards,
  resultHead,
  securityCapabilities,
  securityHead,
  trustModelHead,
  trustSignals,
  trustStripItems,
} from "@/features/landing/content";
import { footerColumns, operatorPointer } from "@/features/landing/navigation";
import type { SampleSpan } from "@/features/landing/content";

const sampleText = (sample: string | SampleSpan[] | undefined): string =>
  typeof sample === "string" ? sample : (sample ?? []).map((span) => span.text).join("");

const repoRoot = (() => {
  let dir = resolve(process.cwd());
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("no pnpm-workspace.yaml above " + process.cwd());
    dir = parent;
  }
  return dir;
})();

const allCopy = [
  heroCopy.title,
  ...heroCopy.lines,
  heroCopy.cta,
  ...Object.values(closingCta),
  footerBlurb,
  ...trustStripItems,
  ...[
    audienceHead,
    pipelineHead,
    resultHead,
    trustModelHead,
    securityHead,
  ].flatMap(({ label, title, description }) => [label, title, description]),
  ...audienceCards.flatMap((c) => [c.title, c.description, sampleText(c.sample), c.action.label]),
  ...pipelineStages.flatMap((s) => [s.title, s.description, sampleText(s.sample)]),
  ...Object.values(pipelineSample),
  ...trustSignals.flatMap((s) => [s.title, s.description, s.tag]),
  ...[...resultCards, ...securityCapabilities].flatMap((c) => [
    c.title,
    c.description,
    sampleText(c.sample),
  ]),
  ...footerColumns.flatMap((c) => [c.title, ...c.items.map((i) => i.label)]),
];

const sectionCopy = allCopy.filter(
  (line) => line !== operatorPointer.prefix && line !== operatorPointer.label,
);

const allHrefs = [
  ...audienceCards.map((c) =>
    c.action.kind === "route" ? c.action.to : c.action.href,
  ),
  ...footerColumns.flatMap((c) => c.items.map((i) => i.href)),
  operatorPointer.href,
];

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

test("no copy stands in for something unbuilt", () => {
  const placeholders = /coming soon|\bplanned\b|\bTBD\b|\bsoon\b/i;
  expect(allCopy.filter((line) => placeholders.test(line))).toEqual([]);
});

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

test.each(["docker compose", "compose file", "self-host", "run it locally", "local build"])(
  "no copy offers %s as a way to rebuild",
  (term) => {
    expect(sectionCopy.filter((line) => line.toLowerCase().includes(term))).toEqual([]);
  },
);

test("no copy promises that stored source is permanent", () => {
  const overclaims = /source[^.]*\b(permanent|forever|immutable|never removed)\b/i;
  expect(allCopy.filter((line) => overclaims.test(line))).toEqual([]);
});

test.each(["soroban-verify", "/v1/results", "npx @scvs", "scvs-cli"])(
  "no sample names %s, which does not exist",
  (term) => {
    expect(allCopy.filter((line) => line.toLowerCase().includes(term))).toEqual([]);
  },
);

test("every route-shaped sample is under a real API prefix", () => {
  const routes = allCopy.filter((line) => /^(GET|POST|PUT|DELETE) /.test(line));
  expect(routes.length).toBeGreaterThan(0);
  for (const route of routes) {
    expect(route).toMatch(/\s\/api\/(verification|query)\/v1\//);
  }
});
