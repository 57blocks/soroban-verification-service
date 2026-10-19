import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { type ApiName, publicOperations, slugOf } from "./api-specs.ts";
import { configReferenceMarkdown } from "./config-reference.ts";
import { failureCodesMarkdown } from "./failure-codes.ts";
import { githubRepoUrl, sourceIsPublic } from "../../web/src/config/site.ts";

const out = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

for (const api of ["submission", "query"] as ApiName[]) {
  const dir = out(`../src/api/${api}/`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const operation of publicOperations(api)) {
    writeFileSync(
      `${dir}${slugOf(operation.operationId)}.md`,
      [
        "---",
        "aside: false",
        "outline: false",
        "---",
        "",
        "<script setup>",
        `import raw from "@openapi/${api}";`,
        'import { withThisOrigin } from "../../../.vitepress/theme/api-spec";',
        "const spec = withThisOrigin(raw);",
        "</script>",
        "",
        `# ${operation.summary ?? `${operation.method} ${operation.path}`}`,
        "",
        operation.description ?? "",
        "",
        `<ApiOperation operation-id="${operation.operationId}" :spec="spec" />`,
        "",
      ].join("\n"),
    );
  }
}

mkdirSync(out("generated/"), { recursive: true });
writeFileSync(out("generated/failure-codes.md"), `${failureCodesMarkdown()}\n`);
writeFileSync(out("generated/configuration.md"), `${configReferenceMarkdown()}\n`);

/** Repository paths a page of this site covers, as site-root links: an include does not rewrite relative ones. */
const SITE_PAGES: Record<string, string> = {
  "docs/results-sep/": "/api/result-documents#the-results-sep",
  "docs/results-sep/sep-contract-verification-results.md": "/specifications/verification-results",
  "docs/results-sep/sep-contract-verification-aggregation.md": "/specifications/aggregation",
};

const repoLink = (path: string): string | undefined =>
  SITE_PAGES[path] ?? (sourceIsPublic ? `${githubRepoUrl}/${path.endsWith("/") ? "tree" : "blob"}/main/${path}` : undefined);

/** A repository file's Markdown, with each link to another repository file pointed at the site or GitHub. */
const withRepoLinks = (repoPath: string): string =>
  readFileSync(out(`../../../${repoPath}`), "utf8").replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (link, text: string, target: string) => {
      if (/^([a-z][a-z0-9+.-]*:|#)/i.test(target)) return link;
      const [path, fragment] = target.split("#");
      const resolved = repoLink(posix.normalize(posix.join(posix.dirname(repoPath), path)));
      if (!resolved) return text;
      return `[${text}](${resolved}${fragment && !resolved.includes("#") ? `#${fragment}` : ""})`;
    },
  );

writeFileSync(out("generated/changelog.md"), withRepoLinks("CHANGELOG.md"));

const SEP_NOTE = [
  "::: info A draft proposal",
  "This is a draft Stellar Ecosystem Proposal, written alongside this software, which implements it. It is",
  "reproduced here as it stands in the software's repository.",
  ":::",
].join("\n");

for (const [file, page] of [
  ["sep-contract-verification-results.md", "sep-verification-results.md"],
  ["sep-contract-verification-aggregation.md", "sep-aggregation.md"],
]) {
  const markdown = withRepoLinks(`docs/results-sep/${file}`).replace(/^(# .+)\n/, `$1\n\n${SEP_NOTE}\n`);
  writeFileSync(out(`generated/${page}`), markdown);
}
