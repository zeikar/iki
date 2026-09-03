import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Resolve workspace packages to their source so editing `@ikijs/engine`,
// `@ikijs/format`, or `@ikijs/editor` hot-reloads here instantly — no rebuild
// step while developing.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@ikijs/engine": fileURLToPath(
        new URL("../../packages/engine/src/index.ts", import.meta.url),
      ),
      "@ikijs/format": fileURLToPath(
        new URL("../../packages/format/src/index.ts", import.meta.url),
      ),
      "@ikijs/editor": fileURLToPath(
        new URL("../../packages/editor/src/index.ts", import.meta.url),
      ),
    },
  },
});
