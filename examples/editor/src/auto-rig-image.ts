/**
 * App-side (DOM) helpers for the auto-rig import flow.
 *
 * DOM is allowed here (canvas / getImageData / ImageBitmap). Pure engine logic
 * lives in @ikijs/editor-core; this file only handles the pixel-level work that
 * requires a browser canvas.
 */

import {
  detectAlphaBbox as scanAlphaBbox,
  parseLayerRoles,
  type LayerInput,
} from "@ikijs/editor-core";

/**
 * PNG ingestion budgets. The PSD path (`MAX_PSD_*`) and the Node MCP path
 * (`@ikijs/mcp`'s limits.ts) already refuse oversized input; these are the same
 * caps for the third entry point, so no auto-rig path can be handed a selection
 * that exhausts memory before anything is validated. All three REJECT rather
 * than downscale.
 */
export const MAX_PNG_LAYERS = 64;
/** Max per-side dimension (px) of any single input PNG. */
export const MAX_PNG_LAYER_DIM = 4096;
/** Aggregate decoded-pixel budget across one selection (~1 GB of RGBA). */
export const MAX_PNG_TOTAL_MEGAPIXELS = 256;

/**
 * Rasterize a bitmap and return the tight alpha bounding box, expanded by 1px
 * (clamped to canvas bounds) to give AA / extrude margin. Top-left origin,
 * +y down (image coordinates).
 *
 * Throws if:
 * - the 2d canvas context is unavailable
 * - no pixel passes the threshold (empty layer)
 */
export function detectAlphaBbox(bitmap: ImageBitmap): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const { width, height } = bitmap;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    throw new Error("detectAlphaBbox: could not obtain 2d canvas context");
  }

  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, width, height);

  // The scan lives in @ikijs/editor-core so this path and the Node MCP path
  // cannot drift; only the decode above is browser-specific.
  const bbox = scanAlphaBbox(data, width, height);
  if (bbox === null) {
    throw new Error("auto-rig: layer is empty after alpha threshold");
  }
  return bbox;
}

/**
 * Crop a bitmap to the given bbox using createImageBitmap.
 *
 * `{ premultiplyAlpha:"none", imageOrientation:"none" }` keeps the cropped
 * sub-image's pixels and orientation faithful for the downstream atlas pack
 * and edge-extrude step (alpha-threshold scanning already ran on the original
 * bitmap before this crop).
 */
export function cropBitmap(
  bitmap: ImageBitmap,
  bbox: { x: number; y: number; w: number; h: number },
): Promise<ImageBitmap> {
  return createImageBitmap(bitmap, bbox.x, bbox.y, bbox.w, bbox.h, {
    premultiplyAlpha: "none",
    imageOrientation: "none",
  });
}

/**
 * Build the pure LayerInput[] payload from an array of decoded bitmaps.
 *
 * NON-async — creates NO ImageBitmaps — the store owns every cropped-bitmap
 * lifetime; this function only reads pixels.
 *
 * Contract:
 * - All bitmaps must share the same width/height (canvas size is taken from
 *   the first entry).
 * - Filenames must satisfy parseLayerRoles (unknown/duplicate/missing roles
 *   throw).
 * - Every layer must contain at least one non-transparent pixel.
 *
 * Throws a path-qualified Error on any violation.
 */
export function buildLayerInputs(
  decoded: { fileName: string; bitmap: ImageBitmap }[],
): LayerInput[] {
  if (decoded.length === 0) {
    throw new Error(
      "auto-rig: buildLayerInputs: decoded layers must not be empty",
    );
  }

  // Derive canvas size from the first bitmap; assert all others match.
  const canvasW = decoded[0].bitmap.width;
  const canvasH = decoded[0].bitmap.height;

  for (const { fileName, bitmap } of decoded) {
    if (bitmap.width !== canvasW || bitmap.height !== canvasH) {
      throw new Error(
        `auto-rig: layer "${fileName}" size ${bitmap.width}x${bitmap.height} differs from canvas ${canvasW}x${canvasH}`,
      );
    }
  }

  // Parse and validate roles — throws on unknown/duplicate/missing.
  const rolePairs = parseLayerRoles(decoded.map((d) => d.fileName));

  // Build a fileName → role map for O(1) lookup (filenames are unique after
  // parseLayerRoles succeeds).
  const roleByFileName = new Map<string, string>(
    rolePairs.map(({ role, fileName }) => [fileName, role]),
  );

  return decoded.map(({ fileName, bitmap }) => {
    const role = roleByFileName.get(fileName)!;

    let bbox: { x: number; y: number; w: number; h: number };
    try {
      bbox = detectAlphaBbox(bitmap);
    } catch (err) {
      // Enrich the empty-layer error with role + file context.
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`auto-rig: role "${role}" file "${fileName}": ${msg}`);
    }

    return {
      role,
      fileName,
      canvasW,
      canvasH,
      bbox,
      cropW: bbox.w,
      cropH: bbox.h,
    };
  });
}
