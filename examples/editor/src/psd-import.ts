// PSD layer pixels are stored at their layer bounds (top/left/right/bottom) per
// the PSD spec — not at canvas origin. compositeLayerPixels places them onto a
// full-document-sized canvas so buildLayerInputs' equal-canvas-size check passes
// and the layer's position is preserved in the output bitmap.

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
    out.set(layerData.subarray(srcRowStart, srcRowStart + copyW * 4), dstRowStart);
  }

  return out;
}
