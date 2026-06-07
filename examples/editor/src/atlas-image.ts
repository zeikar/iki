import type { AtlasLayout } from "@iki/editor-core";

export interface DecodedSource {
  id: string;
  name: string;
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

/**
 * Decode a PNG or WebP File into a DecodedSource with a stable random id.
 * Throws if the file type is not image/png or image/webp.
 */
export async function decodeImageFile(file: File): Promise<DecodedSource> {
  if (file.type !== "image/png" && file.type !== "image/webp") {
    throw new Error(
      `decodeImageFile: unsupported type "${file.type}"; only image/png and image/webp are accepted`,
    );
  }
  const bitmap = await createImageBitmap(file);
  return {
    id: crypto.randomUUID(),
    name: file.name,
    bitmap,
    width: bitmap.width,
    height: bitmap.height,
  };
}

/**
 * Render a packed atlas to a PNG data URI.
 *
 * Each sub-image is drawn at its placement rect and its right + bottom edge
 * pixels are extruded across the full padding gutter so LINEAR sampling at the
 * inset UV never reads a transparent neighbor texel.
 *
 * Throws if:
 * - the 2d canvas context is unavailable, or
 * - toDataURL returns something other than a data:image/png URI (e.g. the
 *   browser returned "data:," for an oversized/invalid canvas).
 *
 * ASSUMES a non-empty layout (empty case is handled by the caller).
 */
export function renderAtlas(
  decoded: DecodedSource[],
  layout: AtlasLayout,
): string {
  const canvas = document.createElement("canvas");
  canvas.width = layout.pageWidth;
  canvas.height = layout.pageHeight;

  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    throw new Error("renderAtlas: could not obtain 2d canvas context");
  }

  ctx.clearRect(0, 0, layout.pageWidth, layout.pageHeight);

  // Build a lookup so we can match placement.id → bitmap in O(1).
  const byId = new Map<string, DecodedSource>();
  for (const src of decoded) {
    byId.set(src.id, src);
  }

  const pad = layout.padding;

  for (const placement of layout.placements) {
    const src = byId.get(placement.id);
    if (src === undefined) continue;

    const { bitmap } = src;
    const { x, y, width: w, height: h } = placement;

    // Draw the main image at its placement rect.
    ctx.drawImage(bitmap, x, y, w, h);

    if (pad > 0) {
      // Extrude right column: 1px-wide rightmost edge → full right gutter.
      ctx.drawImage(bitmap, w - 1, 0, 1, h, x + w, y, pad, h);
      // Extrude bottom row: 1px-tall bottom edge → full bottom gutter.
      ctx.drawImage(bitmap, 0, h - 1, w, 1, x, y + h, w, pad);
      // Extrude corner: bottom-right 1×1 pixel → full corner gutter.
      ctx.drawImage(bitmap, w - 1, h - 1, 1, 1, x + w, y + h, pad, pad);
    }
  }

  const uri = canvas.toDataURL("image/png");
  if (!uri.startsWith("data:image/png")) {
    throw new Error(
      `renderAtlas: toDataURL returned an unexpected result ("${uri.slice(0, 32)}…"); the canvas may be too large or invalid`,
    );
  }
  return uri;
}
