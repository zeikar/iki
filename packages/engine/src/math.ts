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
