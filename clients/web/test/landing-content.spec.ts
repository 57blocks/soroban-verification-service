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

/** A card's sample as one string, whatever shape it is declared in. */
const sampleText = (sample: string | SampleSpan[] | undefined): string =>
  typeof sample === "string" ? sample : (sample ?? []).map((span) => span.text).join("");

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
  // The monospace strips on the cards and in the hero diagram: illustrative values, and the easiest place for
  // a claim nobody checked to arrive.
  ...Object.values(pipelineSample),
  ...trustSignals.flatMap((s) => [s.title, s.description, s.tag]),
  ...[...resultCards, ...securityCapabilities].flatMap((c) => [
    c.title,
    c.description,
    sampleText(c.sample),
  ]),
  ...footerColumns.flatMap((c) => [c.title, ...c.items.map((i) => i.label)]),
];

/** The page's own claims, without the footer pointer whose whole job is to name the self-hosting guide. */
const sectionCopy = allCopy.filter(
  (line) => line !== operatorPointer.prefix && line !== operatorPointer.label,
);

/** Every destination the page offers, from all three tables that hold one. */
const allHrefs = [
  ...audienceCards.map((c) =>
    c.action.kind === "route" ? c.action.to : c.action.href,
  ),
  ...footerColumns.flatMap((c) => c.items.map((i) => i.href)),
  operatorPointer.href,
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

/**
 * The self-host claim, gated rather than merely deleted. The page offered "one Compose file" as the way to run
 * a verifier; the compose file starts the services and not the rebuild, which always dispatches to AWS Batch
 * (ADR-003). Nothing on this page may offer a local or single-file build path again.
 */
test.each(["docker compose", "compose file", "self-host", "run it locally", "local build"])(
  "no copy offers %s as a way to rebuild",
  (term) => {
    expect(sectionCopy.filter((line) => line.toLowerCase().includes(term))).toEqual([]);
  },
);

/**
 * Durability, stated at the strength the service actually provides. Public source is no longer archived to
 * decentralized storage and this verifier's copy can be removed on a valid notice, so copy claiming source is
 * kept permanently or archived is wrong — the report's `source_sha256` is what survives either way.
 */
test("no copy promises that stored source is permanent", () => {
  const overclaims = /source[^.]*\b(permanent|forever|immutable|never removed)\b/i;
  expect(allCopy.filter((line) => overclaims.test(line))).toEqual([]);
});

/**
 * The illustrative samples are where an invented interface arrives: a design pass proposed a
 * `soroban-verify …` command and a `GET /v1/results?contract=…` route, and this service ships neither. A
 * sample may only name something that exists.
 */
test.each(["soroban-verify", "/v1/results", "npx @scvs", "scvs-cli"])(
  "no sample names %s, which does not exist",
  (term) => {
    expect(allCopy.filter((line) => line.toLowerCase().includes(term))).toEqual([]);
  },
);

/** An HTTP sample names a path this service actually serves. */
test("every route-shaped sample is under a real API prefix", () => {
  const routes = allCopy.filter((line) => /^(GET|POST|PUT|DELETE) /.test(line));
  expect(routes.length).toBeGreaterThan(0);
  for (const route of routes) {
    expect(route).toMatch(/\s\/api\/(verification|query)\/v1\//);
  }
});
