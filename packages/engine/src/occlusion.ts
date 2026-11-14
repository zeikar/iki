import type { IkiOcclusion } from "@ikijs/format";

/**
 * How far a part is hidden at the key parameter's `value`: linear between the
 * stops, held before the first and after the last (one stop is a constant).
 * The player and the rig gate both read it, so they cannot disagree. Exact at
 * every stop. Infinities read as the first or last stop; NaN reads as past the
 * last stop (no comparison with it holds), so the last stop's amount.
 */
export function occlusionAmount(
  occlusion: Pick<IkiOcclusion, "stops">,
  value: number,
): number {
  const { stops } = occlusion;
  const first = stops[0];
  if (value <= first.value) return first.amount;
  for (let i = 1; i < stops.length; i++) {
    const hi = stops[i];
    if (value <= hi.value) {
      const lo = stops[i - 1];
      const t = (value - lo.value) / (hi.value - lo.value);
      return lo.amount * (1 - t) + hi.amount * t;
    }
  }
  return stops[stops.length - 1].amount;
}
