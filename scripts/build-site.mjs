/**
 * Assembles the GitHub Pages site into `dist/`, run by `pnpm build:site` and by
 * the `pages` workflow.
 *
 * The two example apps are ordinary Vite SPAs whose configs alias the workspace
 * packages to their SOURCE, so each builds standalone with no prior `pnpm build`.
 * What they cannot know is where they will be served from: a project page lives
 * under `/<repo>/`, so every emitted asset URL needs that prefix. `base` is
 * passed here rather than set in `vite.config.ts` on purpose — the dev servers
 * keep serving from `/`, and only the deployed build carries the sub-path.
 */

import { execFile } from "node:child_process";
import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const outDir = path.join(rootDir, "dist");

// Project pages keep a `/<repo>/` prefix even under the account's custom
// domain, which applies to the user site: this deploys to zeikar.dev/iki/.
const siteBase = "/iki/";

/** Each app builds straight into its final slot, so there is no copy step. */
const apps = [
  { filter: "@ikijs/playground", slug: "playground" },
  { filter: "@ikijs/editor-app", slug: "editor" },
];

await rm(outDir, { recursive: true, force: true });

for (const { filter, slug } of apps) {
  const appOutDir = path.join(outDir, slug);
  console.log(`building ${filter} -> dist/${slug}/ (base ${siteBase}${slug}/)`);
  // `--emptyOutDir` is required because the target is outside the app root;
  // without it Vite refuses rather than clearing a directory it does not own.
  await execFileAsync(
    "pnpm",
    [
      "--filter",
      filter,
      "exec",
      "vite",
      "build",
      "--base",
      `${siteBase}${slug}/`,
      "--outDir",
      appOutDir,
      "--emptyOutDir",
    ],
    { cwd: rootDir },
  );
}

// The landing page is hand-written static HTML with no build step, so it is
// copied in last — after the app builds, which each empty their own subdirectory.
console.log("copying site/ -> dist/");
await cp(path.join(rootDir, "site"), outDir, { recursive: true });

console.log("site assembled in dist/");
