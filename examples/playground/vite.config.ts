import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Resolve workspace packages to their source so editing the engine or format
// hot-reloads here instantly — no rebuild step while developing.
export default defineConfig({
  resolve: {
    alias: {
      "@iki/engine": fileURLToPath(
        new URL("../../packages/engine/src/index.ts", import.meta.url),
      ),
      "@iki/format": fileURLToPath(
        new URL("../../packages/format/src/index.ts", import.meta.url),
      ),
    },
  },
});
