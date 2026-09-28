import { defineConfig, type Options } from "tsup";

// Bundled because npm cannot resolve `workspace:*`: `@scvs/*` must be compiled in.

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "neutral",
  target: "es2022",
  outDir: "dist",
  dts: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  noExternal: [/^@scvs\//],
} satisfies Options);

// No `sideEffects: false` in package.json: a consumer's bundler would drop `reflect-metadata`'s bare import.
