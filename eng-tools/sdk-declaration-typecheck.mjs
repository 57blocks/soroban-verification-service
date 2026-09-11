/**
 * The assertion that found the broken `0.1.0`: an installed tree's declarations resolve and hold together for
 * a consumer outside the workspace. Shared by the pack gate and the registry gate so the pre-publish and
 * post-publish readers cannot drift — a defect the registry gate can name is one the pack gate must refuse.
 */
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Both tools live in the SDK's own `devDependencies`, so its `node_modules/.bin` leads and the root follows. */
export function binaryIn(dirs, tool) {
  for (const dir of dirs) {
    const path = join(dir, "node_modules", ".bin", tool);
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * Type-level only, and deliberately shallow: it asserts the declaration graph resolves from an installed tree,
 * not any particular signature, which the SDK's own suite owns. Returns a finding, or null when it holds.
 */
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
