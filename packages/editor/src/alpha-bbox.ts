/**
 * Alpha bounding-box scan shared by every auto-rig ingestion path.
 *
 * The scan itself is environment-free — it only needs indexable RGBA bytes — so
 * a browser editor (canvas `ImageData`) and the Node MCP server (a `sharp`
 * raw buffer) run the SAME code instead of two copies that have to be kept
 * byte-identical by hand. Only decoding differs between them.
 */

/** Alpha at or above this counts as coverage; below it is treated as empty. */
export const ALPHA_BBOX_THRESHOLD = 8;

/** Top-left origin, +y down — image space, not model space. */
export interface AlphaBbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Tight bounding box of every pixel with alpha >= {@link ALPHA_BBOX_THRESHOLD},
 * expanded 1px on each side (clamped to the image) for AA / extrude margin.
 *
 * Returns `null` when no pixel passes the threshold, leaving the "empty layer"
 * error to the caller: each ingestion path reports it with its own error type
 * and message.
 */
export function detectAlphaBbox(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
): AlphaBbox | null {
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = rgba[(y * width + x) * 4 + 3];
      if (alpha >= ALPHA_BBOX_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX === -1) return null;

  // Expand 1px each side, clamped to image bounds; the x2/y2 clamps make w/h
  // implicitly in-bounds (no separate w/h clamp needed).
  const x = Math.max(0, minX - 1);
  const y = Math.max(0, minY - 1);
  const x2 = Math.min(width - 1, maxX + 1);
  const y2 = Math.min(height - 1, maxY + 1);

  return { x, y, w: x2 - x + 1, h: y2 - y + 1 };
}
