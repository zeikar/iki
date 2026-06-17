/**
 * Node (sharp-backed) re-host of the browser-only pixel functions used by the
 * auto-rig import flow. This is a CONTROLLED DUPLICATE of three DOM functions —
 * keep them byte-compatible with the browser reference:
 *   - decode + alpha-bbox + crop  ← examples/editor/src/auto-rig-image.ts
 *   - atlas render + edge-extrude  ← examples/editor/src/atlas-image.ts
 * The pure parts (packAtlas / uvRectFor / generateIkiFromLayerSet / role parsing
 * / bbox→model math) are reused from @iki/editor-core, not reimplemented here.
 *
 * `sharp` is a heavy native dependency and MUST stay confined to @iki/mcp — it
 * may never reach @iki/editor-core, @iki/engine, or @iki/format.
 */

import sharp from "sharp";
import type { AtlasLayout } from "@iki/editor-core";
import { AutoRigInputError, MAX_INPUT_PIXELS } from "./limits";

// Pixels with alpha < ALPHA_THRESHOLD are treated as transparent. MUST stay
// byte-identical to detectAlphaBbox in examples/editor/src/auto-rig-image.ts.
const ALPHA_THRESHOLD = 8;

export interface DecodedPng {
  width: number;
  height: number;
  /** Straight-alpha RGBA bytes, stride-4 (parity with canvas getImageData). */
  rgba: Buffer;
}

/**
 * Decode a PNG file to straight-alpha RGBA bytes + dimensions.
 *
 * Decode is an input boundary: a missing/corrupt/unsupported file or a
 * limitInputPixels overflow surfaces as a path-qualified AutoRigInputError so
 * the tool returns { ok:false } rather than { isError:true }.
 *
 * `.ensureAlpha()` promotes RGB PNGs to RGBA so the alpha scan matches the
 * browser canvas getImageData path (which is always RGBA).
 */
export async function decodePng(filePath: string): Promise<DecodedPng> {
  try {
    const pipeline = sharp(filePath, { limitInputPixels: MAX_INPUT_PIXELS });
    const metadata = await pipeline.metadata();
    if (metadata.format !== "png") {
      throw new AutoRigInputError(
        `non-PNG image (${metadata.format ?? "unknown"}): ${filePath}`,
      );
    }
    const { data, info } = await pipeline
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, rgba: data };
  } catch (e) {
    if (e instanceof AutoRigInputError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new AutoRigInputError(`failed to decode PNG ${filePath}: ${msg}`);
  }
}

/**
 * Tight bounding box of all pixels with alpha >= ALPHA_THRESHOLD, expanded 1px
 * each side (clamped to image bounds) for AA / extrude margin. Top-left origin,
 * +y down. Throws AutoRigInputError if the layer is fully transparent.
 *
 * Byte-identical to detectAlphaBbox in examples/editor/src/auto-rig-image.ts.
 */
export function detectAlphaBbox(
  rgba: Buffer,
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } {
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = rgba[(y * width + x) * 4 + 3];
      if (alpha >= ALPHA_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX === -1) {
    throw new AutoRigInputError("layer is empty after alpha threshold");
  }

  // Expand 1px each side, clamped to image bounds; x2/y2 clamps make w/h
  // implicitly in-bounds (no separate w/h clamp needed).
  const x = Math.max(0, minX - 1);
  const y = Math.max(0, minY - 1);
  const x2 = Math.min(width - 1, maxX + 1);
  const y2 = Math.min(height - 1, maxY + 1);

  return { x, y, w: x2 - x + 1, h: y2 - y + 1 };
}

/**
 * Crop the already-decoded RGBA to bbox, returning a PNG buffer. One decode per
 * file: the crop is taken from the raw RGBA, not a re-read of the file. Parity
 * with cropBitmap in examples/editor/src/auto-rig-image.ts.
 */
export function cropToBuffer(
  rgba: Buffer,
  width: number,
  height: number,
  bbox: { x: number; y: number; w: number; h: number },
): Promise<Buffer> {
  return sharp(rgba, { raw: { width, height, channels: 4 } })
    .extract({ left: bbox.x, top: bbox.y, width: bbox.w, height: bbox.h })
    .png()
    .toBuffer();
}

export interface AtlasCrop {
  id: string;
  buffer: Buffer;
  width: number;
  height: number;
}

/**
 * Composite packed crops onto a transparent page and return a base64 PNG data
 * URI. Each crop's right + bottom edge pixels are extruded across the padding
 * gutter (replicating renderAtlas's right/bottom/corner drawImage extrudes in
 * examples/editor/src/atlas-image.ts) so LINEAR sampling at the inset UV never
 * reads a transparent neighbor texel. packAtlas reserves padding on the RIGHT
 * and BOTTOM only, so a one-sided `extend` matches its layout exactly.
 *
 * Crops are looked up BY placement.id (packAtlas sorts placements by id).
 * ASSUMES a non-empty layout (the empty case is handled by the caller).
 */
export async function renderAtlasToDataUri(
  crops: AtlasCrop[],
  layout: AtlasLayout,
): Promise<string> {
  const byId = new Map<string, AtlasCrop>();
  for (const crop of crops) byId.set(crop.id, crop);

  const pad = layout.padding;

  const composites = await Promise.all(
    layout.placements.map(async (placement) => {
      const crop = byId.get(placement.id);
      if (crop === undefined) {
        throw new AutoRigInputError(
          `no crop for atlas placement "${placement.id}"`,
        );
      }
      // Replicate the right + bottom (+ corner) edge pixels into the gutter.
      const input =
        pad > 0
          ? await sharp(crop.buffer)
              .extend({ right: pad, bottom: pad, extendWith: "copy" })
              .png()
              .toBuffer()
          : crop.buffer;
      return { input, left: placement.x, top: placement.y };
    }),
  );

  const page = await sharp({
    create: {
      width: layout.pageWidth,
      height: layout.pageHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer();

  return `data:image/png;base64,${page.toString("base64")}`;
}
