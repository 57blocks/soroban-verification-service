import { defineConfig, type Options } from "tsup";

// This package ships a bundle rather than plain `tsc` output because npm cannot resolve `workspace:*`:
// `@scvs/core` and `@scvs/storage-layout` are compiled in, or consumers get imports of packages that do not
// exist.

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
  // Compiled in — see the header.
  noExternal: [/^@scvs\//],
} satisfies Options);

// No `sideEffects: false` in package.json: the bundle carries `reflect-metadata`'s bare import, and that flag
// would let a consumer's bundler drop it.
