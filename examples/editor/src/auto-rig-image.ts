/**
 * App-side (DOM) helpers for the auto-rig import flow.
 *
 * DOM is allowed here (canvas / getImageData / ImageBitmap). Pure engine logic
 * lives in @iki/editor-core; this file only handles the pixel-level work that
 * requires a browser canvas.
 */

import { parseLayerRoles, type LayerInput } from "@iki/editor-core";

// Pixels with alpha < ALPHA_THRESHOLD are treated as transparent.
const ALPHA_THRESHOLD = 8;

/**
 * Scan a bitmap's alpha channel and return the tight bounding box of all
 * pixels whose alpha >= ALPHA_THRESHOLD, expanded by 1px (clamped to canvas
 * bounds) to give AA / extrude margin.
 *
 * Top-left origin, +y down (image coordinates).
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

  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha >= ALPHA_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX === -1) {
    throw new Error("auto-rig: layer is empty after alpha threshold");
  }

  // Expand by 1px on each side, clamped to canvas bounds. The resulting w/h
  // are implicitly within canvas bounds because x2/y2 are clamped to
  // width-1/height-1 (no separate w/h clamp needed).
  const x = Math.max(0, minX - 1);
  const y = Math.max(0, minY - 1);
  const x2 = Math.min(width - 1, maxX + 1);
  const y2 = Math.min(height - 1, maxY + 1);

  return { x, y, w: x2 - x + 1, h: y2 - y + 1 };
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
 * lifetime (Task 6); this function only reads pixels.
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
