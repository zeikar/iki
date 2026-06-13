// PSD layer pixels are stored at their layer bounds (top/left/right/bottom) per
// the PSD spec — not at canvas origin. compositeLayerPixels places them onto a
// full-document-sized canvas so buildLayerInputs' equal-canvas-size check passes
// and the layer's position is preserved in the output bitmap.

import { readPsd } from "ag-psd";

/**
 * Composites a single PSD layer's pixel data onto a blank full-document canvas.
 *
 * @param layerData - Raw RGBA pixels for the layer, stored at layer bounds.
 *   Only the 8-bit subset of ag-psd's PixelArray union is accepted here;
 *   non-8-bit documents are rejected upstream (by a later task's header guard)
 *   so they never reach this function.
 * @param layerW - Width of the layer rectangle in pixels.
 * @param layerH - Height of the layer rectangle in pixels.
 * @param left   - Left edge of the layer rectangle in document coordinates.
 * @param top    - Top edge of the layer rectangle in document coordinates.
 * @param docW   - Full document width in pixels.
 * @param docH   - Full document height in pixels.
 * @returns A new Uint8ClampedArray of length docW * docH * 4 (RGBA, all zeros
 *   outside the layer's intersection with the document canvas).
 */
export function compositeLayerPixels(
  layerData: Uint8ClampedArray | Uint8Array,
  layerW: number,
  layerH: number,
  left: number,
  top: number,
  docW: number,
  docH: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(docW * docH * 4);

  if (layerW === 0 || layerH === 0) {
    return out;
  }

  // Destination rect (document coordinates, clamped to doc bounds)
  const dxStart = Math.max(0, left);
  const dyStart = Math.max(0, top);
  const dxEnd = Math.min(docW, left + layerW);
  const dyEnd = Math.min(docH, top + layerH);

  // Empty intersection — layer is fully outside the document
  if (dxEnd <= dxStart || dyEnd <= dyStart) {
    return out;
  }

  // Source offset: if left < 0 we skip the first (-left) columns in layerData,
  // and similarly for top < 0.
  const sxOffset = dxStart - left; // >= 0
  const syOffset = dyStart - top; // >= 0

  const copyW = dxEnd - dxStart; // number of pixels per row to copy

  for (let row = 0; row < dyEnd - dyStart; row++) {
    const sy = syOffset + row;
    const dy = dyStart + row;
    const srcRowStart = (sy * layerW + sxOffset) * 4;
    const dstRowStart = (dy * docW + dxStart) * 4;
    out.set(
      layerData.subarray(srcRowStart, srcRowStart + copyW * 4),
      dstRowStart,
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// Header guard
// ---------------------------------------------------------------------------

/**
 * Reads the fixed 26-byte PSD/PSB file header from a raw ArrayBuffer.
 * All multi-byte fields are big-endian (per the PSD spec).
 *
 * Offsets (verified against ag-psd psdReader.js):
 *   0–3   signature (ASCII "8BPS")
 *   4–5   version uint16  (1 = PSD, 2 = PSB)
 *   6–11  reserved (skipped)
 *   12–13 channels uint16
 *   14–17 height uint32
 *   18–21 width uint32
 *   22–23 bitsPerChannel uint16
 *   24–25 colorMode uint16
 */
export function parsePsdHeader(buffer: ArrayBuffer): {
  version: number;
  channels: number;
  width: number;
  height: number;
  bitsPerChannel: number;
  colorMode: number;
} {
  if (buffer.byteLength < 26) {
    throw new Error(
      `psd import: file too small to be a valid PSD (${buffer.byteLength} bytes, need >= 26)`,
    );
  }

  const view = new DataView(buffer);

  // Signature: bytes 0–3 must be ASCII "8BPS"
  const sig = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  if (sig !== "8BPS") {
    throw new Error(`psd import: not a PSD file (bad signature "${sig}")`);
  }

  return {
    version: view.getUint16(4, false),
    channels: view.getUint16(12, false),
    height: view.getUint32(14, false),
    width: view.getUint32(18, false),
    bitsPerChannel: view.getUint16(22, false),
    colorMode: view.getUint16(24, false),
  };
}

// ---------------------------------------------------------------------------
// Document validation
// ---------------------------------------------------------------------------

/**
 * 64 MP ≈ 8192×8192. Bounds transient RGBA memory during import. This is a
 * deliberate safety budget, not a format limit — ag-psd supports larger files.
 */
export const MAX_PSD_MEGAPIXELS = 64;

/**
 * 256 MP total transient-RGBA budget across all decoded layers.
 * Each selected layer allocates one full-canvas RGBA buffer (docW*docH*4),
 * so a 64 MP document with 4 layers would hit this limit. The cap prevents
 * multi-layer PSDs from exhausting browser memory before any bitmaps are
 * released. 256 MP at 4 bytes/pixel = ~1 GB peak RGBA allocation.
 *
 * Applied as a preflight before the full pixel decode: groups are rejected
 * first (fail-fast, no nested-layer memory spike), then top-level count is
 * used — accurate after group rejection — to check the budget before ag-psd
 * allocates any layer pixel data.
 */
export const MAX_PSD_TOTAL_MEGAPIXELS = 256;

// ColorMode enum names for human-readable error messages.
const COLOR_MODE_NAMES: Record<number, string> = {
  0: "Bitmap",
  1: "Grayscale",
  2: "Indexed",
  3: "RGB",
  4: "CMYK",
  7: "Multichannel",
  8: "Duotone",
  9: "Lab",
};

/**
 * Validates a parsed PSD header against the constraints this import path
 * supports. Throws a descriptive error for any unsupported document property.
 */
export function validatePsdHeader(header: {
  version: number;
  width: number;
  height: number;
  bitsPerChannel: number;
  colorMode: number;
}): void {
  if (header.version !== 1) {
    throw new Error(
      `psd import: document: unsupported PSD version ${header.version}; PSB (version 2) is not supported`,
    );
  }

  if (header.colorMode !== 3) {
    const modeName = COLOR_MODE_NAMES[header.colorMode];
    const modeLabel =
      modeName !== undefined
        ? `${modeName} (${header.colorMode})`
        : String(header.colorMode);
    throw new Error(
      `psd import: document: unsupported color mode ${modeLabel}; only RGB is supported`,
    );
  }

  if (header.bitsPerChannel !== 8) {
    throw new Error(
      `psd import: document: unsupported bit depth ${header.bitsPerChannel}; only 8-bit is supported`,
    );
  }

  if (header.width * header.height > MAX_PSD_MEGAPIXELS * 1_000_000) {
    throw new Error(
      `psd import: document: ${header.width}x${header.height} exceeds the ${MAX_PSD_MEGAPIXELS} megapixel limit`,
    );
  }
}

// ---------------------------------------------------------------------------
// Layer selection
// ---------------------------------------------------------------------------

/**
 * Structural mirror of ag-psd's Layer interface, limited to the fields this
 * import path inspects. Using the full 4-member PixelArray union is required
 * so that real ag-psd Layer objects are assignable here — TypeScript does not
 * narrow imageData.data based on the header's bitsPerChannel guard.
 * The 8-bit narrowing happens later inside the Task 3 DOM wrapper.
 */
export interface PsdLayerLike {
  name?: string;
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
  hidden?: boolean;
  opacity?: number;
  blendMode?: string;
  clipping?: boolean;
  children?: PsdLayerLike[];
  imageData?: {
    data: Uint8ClampedArray | Uint8Array | Uint16Array | Float32Array;
    width: number;
    height: number;
  };
  // Special-layer markers (LayerAdditionalInfo subset)
  effects?: unknown;
  text?: unknown;
  vectorFill?: unknown;
  vectorStroke?: unknown;
  vectorMask?: unknown;
  vectorOrigination?: unknown;
  adjustment?: unknown;
  placedLayer?: unknown;
  sectionDivider?: unknown;
  // Pixel-mask fields from LayerAdditionalInfo (ag-psd v30.1.1)
  mask?: unknown;
  realMask?: unknown;
}

/**
 * Iterates top-level PSD layers and returns only those that are importable as
 * plain raster layers. Throws on the first unsupported layer encountered.
 *
 * Groups, hidden layers, clipping masks, non-normal blend modes, partial
 * opacity, and all special layer types are rejected. Duplicate names are NOT
 * deduped here — that responsibility belongs to the downstream parseLayerRoles.
 */
export function selectImportableLayers(
  children: PsdLayerLike[],
): { name: string; layer: PsdLayerLike }[] {
  const result: { name: string; layer: PsdLayerLike }[] = [];

  for (const layer of children) {
    const rawName = layer.name ?? "";
    const label = rawName.length > 0 ? `"${rawName}"` : '"(unnamed)"';

    // Groups / folders
    if (layer.children !== undefined) {
      throw new Error(
        `psd import: layer ${label}: groups/folders are not supported in this slice`,
      );
    }

    if (layer.hidden === true) {
      throw new Error(
        `psd import: layer ${label}: hidden layers are not supported`,
      );
    }

    if (layer.clipping === true) {
      throw new Error(
        `psd import: layer ${label}: clipping layers are not supported`,
      );
    }

    if (layer.blendMode !== undefined && layer.blendMode !== "normal") {
      throw new Error(
        `psd import: layer ${label}: unsupported blend mode "${layer.blendMode}"; only normal is supported`,
      );
    }

    if (layer.opacity !== undefined && layer.opacity !== 1) {
      throw new Error(
        `psd import: layer ${label}: unsupported opacity ${layer.opacity}; only fully-opaque layers are supported`,
      );
    }

    // Special-layer markers — checked explicitly so a text layer WITH cached
    // imageData is still rejected via its marker, not allowed through.
    if (layer.text) {
      throw new Error(
        `psd import: layer ${label}: text layers are not supported`,
      );
    }
    if (layer.placedLayer) {
      throw new Error(
        `psd import: layer ${label}: smart-object layers are not supported`,
      );
    }
    if (
      layer.vectorFill ||
      layer.vectorStroke ||
      layer.vectorMask ||
      layer.vectorOrigination
    ) {
      throw new Error(
        `psd import: layer ${label}: vector/shape layers are not supported`,
      );
    }
    if (layer.adjustment) {
      throw new Error(
        `psd import: layer ${label}: adjustment layers are not supported`,
      );
    }
    if (layer.effects) {
      throw new Error(
        `psd import: layer ${label}: layer effects are not supported`,
      );
    }
    if (layer.sectionDivider) {
      throw new Error(
        `psd import: layer ${label}: groups/folders are not supported in this slice`,
      );
    }
    if (layer.mask) {
      throw new Error(
        `psd import: layer ${label}: layer masks are not supported`,
      );
    }
    if (layer.realMask) {
      throw new Error(
        `psd import: layer ${label}: layer masks are not supported`,
      );
    }

    // Must have actual pixel data
    if (
      !layer.imageData ||
      layer.imageData.width === 0 ||
      layer.imageData.height === 0
    ) {
      throw new Error(
        `psd import: layer ${label}: is not a raster layer (no pixel data)`,
      );
    }

    const name = rawName.length > 0 ? rawName : "(unnamed)";
    result.push({ name, layer });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Budget helpers
// ---------------------------------------------------------------------------

/**
 * Returns the total pixel count for decoding `layerCount` layers from a
 * document of `docW × docH`. Each layer allocates one full-canvas RGBA buffer.
 * Exported so unit tests can verify the budget arithmetic without DOM APIs.
 */
export function totalDecodedPixels(
  docW: number,
  docH: number,
  layerCount: number,
): number {
  return docW * docH * layerCount;
}

// ---------------------------------------------------------------------------
// DOM wrapper — requires createImageBitmap (browser/worker only, not Node)
// ---------------------------------------------------------------------------

/**
 * Decodes a PSD File into an array of {fileName, bitmap} entries, one per
 * importable raster layer. The return shape is the same as the PNG path so
 * the caller (buildLayerInputs) can treat both sources identically.
 *
 * Two try/catch layers:
 *   INNER (per-layer loop) — closes any bitmaps already accumulated in `out`
 *     before rethrowing, so a failure on layer N never leaks bitmaps 1..N-1.
 *   OUTER (whole body) — adds the "psd import: " prefix to any raw throw from
 *     readPsd / new ImageData / createImageBitmap / file.arrayBuffer() that
 *     didn't originate inside this file. Already-prefixed messages pass through
 *     unchanged (inner rethrows and header-guard errors both carry the prefix).
 *
 * No bitmap is ever returned to the caller on a partial failure; the caller
 * takes ownership of the array only if the function resolves successfully.
 */
export async function decodePsdLayers(
  file: File,
): Promise<{ fileName: string; bitmap: ImageBitmap }[]> {
  try {
    const buffer = await file.arrayBuffer();

    // Header guard runs BEFORE ag-psd decodes any layer pixels; this rejects
    // bad signature / PSB / non-RGB / non-8-bit / oversize cheaply upfront.
    const header = parsePsdHeader(buffer);
    validatePsdHeader(header);

    // Metadata preflight: read layer tree WITHOUT pixel data (skipLayerImageData)
    // so we can reject groups and apply the total-pixel budget before the
    // expensive full decode. Groups are rejected here first — this ensures no
    // nested-layer memory spike and makes the top-level count accurate for the
    // budget check. Full selectImportableLayers is not run here because its
    // empty-raster check requires imageData which is intentionally skipped.
    const meta = readPsd(buffer, {
      skipLayerImageData: true,
      skipCompositeImageData: true,
      skipThumbnail: true,
      skipLinkedFilesData: true,
    });
    for (const entry of meta.children ?? []) {
      // Detect groups/folders the same way selectImportableLayers does: presence
      // of `children` on the entry. Reject before the full pixel decode fires.
      if (entry.children !== undefined) {
        const rawName = entry.name ?? "";
        const label = rawName.length > 0 ? `"${rawName}"` : '"(unnamed)"';
        throw new Error(
          `psd import: layer ${label}: groups/folders are not supported in this slice`,
        );
      }
    }
    // With groups rejected, top-level count is the accurate importable-candidate
    // count — no nested layers can inflate the real allocation.
    const conservativeLayerCount = meta.children?.length ?? 0;
    const preflightPixels = totalDecodedPixels(
      meta.width,
      meta.height,
      conservativeLayerCount,
    );
    if (preflightPixels > MAX_PSD_TOTAL_MEGAPIXELS * 1_000_000) {
      throw new Error(
        `psd import: document: ${meta.width}x${meta.height} with ${conservativeLayerCount} layers (${preflightPixels / 1_000_000} MP total) exceeds the ${MAX_PSD_TOTAL_MEGAPIXELS} megapixel total budget`,
      );
    }

    const psd = readPsd(buffer, {
      useImageData: true,
      skipCompositeImageData: true,
      skipThumbnail: true,
      skipLinkedFilesData: true,
    });

    const selected = selectImportableLayers(psd.children ?? []);
    if (selected.length === 0) {
      throw new Error("psd import: no importable raster layers found");
    }

    const out: { fileName: string; bitmap: ImageBitmap }[] = [];

    try {
      for (const { name, layer } of selected) {
        const { data, width, height } = layer.imageData!;
        const left = layer.left ?? 0;
        const top = layer.top ?? 0;

        // Narrow to 8-bit pixel arrays. The header guard already rejected
        // non-8-bit documents, but ag-psd's type for imageData.data is a
        // 4-member union; this explicit check keeps Uint16Array/Float32Array
        // out of the compositor and acts as the narrowing TypeScript needs.
        if (
          !(data instanceof Uint8ClampedArray) &&
          !(data instanceof Uint8Array)
        ) {
          throw new Error(
            `psd import: layer "${name}": unsupported pixel data type`,
          );
        }

        const full = compositeLayerPixels(
          data,
          width,
          height,
          left,
          top,
          psd.width,
          psd.height,
        );
        // compositeLayerPixels always allocates with new Uint8ClampedArray(), so
        // its buffer is always a plain ArrayBuffer. Cast away SharedArrayBuffer
        // from the union so the ImageData constructor overload resolves. The
        // re-wrap (not just the cast) is required because compositeLayerPixels
        // returns Uint8ClampedArray<ArrayBufferLike>, while ImageData's array
        // overload needs Uint8ClampedArray<ArrayBuffer> — do NOT simplify this to
        // `new ImageData(full, …)` or the typecheck breaks.
        const imageData = new ImageData(
          new Uint8ClampedArray(
            full.buffer as ArrayBuffer,
            full.byteOffset,
            full.length,
          ),
          psd.width,
          psd.height,
        );
        const bitmap = await createImageBitmap(imageData, {
          premultiplyAlpha: "none",
          imageOrientation: "none",
        });
        out.push({ fileName: name, bitmap });
      }
    } catch (e) {
      // Inner catch: close all bitmaps accumulated so far before rethrowing.
      // The outer catch will handle prefix-preservation.
      for (const r of out) {
        r.bitmap.close();
      }
      throw e;
    }

    return out;
  } catch (e) {
    // Outer catch: add "psd import: " prefix to raw third-party throws.
    // Already-prefixed errors (header guard, selectImportableLayers, inner
    // loop's typed throws) pass through unchanged.
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith("psd import:")) {
      throw e;
    }
    throw new Error(`psd import: ${msg}`);
  }
}
