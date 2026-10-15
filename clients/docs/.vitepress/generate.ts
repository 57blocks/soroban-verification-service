import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type ApiName, publicOperations, slugOf } from "./api-specs.ts";
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

/** Repository paths a page of this site covers, as site-root links: an include does not rewrite relative ones. */
const SITE_PAGES: Record<string, string> = {
  "docs/results-sep/": "/api/result-documents#the-results-sep",
};

const repoLink = (path: string): string | undefined =>
  SITE_PAGES[path] ?? (sourceIsPublic ? `${githubRepoUrl}/${path.endsWith("/") ? "tree" : "blob"}/main/${path}` : undefined);

const changelog = readFileSync(out("../../../CHANGELOG.md"), "utf8").replace(
  /\[([^\]]+)\]\(([^)]+)\)/g,
  (link, text: string, target: string) => {
    if (/^([a-z][a-z0-9+.-]*:|#)/i.test(target)) return link;
    const resolved = repoLink(target);
    return resolved ? `[${text}](${resolved})` : text;
  },
);
writeFileSync(out("generated/changelog.md"), changelog);
