import type { IkiGridKeyform } from "@iki/format";

/**
 * Pure, grid-size-agnostic keyform/offset math for authoring a warp-deformer
 * grid by dragging. No DOM, no `@iki/engine` — the load-bearing testable core.
 * Constraints derive only from the input array lengths, never the sample grid.
 */

/**
 * Interpolate the grid offsets at `value`, mirroring the engine's
 * `accumulateKeyformOffsets` clamp+lerp semantics: clamp to the first/last
 * keyform (NO extrapolation) and linearly interpolate the bracketing pair.
 * Returns a NEW array of length `keyforms[0].offsets.length`. Throws on empty.
 */
export function interpolateGridOffsets(
  keyforms: { value: number; offsets: number[] }[],
  value: number,
): number[] {
  if (keyforms.length === 0) {
    throw new Error("interpolateGridOffsets: keyforms must be non-empty");
  }

  if (value <= keyforms[0].value) {
    return [...keyforms[0].offsets];
  }
  const last = keyforms[keyforms.length - 1];
  if (value >= last.value) {
    return [...last.offsets];
  }

  // Find the bracketing pair (keyforms are small in practice).
  let lo = keyforms[0];
  let hi = keyforms[1];
  for (let k = 1; k < keyforms.length - 1; k++) {
    if (keyforms[k].value <= value) {
      lo = keyforms[k];
      hi = keyforms[k + 1];
    }
  }
  const t = (value - lo.value) / (hi.value - lo.value);
  return lo.offsets.map((loOff, i) => loOff + (hi.offsets[i] - loOff) * t);
}

/**
 * Per-control-point delta of the dragged grid from the rest grid: for each
 * point `i`, `(draggedX_i - restX_i, draggedY_i - restY_i)`. The DOM layer
 * assembles the full `restFrameDraggedPoints` (including untouched points), so
 * this is a straight subtract — no prior-offset blending.
 *
 * Both arrays must have the SAME length and that length must be even (x,y
 * pairs). Returns a NEW array of length `restPoints.length`.
 */
export function computeGridOffsets(
  restPoints: number[],
  restFrameDraggedPoints: number[],
): number[] {
  if (restPoints.length !== restFrameDraggedPoints.length) {
    throw new Error(
      `computeGridOffsets: restFrameDraggedPoints length ${restFrameDraggedPoints.length} must equal restPoints length ${restPoints.length}`,
    );
  }
  if (restPoints.length % 2 !== 0) {
    throw new Error(
      `computeGridOffsets: restPoints length ${restPoints.length} must be even (x,y pairs)`,
    );
  }
  return restPoints.map((rest, i) => restFrameDraggedPoints[i] - rest);
}

/**
 * Insert or replace the keyform at `value`, returning a NEW array. If a keyform
 * already exists with an exact-match `value`, REPLACE its offsets (with a copy);
 * otherwise INSERT `{ value, offsets: [...offsets] }` at the position that keeps
 * the array strictly ascending by value. The input array and its keyform objects
 * are never mutated, and `offsets` is copied so the result never aliases the
 * caller's array.
 *
 * Deliberately RANGE-FREE — a generic, reusable array op. Value-range
 * enforcement is the command's job, not this helper's.
 */
export function upsertGridKeyform(
  keyforms: IkiGridKeyform[],
  value: number,
  offsets: number[],
): IkiGridKeyform[] {
  const result = keyforms.map((kf) => ({ value: kf.value, offsets: kf.offsets }));
  const existing = result.findIndex((kf) => kf.value === value);
  if (existing !== -1) {
    result[existing] = { value, offsets: [...offsets] };
    return result;
  }
  const insertAt = result.findIndex((kf) => kf.value > value);
  const entry: IkiGridKeyform = { value, offsets: [...offsets] };
  if (insertAt === -1) {
    result.push(entry);
  } else {
    result.splice(insertAt, 0, entry);
  }
  return result;
}
