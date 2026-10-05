/**
 * Clamp `value` into `[min, max]`.
 *
 * NaN in, NaN out — `Math.max(min, Math.min(max, NaN))` is `NaN`, so this
 * cannot be used to sanitize external input. Anything taking values from a
 * host must reject non-finite input itself before clamping (see
 * {@link ParameterStore.set}).
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Linear interpolation from `a` (at `t = 0`) to `b` (at `t = 1`). Exact at
 * `t = 0` and when `a === b`; at `t = 1` it can differ from `b` by rounding.
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Smoothstep `x²(3 − 2x)` of `x` clamped to `[0, 1]`: 0 at 0, 1 at 1, with zero
 * slope at both ends, so a fade along it starts and lands without a kink.
 * Exact at 0, 1/2 and 1.
 */
export function smoothstep(x: number): number {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}
