/** Asserts an installed SDK tree's declarations resolve for a consumer outside the workspace. */
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function binaryIn(dirs, tool) {
  for (const dir of dirs) {
    const path = join(dir, "node_modules", ".bin", tool);
    if (existsSync(path)) return path;
  }
  return null;
}

export function typecheckInstalledDeclarations({ consumerDir, packageName, tsc, diagnose, run }) {
  if (!tsc) return "no `tsc` binary in this checkout, so the declarations were never typechecked";

  writeFileSync(
    join(consumerDir, "consumer.ts"),
    [
      `import * as sdk from "${packageName}";`,
      `type Client = ReturnType<typeof sdk.newClient>;`,
      `type Status = ReturnType<typeof sdk.validateStatusObject>;`,
      `export type Verifications = Status["source_code_verifications"];`,
      `export const registryOf = (client: Client) => client.registry;`,
    ].join("\n"),
  );
  writeFileSync(
    join(consumerDir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "nodenext",
        moduleResolution: "nodenext",
        target: "es2022",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: [],
      },
      files: ["consumer.ts"],
    }),
  );

  try {
    run(tsc, ["--project", "tsconfig.json"], consumerDir);
    return null;
  } catch (error) {
    return `a TypeScript consumer does not compile against the installed declarations: ${diagnose(error)}`;
  }
}
