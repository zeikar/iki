/**
 * Resource guards + fail-fast path resolution for the Node auto-rig tool.
 *
 * These constants bound an agent-supplied layer set so a malformed or oversized
 * request fails fast with a path-qualified message rather than exhausting memory
 * or producing a multi-MB MCP response. All guards REJECT (never downscale).
 *
 * `sharp` must stay confined to @iki/mcp — none of @iki/engine, @iki/editor-core,
 * or @iki/format may take a heavy Node image dependency.
 */

import fs from "node:fs";
import path from "node:path";

/** Max number of input layers in one request. */
export const MAX_LAYERS = 64;
/** Max per-side dimension (px) of any single input PNG. */
export const MAX_LAYER_DIM = 4096;
/** Max per-side dimension (px) of the derived canvas. */
export const MAX_CANVAS_DIM = 4096;
/** Max area (px²) of the packed atlas page. */
export const MAX_ATLAS_AREA = 4096 * 4096;
/** Decoded-pixel ceiling per input PNG, passed to sharp `limitInputPixels`. */
export const MAX_INPUT_PIXELS = 4096 * 4096;
/** Max length (bytes) of the base64 atlas data URI embedded in the model. */
export const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

/**
 * Expected, caller-input-caused failure. The tool catches ONLY this class and
 * returns `{ ok: false, error }`; any other thrown Error (TypeError, invariant
 * break, programmer bug) propagates so the SDK handler surfaces `isError: true`.
 */
export class AutoRigInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutoRigInputError";
  }
}

/**
 * Resolve a caller-supplied input file path against the MCP process cwd and
 * confirm it points at a readable file. Throws AutoRigInputError (path-qualified)
 * for empty/URL-looking strings, a missing file, or a directory.
 *
 * Param is named `inputPath` (not `path`) to avoid shadowing the node:path import.
 */
export function resolveInputPath(inputPath: string): string {
  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    throw new AutoRigInputError("layer path is empty");
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(inputPath)) {
    throw new AutoRigInputError(
      `layer path must be a file path, not a URL: ${inputPath}`,
    );
  }
  const resolved = path.resolve(process.cwd(), inputPath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new AutoRigInputError(`layer file not found: ${resolved}`);
  }
  if (stat.isDirectory()) {
    throw new AutoRigInputError(
      `layer path is a directory, not a file: ${resolved}`,
    );
  }
  return resolved;
}

/**
 * Resolve a caller-supplied output path against the MCP process cwd. Throws
 * AutoRigInputError (path-qualified) if the parent directory does not exist —
 * the tool never creates directories (fail-fast).
 */
export function resolveOutputPath(outputPath: string): string {
  if (typeof outputPath !== "string" || outputPath.trim() === "") {
    throw new AutoRigInputError("output path is empty");
  }
  const resolved = path.resolve(process.cwd(), outputPath);
  const dir = path.dirname(resolved);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    throw new AutoRigInputError(`output directory does not exist: ${dir}`);
  }
  if (!stat.isDirectory()) {
    throw new AutoRigInputError(`output parent is not a directory: ${dir}`);
  }
  return resolved;
}
