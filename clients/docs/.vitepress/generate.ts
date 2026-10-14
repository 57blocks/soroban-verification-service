import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type ApiName, publicOperations, slugOf } from "./api-specs.ts";
import { failureCodesMarkdown } from "./failure-codes.ts";

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
