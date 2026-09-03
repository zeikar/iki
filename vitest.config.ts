import { readFileSync } from "node:fs";
import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

// Resolve workspace packages to their source so tests run without a build step,
// mirroring the tsconfig `paths` aliases.
const resolvePackage = (p: string) => path.resolve(__dirname, p);

const mcpVersion = JSON.parse(
  readFileSync(path.resolve(__dirname, "packages/mcp/package.json"), "utf8"),
) as { version: string };

export default defineConfig({
  // Mirrors the tsup `define` so @ikijs/mcp's server version is the real one
  // under test too, instead of throwing on an undeclared global.
  define: { __MCP_VERSION__: JSON.stringify(mcpVersion.version) },
  test: {
    globals: true,
    environment: "node",
    coverage: {
      provider: "v8",
      all: true,
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        ...(configDefaults.coverage.exclude ?? []),
        // Re-export barrels and the WebGL player (needs a real GL context).
        "packages/*/src/index.ts",
        "packages/engine/src/player.ts",
        // Process entry / stdio transport — can't be unit-tested.
        "packages/mcp/src/cli.ts",
      ],
      reporter: ["text", "json-summary", "html"],
      thresholds: {
        statements: 60,
        branches: 75,
        functions: 80,
        lines: 60,
      },
    },
  },
  resolve: {
    alias: [
      {
        find: "@ikijs/format",
        replacement: resolvePackage("packages/format/src/index.ts"),
      },
      {
        find: "@ikijs/engine",
        replacement: resolvePackage("packages/engine/src/index.ts"),
      },
      {
        find: "@ikijs/editor",
        replacement: resolvePackage("packages/editor/src/index.ts"),
      },
    ],
  },
});
