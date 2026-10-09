/**
 * The trim the composer cuts every part by, shared with the lip set's interior:
 * the alpha a trim keeps, and the stray specks a background removal leaves
 * beside a drawing.
 */

import { ALPHA_OPAQUE } from "@ikijs/editor";

/** The alpha a part's trim cuts at: what it keeps is over this. */
export const TRIM_THRESHOLD = 12;
/** Of a part's kept pixels, the share under which a faint detached set is a stray speck. */
export const STRAY_SPECK_FRACTION = 0.01;

/** Luma (0..255) of the RGBA pixel at byte offset `i`. */
export function luma(rgba: Buffer, i: number): number {
  return 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
}

/**
 * The box of a trimmed part without its stray specks, or null when no stray
 * speck lies outside its drawing. The part's kept pixels (alpha over
 * TRIM_THRESHOLD, the trim's own cut) form 8-connected sets; a stray speck is
 * a set that never reaches ALPHA_OPAQUE and holds under STRAY_SPECK_FRACTION of
 * them, the residue a background removal leaves beside a drawing. Kept, one
 * such speck widened a generated body's box by 70 px on one side and placed
 * the body 32 px off its centre. A drawn stroke reaches ALPHA_OPAQUE, so a
 * detached wisp or strand is never dropped, and a part painted wholly under
 * it (a soft blush) drops nothing.
 */
export function boxWithoutStraySpecks(
  rgba: Buffer,
  W: number,
  H: number,
): { left: number; top: number; width: number; height: number } | null {
  const n = W * H;
  // The share is of the whole part, so count it before any set is judged.
  let kept = 0;
  for (let p = 0; p < n; p++) if (rgba[p * 4 + 3] > TRIM_THRESHOLD) kept++;
  // Each set is judged as its fill ends and only its box is kept, so memory
  // is a byte per pixel plus a stack grown to the deepest fill, not a label
  // per pixel and a record per set. A pixel is marked as it is pushed, so the
  // stack never outgrows the image.
  const visited = new Uint8Array(n);
  let stack = new Int32Array(1024);
  // [left, top, right, bottom] of the drawing's sets and of the stray ones.
  const drawing = [W, H, -1, -1];
  const strays = [W, H, -1, -1];
  let anyOpaque = false;
  for (let start = 0; start < n; start++) {
    if (visited[start] || rgba[start * 4 + 3] <= TRIM_THRESHOLD) continue;
    let setLeft = W;
    let setTop = H;
    let setRight = -1;
    let setBottom = -1;
    let size = 0;
    let opaque = false;
    let depth = 0;
    visited[start] = 1;
    stack[depth++] = start;
    while (depth > 0) {
      const p = stack[--depth];
      size++;
      if (rgba[p * 4 + 3] >= ALPHA_OPAQUE) opaque = true;
      const px = p % W;
      const py = (p - px) / W;
      setLeft = Math.min(setLeft, px);
      setTop = Math.min(setTop, py);
      setRight = Math.max(setRight, px);
      setBottom = Math.max(setBottom, py);
      for (let y = Math.max(0, py - 1); y <= Math.min(H - 1, py + 1); y++) {
        for (let x = Math.max(0, px - 1); x <= Math.min(W - 1, px + 1); x++) {
          const q = y * W + x;
          if (!visited[q] && rgba[q * 4 + 3] > TRIM_THRESHOLD) {
            visited[q] = 1;
            if (depth === stack.length) {
              const grown = new Int32Array(Math.min(n, stack.length * 2));
              grown.set(stack);
              stack = grown;
            }
            stack[depth++] = q;
          }
        }
      }
    }
    anyOpaque ||= opaque;
    const into =
      !opaque && size < kept * STRAY_SPECK_FRACTION ? strays : drawing;
    into[0] = Math.min(into[0], setLeft);
    into[1] = Math.min(into[1], setTop);
    into[2] = Math.max(into[2], setRight);
    into[3] = Math.max(into[3], setBottom);
  }
  if (!anyOpaque || strays[2] < 0) return null;
  const [left, top, right, bottom] = drawing;
  // A set's box reaches past the drawing's only where one of its pixels does,
  // and a speck inside the drawing's box moves nothing, so it is left be.
  if (
    strays[0] >= left &&
    strays[1] >= top &&
    strays[2] <= right &&
    strays[3] <= bottom
  )
    return null;
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}
