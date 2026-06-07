import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

// Resolve workspace packages to their source so tests run without a build step,
// mirroring the tsconfig `paths` aliases.
const resolvePackage = (p: string) => path.resolve(__dirname, p);

export default defineConfig({
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
        find: "@iki/format",
        replacement: resolvePackage("packages/format/src/index.ts"),
      },
      {
        find: "@iki/engine",
        replacement: resolvePackage("packages/engine/src/index.ts"),
      },
      {
        find: "@iki/editor-core",
        replacement: resolvePackage("packages/editor-core/src/index.ts"),
      },
    ],
  },
});
