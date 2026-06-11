import type { IkiTransformChannel } from "@iki/format";

/**
 * Pure, binding-value logic for computing an endpoint (rest-to-posed delta or
 * ratio) when capturing a transform channel binding. No DOM, no @iki/engine —
 * the single home of the additive-vs-multiplicative rule, reused by both the
 * part and deformer capture paths.
 *
 * Additive channels (translateX, translateY, rotate, scaleX, scaleY) return the
 * delta: `posedValue - restValue`. The binding will multiply that delta across
 * the driven range.
 *
 * Opacity is multiplicative: returns the ratio `posedValue / restValue`. The
 * binding will multiply by that ratio across the driven range. When `restValue`
 * is 0 (a degenerate case: base opacity cannot be represented multiplicatively
 * since 0 * x ≡ 0), this returns 0 as a documented fallback — it does NOT
 * recover `posedValue` and is NOT unit-tested as an identity. The store layer
 * additionally skips an opacity capture when rest opacity is 0, surfacing an
 * editError.
 *
 * Deformer channels never include opacity (they use `IkiMatrixChannel`), so the
 * opacity branch is reached only for parts.
 *
 * Finiteness of the captured value is NOT validated here; the store's
 * `captureEndpoint` finite-value guard is the appropriate layer for that check.
 */
export function captureBindingEndpoint(
  channel: IkiTransformChannel,
  restValue: number,
  posedValue: number,
): number {
  if (channel === "opacity") {
    return restValue === 0 ? 0 : posedValue / restValue;
  }
  return posedValue - restValue;
}
