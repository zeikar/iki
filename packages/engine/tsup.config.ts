import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  // Read by scripts/check-packages.mjs to prove @ikijs/format stays external.
  metafile: true,
  outExtension({ format }) {
    return { js: format === "cjs" ? ".js" : ".mjs" };
  },
});
