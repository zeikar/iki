import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// The server reports this to every MCP client. Baked from package.json at build
// time so `changeset version` -> build -> publish can never ship a stale one.
const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

// An array config builds its entries in parallel, so a `clean: true` here would
// race the page bundle: cleaning lives in the package's build script instead.
export default defineConfig([
  {
    entry: ["src/index.ts", "src/cli.ts"],
    format: ["cjs", "esm"],
    dts: true,
    sourcemap: true,
    // The CJS build needs `import.meta.url` for the page-bundle locator.
    shims: true,
    define: { __MCP_VERSION__: JSON.stringify(version) },
    // Read by scripts/check-packages.mjs to prove @ikijs/format stays external.
    metafile: true,
    outExtension({ format }) {
      return { js: format === "cjs" ? ".js" : ".mjs" };
    },
  },
  {
    // The `render_poses` page script: the workspace engine inlined into one
    // IIFE for a browser. It has to inline @ikijs/format too, since a page has
    // no other copy.
    entry: { "render-page": "src/render-page.ts" },
    format: ["iife"],
    platform: "browser",
    noExternal: [/^@ikijs\//],
    outExtension: () => ({ js: ".global.js" }),
  },
]);
