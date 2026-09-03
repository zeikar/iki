/**
 * Node (sharp-backed) re-host of the browser-only pixel functions used by the
 * auto-rig import flow. Only the DECODE/ENCODE halves are re-hosted here — the
 * alpha-bbox scan itself is shared with the browser path via
 * @ikijs/editor, so the two cannot drift. Still a controlled duplicate of:
 *   - crop                         ← examples/editor/src/auto-rig-image.ts
 *   - atlas render + edge-extrude  ← examples/editor/src/atlas-image.ts
 * The pure parts (packAtlas / uvRectFor / generateIkiFromLayerSet / role parsing
 * / bbox→model math) are reused from @ikijs/editor, not reimplemented here.
 *
 * `sharp` is a heavy native dependency and MUST stay confined to @ikijs/mcp — it
 * may never reach @ikijs/editor, @ikijs/engine, or @ikijs/format.
 */

import sharp from "sharp";
import type { AtlasLayout } from "@ikijs/editor";
import { detectAlphaBbox as scanAlphaBbox } from "@ikijs/editor";
import { AutoRigInputError, MAX_INPUT_PIXELS } from "./limits";

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
 * Node-side wrapper over the shared scan in @ikijs/editor: same bbox rule
 * as the browser path by construction, with this package's error type for an
 * empty layer.
 */
export function detectAlphaBbox(
  rgba: Buffer,
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } {
  const bbox = scanAlphaBbox(rgba, width, height);
  if (bbox === null) {
    throw new AutoRigInputError("layer is empty after alpha threshold");
  }
  return bbox;
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
