import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// The server reports this to every MCP client. Baked from package.json at build
// time so `changeset version` -> build -> publish can never ship a stale one.
const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  define: { __MCP_VERSION__: JSON.stringify(version) },
  // Read by scripts/check-packages.mjs to prove @ikijs/format stays external.
  metafile: true,
  outExtension({ format }) {
    return { js: format === "cjs" ? ".js" : ".mjs" };
  },
});
