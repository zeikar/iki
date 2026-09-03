import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Resolve workspace packages to their source so editing the engine, format,
// or editor-core hot-reloads here instantly — no rebuild step while developing.
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
      "@ikijs/editor-core": fileURLToPath(
        new URL("../../packages/editor-core/src/index.ts", import.meta.url),
      ),
    },
  },
});
