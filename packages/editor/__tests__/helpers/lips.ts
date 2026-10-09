/**
 * A synthetic lip set (`mouth_inner`, `lip_lower`, `lip_upper`) with the alpha
 * runs the measurer would record, on the character's 1000 canvas in its
 * mouth's place. Rows are canvas rows (y down); the model y of a row boundary
 * is `500 - row`.
 */
import type { LayerInput } from "../../src/auto-rig/types";

export const OPENING = { x0: 470, x1: 529 };
const t = (x: number) => (x - 499.5) / 30;
/** The opening's top row at canvas column `x`: a gentle smile-shaped curve. */
export const topRow = (x: number): number => 592 + Math.round(2 * t(x) ** 2);
/** The interior's height at `x`, excluding the band under it. */
export const heightAt = (x: number): number =>
  Math.round(22 * Math.sqrt(1 - t(x) ** 2));
const HOOKS = [
  [464, 470],
  [530, 536],
] as const;

export interface LipOptions {
  /** Omit `rowRuns`. */
  noRuns?: boolean;
  /** A one-row line instead of three. */
  thinLine?: boolean;
  /** The skin starts one row higher: the downward grow's overlap. */
  skinOverlap?: boolean;
  /** The interior starts one row higher, up inside the line's ink. */
  underLine?: boolean;
  /** Each layer's box one pixel past its paint, as the measurer grows it. */
  grown?: boolean;
  /** The interior one column wider each side (469, 530), under the hooks'
   *  runs: a hand split's wall column, where the line's bottom is below the
   *  interior's top. */
  grownInner?: boolean;
}

type Col = [col: number, r0: number, r1: number];

function layer(
  role: string,
  cols: Col[],
  noRuns: boolean | undefined,
  g: number,
): LayerInput {
  const x = Math.min(...cols.map((c) => c[0])) - g;
  const x1 = Math.max(...cols.map((c) => c[0])) + 1 + g;
  const y = Math.min(...cols.map((c) => c[1])) - g;
  const y1 = Math.max(...cols.map((c) => c[2])) + g;
  const out: LayerInput = {
    role,
    fileName: `${role}.png`,
    canvasW: 1000,
    canvasH: 1000,
    bbox: { x, y, w: x1 - x, h: y1 - y },
    cropW: x1 - x,
    cropH: y1 - y,
  };
  if (noRuns) return out;
  out.rowRuns = Array.from({ length: y1 - y }, (_, k) => {
    const row = y + k;
    const on = cols
      .filter(([, r0, r1]) => row >= r0 && row < r1)
      .map((c) => c[0])
      .sort((a, b) => a - b);
    const runs: number[] = [];
    for (const c of on) {
      if (runs.length > 0 && runs[runs.length - 1] === c)
        runs[runs.length - 1] = c + 1;
      else runs.push(c, c + 1);
    }
    return runs;
  });
  return out;
}

export function lipSet(opts: LipOptions = {}): LayerInput[] {
  const w = opts.thinLine ? 1 : 3;
  const g = opts.grown ? 1 : 0;
  const xs = Array.from(
    { length: OPENING.x1 - OPENING.x0 + 1 },
    (_, i) => OPENING.x0 + i,
  );
  const hooks = HOOKS.flatMap(([a, b]) =>
    Array.from({ length: b - a }, (_, i) => a + i),
  );
  const inner: Col[] = xs.map((x) => [
    x,
    topRow(x) - (opts.underLine ? 1 : 0),
    topRow(x) + heightAt(x) + 2,
  ]);
  if (opts.grownInner) {
    const a = topRow(470);
    inner.push([469, a, a + 3], [530, a, a + 3]);
  }
  const upper: Col[] = [
    ...xs.map((x): Col => [x, topRow(x) - w, topRow(x)]),
    ...hooks.map((x): Col => [x, 590, 596]),
  ];
  const lower: Col[] = [
    ...xs.map(
      (x): Col => [
        x,
        topRow(x) + heightAt(x) + (opts.skinOverlap ? 1 : 2),
        topRow(x) + heightAt(x) + 8,
      ],
    ),
    ...hooks.map((x): Col => [x, 596, 602]),
  ];
  return [
    layer("mouth_inner", inner, opts.noRuns, g),
    layer("lip_lower", lower, opts.noRuns, g),
    layer("lip_upper", upper, opts.noRuns, g),
  ];
}
