/**
 * A matrix deformer's world affine at a pose, from the emitted `IkiDeformer`
 * data alone: the closed form of the engine's `resolveDeformers` for the only
 * chains the generator emits above `headDeformer` — no parent (a bust), or a
 * root warp carrying 1D warps (`bodyWarp`). The editor depends on the format
 * alone, so the rules of `deform.ts` and `warp-grid.ts` are restated here, in
 * float64. Anything else throws rather than guess.
 */
import type {
  IkiDeformer,
  IkiMatrixDeformer,
  IkiParameter,
  IkiWarpDeformer,
} from "@ikijs/format";
import { bindToRest, blendStops } from "./grid";

/** `[a, b, c, d, e, f]`: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Affine = [number, number, number, number, number, number];

function multiply(a: Affine, b: Affine): Affine {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

/** The parameter's value, clamped into its range, resting at its default: the
 *  engine's `ParameterStore` (`get`, and `normalized` for a binding's t). */
function valueOf(
  parameters: IkiParameter[],
  values: Record<string, number>,
  id: string,
): number {
  const p = parameters.find((q) => q.id === id);
  if (p === undefined) return 0;
  const v = values[id] ?? p.default;
  return Math.min(p.max, Math.max(p.min, v));
}

/** translate(pivot) · translate · rotate · scale · translate(−pivot), the
 *  transform and bindings read at the values: the engine's `evaluateTransform`
 *  and `deformerLocalMatrix`. */
function ownMatrix(
  d: IkiMatrixDeformer,
  parameters: IkiParameter[],
  values: Record<string, number>,
): Affine {
  let x = d.transform?.x ?? 0;
  let y = d.transform?.y ?? 0;
  let rotation = d.transform?.rotation ?? 0;
  let sx = d.transform?.scaleX ?? 1;
  let sy = d.transform?.scaleY ?? 1;
  for (const b of d.bindings ?? []) {
    const p = parameters.find((q) => q.id === b.parameter);
    const t =
      p === undefined || p.max === p.min
        ? 0
        : (valueOf(parameters, values, b.parameter) - p.min) / (p.max - p.min);
    const v = b.from + (b.to - b.from) * t;
    if (b.channel === "translateX") x += v;
    else if (b.channel === "translateY") y += v;
    else if (b.channel === "rotate") rotation += v;
    else if (b.channel === "scaleX") sx += v;
    else if (b.channel === "scaleY") sy += v;
  }
  const r = (rotation * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  // translate · rotate · scale
  const trs: Affine = [c * sx, s * sx, -s * sy, c * sy, x, y];
  return multiply(multiply([1, 0, 0, 1, d.pivot.x, d.pivot.y], trs), [
    1,
    0,
    0,
    1,
    -d.pivot.x,
    -d.pivot.y,
  ]);
}

/** The warp's local grid at the values: its rest points plus each 1D warp's
 *  keyform offsets blended at its parameter, summed: the engine's
 *  `deformWarpGrid` and `accumulateKeyformOffsets`. */
function localGrid(
  w: IkiWarpDeformer,
  parameters: IkiParameter[],
  values: Record<string, number>,
): number[] {
  const points = [...w.grid.points];
  for (const warp of w.warps ?? []) {
    const offsets = blendStops(
      warp.keyforms.map((k) => k.value),
      warp.keyforms.map((k) => k.offsets),
      valueOf(parameters, values, warp.parameter),
    );
    for (let i = 0; i < points.length; i++) points[i] += offsets[i];
  }
  return points;
}

/** The rigid frame of the cell holding `pivot`: the rule of the engine's
 *  `warpRigidFrame` (bind to the rest grid, sample the local grid, turn by the
 *  rotation part of the cell's Jacobian). */
function riddenFrame(
  pivot: { x: number; y: number },
  w: IkiWarpDeformer,
  q: number[],
): Affine {
  const { cols, points: rest } = w.grid;
  const stride = cols + 1;
  // grid.ts binds by the engine's rule, edges included (a point on a row line
  // binds into the cell below), so the pivot's cell is read there.
  const { row, col, s, t } = bindToRest(w.grid, pivot.x, pivot.y);
  const xl = rest[col * 2];
  const xr = rest[(col + 1) * 2];
  const yt = rest[row * stride * 2 + 1];
  const yb = rest[(row + 1) * stride * 2 + 1];

  const i00 = (row * stride + col) * 2;
  const i10 = (row * stride + col + 1) * 2;
  const i01 = ((row + 1) * stride + col) * 2;
  const i11 = ((row + 1) * stride + col + 1) * 2;
  const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

  const topX = lerp(q[i00], q[i10], s);
  const topY = lerp(q[i00 + 1], q[i10 + 1], s);
  const botX = lerp(q[i01], q[i11], s);
  const botY = lerp(q[i01 + 1], q[i11 + 1], s);
  const px = lerp(topX, botX, t);
  const py = lerp(topY, botY, t);

  const width = xr - xl;
  const height = yt - yb;
  const exX = lerp(q[i10] - q[i00], q[i11] - q[i01], t) / width;
  const exY = lerp(q[i10 + 1] - q[i00 + 1], q[i11 + 1] - q[i01 + 1], t) / width;
  const eyX = -lerp(q[i01] - q[i00], q[i11] - q[i10], s) / height;
  const eyY =
    -lerp(q[i01 + 1] - q[i00 + 1], q[i11 + 1] - q[i10 + 1], s) / height;

  const theta = Math.atan2(exY - eyX, exX + eyY);
  const c = Math.cos(theta);
  const sn = Math.sin(theta);
  return [
    c,
    sn,
    -sn,
    c,
    px - (c * pivot.x - sn * pivot.y),
    py - (sn * pivot.x + c * pivot.y),
  ];
}

/**
 * The world affine of matrix deformer `id` at `values` (parameter id → value;
 * a parameter not named rests at its default, an id the model does not declare
 * throws, and every value is clamped into
 * its range as the engine's store does). Throws on a chain the generator does
 * not emit: a matrix parent, a `warp2d` parent, or a warp with a parent.
 */
export function matrixWorldAt(
  deformers: IkiDeformer[],
  parameters: IkiParameter[],
  id: string,
  values: Record<string, number> = {},
): Affine {
  for (const key of Object.keys(values)) {
    if (!parameters.some((q) => q.id === key)) {
      throw new Error(`chain: unknown parameter "${key}"`);
    }
  }
  const d = deformers.find((x) => x.id === id);
  if (d === undefined) throw new Error(`chain: no deformer "${id}"`);
  if (d.kind === "warp") {
    throw new Error(`chain: "${id}" is a warp deformer, not a matrix`);
  }
  const own = ownMatrix(d, parameters, values);
  if (d.parent === undefined) return own;

  const parent = deformers.find((x) => x.id === d.parent);
  if (parent === undefined) {
    throw new Error(`chain: "${id}" has an unknown parent "${d.parent}"`);
  }
  if (parent.kind !== "warp") {
    throw new Error(
      `chain: "${id}" hangs from the matrix deformer "${parent.id}"; only a root warp is supported`,
    );
  }
  if (parent.parent !== undefined) {
    throw new Error(
      `chain: "${id}" hangs from warp "${parent.id}", which has a parent "${parent.parent}"; only a root warp is supported`,
    );
  }
  if (parent.warp2d !== undefined) {
    throw new Error(
      `chain: "${id}" hangs from warp "${parent.id}", which carries a warp2d; only 1D warps are supported`,
    );
  }
  return multiply(
    riddenFrame(d.pivot, parent, localGrid(parent, parameters, values)),
    own,
  );
}
