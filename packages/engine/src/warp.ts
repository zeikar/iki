import type { IkiGrid2DKeyform, IkiWarp } from "@iki/format";
import type { ParameterStore } from "./parameter-store";

/**
 * Accumulate one keyform set's interpolated offsets into `out` (out += ...).
 * Clamps `value` to [keyforms[0].value, keyforms[last].value] (no extrapolation),
 * linearly interpolates the bracketing pair, and adds. `out.length` must be >=
 * each keyform's `offsets.length`. Shared by part-local mesh warps and grid warps.
 */
export function accumulateKeyformOffsets(
  keyforms: { value: number; offsets: ArrayLike<number> }[],
  value: number,
  out: Float32Array,
): void {
  const ks = keyforms;

  if (value <= ks[0].value) {
    // Clamp to first keyform.
    const { offsets } = ks[0];
    for (let i = 0; i < offsets.length; i++) {
      out[i] += offsets[i];
    }
  } else if (value >= ks[ks.length - 1].value) {
    // Clamp to last keyform.
    const { offsets } = ks[ks.length - 1];
    for (let i = 0; i < offsets.length; i++) {
      out[i] += offsets[i];
    }
  } else {
    // Find bracketing pair with a linear scan (keyforms are small in practice).
    let lo = ks[0];
    let hi = ks[1];
    for (let k = 1; k < ks.length - 1; k++) {
      if (ks[k].value <= value) {
        lo = ks[k];
        hi = ks[k + 1];
      }
    }
    const t = (value - lo.value) / (hi.value - lo.value);
    const loOff = lo.offsets;
    const hiOff = hi.offsets;
    for (let i = 0; i < loOff.length; i++) {
      out[i] += loOff[i] + (hiOff[i] - loOff[i]) * t;
    }
  }
}

/**
 * Accumulate a 2D keyform grid's bilinear-interpolated offsets into `out` (out += ...).
 *
 * This is PARAMETER bilinear interpolation driven by two live parameter values
 * (`vx` along `valuesX`, `vy` along `valuesY`). It is DISTINCT from
 * {@link sampleWarpGrid}'s spatial bilinear (which interpolates model-space
 * control-point positions). Name params `tx`/`ty` to avoid confusion with
 * the spatial `s`/`t` in sampleWarpGrid.
 *
 * Contract mirrors {@link accumulateKeyformOffsets}: `out += blended offsets`,
 * pure, deterministic, no allocation inside the function, O(points).
 *
 * Bracket rule (applied identically to X and Y; length ≥ 2 is validator-guaranteed):
 *   - v <= values[0]          → i = 0,          t = 0
 *   - v >= values[last]       → i = length - 2,  t = 1
 *   - interior                → i such that values[i] <= v < values[i+1], t = (v - values[i]) / (values[i+1] - values[i])
 * This keeps i ∈ [0, length-2] so i+1 is always in range.
 *
 * Corner index (row-major): k(i, j) = j * valuesX.length + i
 */
export function accumulate2DKeyformOffsets(
  valuesX: number[],
  valuesY: number[],
  keyforms2d: IkiGrid2DKeyform[],
  vx: number,
  vy: number,
  out: Float32Array,
): void {
  const lastX = valuesX.length - 1;
  const lastY = valuesY.length - 1;

  // Per-axis bracket: clamp at both ends, interior normal scan.
  let ix: number;
  let tx: number;
  if (vx <= valuesX[0]) {
    ix = 0;
    tx = 0;
  } else if (vx >= valuesX[lastX]) {
    ix = lastX - 1;
    tx = 1;
  } else {
    ix = 0;
    for (let k = 0; k < lastX - 1; k++) {
      if (valuesX[k + 1] <= vx) ix = k + 1;
    }
    tx = (vx - valuesX[ix]) / (valuesX[ix + 1] - valuesX[ix]);
  }

  let iy: number;
  let ty: number;
  if (vy <= valuesY[0]) {
    iy = 0;
    ty = 0;
  } else if (vy >= valuesY[lastY]) {
    iy = lastY - 1;
    ty = 1;
  } else {
    iy = 0;
    for (let k = 0; k < lastY - 1; k++) {
      if (valuesY[k + 1] <= vy) iy = k + 1;
    }
    ty = (vy - valuesY[iy]) / (valuesY[iy + 1] - valuesY[iy]);
  }

  // Row-major corners: k(i, j) = j * valuesX.length + i.
  const W = valuesX.length;
  const c00 = keyforms2d[iy * W + ix];
  const c10 = keyforms2d[iy * W + ix + 1];
  const c01 = keyforms2d[(iy + 1) * W + ix];
  const c11 = keyforms2d[(iy + 1) * W + ix + 1];

  // Per-component bilinear: top/bot over tx, then ty into out.
  const o00 = c00.offsets;
  const o10 = c10.offsets;
  const o01 = c01.offsets;
  const o11 = c11.offsets;
  for (let n = 0; n < o00.length; n++) {
    const top = o00[n] + (o10[n] - o00[n]) * tx;
    const bot = o01[n] + (o11[n] - o01[n]) * tx;
    out[n] += top + (bot - top) * ty;
  }
}

/**
 * Apply all warps to `rest`, accumulating per-vertex offsets into `out`.
 *
 * - Copies `rest` into `out` first (out = rest).
 * - For each warp: looks up the live parameter value (REAL range, not
 *   normalized), clamps to the keyform range (no extrapolation), linearly
 *   interpolates the bracketing pair, and ADDS the result to `out`.
 * - No allocation: writes into the caller-supplied `out`. `rest` is never
 *   mutated.
 * - `undefined` warps → identity copy (out equals rest).
 */
export function applyWarps(
  rest: Float32Array,
  warps: IkiWarp[] | undefined,
  params: ParameterStore,
  out: Float32Array,
): void {
  out.set(rest);

  if (!warps || warps.length === 0) return;

  for (const warp of warps) {
    accumulateKeyformOffsets(warp.keyforms, params.get(warp.parameter), out);
  }
}
