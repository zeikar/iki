import type { IkiWarp } from "@iki/format";
import type { ParameterStore } from "./parameter-store";

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
    const ks = warp.keyforms;
    const v = params.get(warp.parameter);

    if (v <= ks[0].value) {
      // Clamp to first keyform.
      const { offsets } = ks[0];
      for (let i = 0; i < offsets.length; i++) {
        out[i] += offsets[i];
      }
    } else if (v >= ks[ks.length - 1].value) {
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
        if (ks[k].value <= v) {
          lo = ks[k];
          hi = ks[k + 1];
        }
      }
      const t = (v - lo.value) / (hi.value - lo.value);
      const loOff = lo.offsets;
      const hiOff = hi.offsets;
      for (let i = 0; i < loOff.length; i++) {
        out[i] += loOff[i] + (hiOff[i] - loOff[i]) * t;
      }
    }
  }
}
