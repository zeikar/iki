/**
 * Resource guards + fail-fast path resolution and atomic writes for the Node
 * auto-rig tool.
 *
 * These constants bound an agent-supplied layer set so a malformed or oversized
 * request fails fast with a path-qualified message rather than exhausting memory
 * or producing a multi-MB MCP response. All guards REJECT (never downscale).
 *
 * `sharp` must stay confined to @ikijs/mcp — none of @ikijs/engine, @ikijs/editor,
 * or @ikijs/format may take a heavy Node image dependency.
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
/** Aggregate decoded-pixel budget across ALL layers in one request, so a set of
 *  many large PNGs cannot exhaust memory even though each passes MAX_LAYER_DIM. */
export const MAX_TOTAL_PIXELS = 64 * 1024 * 1024;
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
 * Reject an empty/whitespace or URL-looking caller-supplied path, shared by
 * {@link resolveInputPath} and {@link resolveInputDir}. `noun` and `kind`
 * shape the thrown message so each caller reports in its own vocabulary
 * (e.g. a directory input was never supposed to look like "a file path").
 */
function rejectEmptyOrUrl(inputPath: string, noun: string, kind: string): void {
  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    throw new AutoRigInputError(`${noun} is empty`);
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(inputPath)) {
    throw new AutoRigInputError(
      `${noun} must be a ${kind}, not a URL: ${inputPath}`,
    );
  }
}

/**
 * Resolve a caller-supplied input file path against the MCP process cwd and
 * confirm it points at a readable file. Throws AutoRigInputError (path-qualified)
 * for empty/URL-looking strings, a missing file, or a directory.
 *
 * READS ARE DELIBERATELY NOT CONFINED to the working directory, unlike
 * {@link resolveOutputPath}. The asymmetry is intentional, not an oversight: a
 * stray write destroys data, while a read only surfaces a PNG the agent already
 * named and the user's own account can already open. Confining reads would also
 * break the documented generate-a-character flow, which composes its layers in
 * a scratch directory (`/tmp/iki-char/layers/…`) and rigs them into a model
 * under the project. Revisit only if this server ever runs with wider
 * privileges than the person driving it. The same reasoning covers
 * {@link resolveInputDir}, its directory counterpart.
 *
 * Param is named `inputPath` (not `path`) to avoid shadowing the node:path import.
 */
export function resolveInputPath(inputPath: string): string {
  rejectEmptyOrUrl(inputPath, "layer path", "file path");
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

/** Directory counterpart to {@link resolveInputPath} — see its doc comment. */
export function resolveInputDir(dirPath: string): string {
  rejectEmptyOrUrl(dirPath, "layers dir", "directory path");
  const resolved = path.resolve(process.cwd(), dirPath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new AutoRigInputError(`layers dir not found: ${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new AutoRigInputError(`layers path is not a directory: ${resolved}`);
  }
  return resolved;
}

/**
 * Confine an already-verified-to-exist directory to the MCP process working
 * directory, comparing REAL paths (statSync/writeFileSync follow symlinks, so
 * a lexical startsWith check can be bypassed by a symlinked dir under cwd).
 * Shared by {@link resolveOutputPath} and {@link resolveOutputDir} — both are
 * write-side boundaries where an unrestricted target is an
 * arbitrary-file-overwrite surface. `label` and `original` shape the thrown
 * message (path-qualified with the caller's original, unresolved string).
 */
function confineToWorkingDirectory(
  root: string,
  dir: string,
  label: string,
  original: string,
): string {
  const realRoot = fs.realpathSync(root);
  const realDir = fs.realpathSync(dir);
  if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) {
    throw new AutoRigInputError(
      `${label} escapes the working directory: ${original}`,
    );
  }
  return realDir;
}

/**
 * Resolve a caller-supplied output path against the MCP process cwd. Throws
 * AutoRigInputError (path-qualified) if the parent directory does not exist —
 * the tool never creates directories (fail-fast).
 *
 * Writes are confined to the MCP process working directory: the path must end
 * in `.iki` AND resolve to a location under `process.cwd()`. The MCP server runs
 * with the user's own permissions on agent-supplied input, so an unrestricted
 * `outputPath` is an arbitrary-file-overwrite surface — absolute paths and `..`
 * traversal that escape the working directory are rejected. (Overwriting an
 * existing `.iki` UNDER the working directory is intentional: re-running the tool
 * regenerates the named model.)
 */
export function resolveOutputPath(outputPath: string): string {
  if (typeof outputPath !== "string" || outputPath.trim() === "") {
    throw new AutoRigInputError("output path is empty");
  }
  if (!outputPath.toLowerCase().endsWith(".iki")) {
    throw new AutoRigInputError(`output path must end in .iki: ${outputPath}`);
  }
  const root = process.cwd();
  const resolved = path.resolve(root, outputPath);
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
  const realDir = confineToWorkingDirectory(
    root,
    dir,
    "output path",
    outputPath,
  );
  return path.join(realDir, path.basename(resolved));
}

/**
 * Resolve a caller-supplied output DIRECTORY against the MCP process cwd.
 * Unlike {@link resolveOutputPath}, no filename is appended — the directory
 * itself must already exist (the tool never creates directories, fail-fast) —
 * and is confined via {@link confineToWorkingDirectory}. Returns the
 * realpath'd directory.
 */
export function resolveOutputDir(dirPath: string): string {
  if (typeof dirPath !== "string" || dirPath.trim() === "") {
    throw new AutoRigInputError("output dir is empty");
  }
  const root = process.cwd();
  const resolved = path.resolve(root, dirPath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new AutoRigInputError(`output dir not found: ${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new AutoRigInputError(`output dir is not a directory: ${resolved}`);
  }
  return confineToWorkingDirectory(root, resolved, "output dir", dirPath);
}

/**
 * Write `data` to `outPath` atomically: write to a fresh temp file in the
 * same directory, then `renameSync` over the target. `rename` REPLACES the
 * destination directory entry rather than following it, so an existing
 * symlink at `outPath` cannot redirect the write outside the working tree.
 * Throws AutoRigInputError("write: …") on failure.
 */
export function writeFileAtomic(
  outPath: string,
  data: string | Uint8Array,
): void {
  const tmp = `${outPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    try {
      fs.renameSync(tmp, outPath);
    } catch (e) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // best-effort temp cleanup; surface the original rename error
      }
      throw e;
    }
  } catch (e) {
    throw new AutoRigInputError(
      `write: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
