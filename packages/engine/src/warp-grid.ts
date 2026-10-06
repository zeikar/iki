import type { IkiWarpDeformer, IkiWarpGrid } from "@ikijs/format";
import type { Affine } from "./affine";
import type { ParameterStore } from "./parameter-store";
import { clamp, lerp } from "./math";
import { accumulate2DKeyformOffsets, accumulateKeyformOffsets } from "./warp";

/** A warp deformer's deformed control grid for one frame. */
export interface ResolvedWarpGrid {
  cols: number;
  rows: number;
  /** Deformed control points, MODEL space, length (cols+1)*(rows+1)*2. */
  points: Float32Array;
}

/**
 * A warp deformer's LOCAL deformed grid: its rest `grid.points` plus the
 * interpolated grid-keyform offsets, in the deformer's own rest frame — no
 * parent affine. Returns a new array; the rest grid is never written.
 */
export function deformWarpGrid(
  d: IkiWarpDeformer,
  params: ParameterStore,
): Float32Array {
  const points = Float32Array.from(d.grid.points);
  for (const warp of d.warps ?? []) {
    accumulateKeyformOffsets(warp.keyforms, params.get(warp.parameter), points);
  }
  // 1D xor 2D is validator-enforced; at most one branch contributes per deformer.
  if (d.warp2d !== undefined) {
    accumulate2DKeyformOffsets(
      d.warp2d.valuesX,
      d.warp2d.valuesY,
      d.warp2d.keyforms2d,
      params.get(d.warp2d.parameter),
      params.get(d.warp2d.parameterY),
      points,
    );
  }
  return points;
}

/**
 * `affine` applied to every [x, y] of a flat grid, into a NEW array — the
 * input (a warp's local grid, which a matrix child's rigid frame still
 * reads) is left as is.
 */
export function transformGridPoints(
  points: Float32Array,
  affine: Affine,
): Float32Array {
  const out = new Float32Array(points.length);
  for (let i = 0; i < points.length; i += 2) {
    const x = points[i];
    const y = points[i + 1];
    out[i] = affine[0] * x + affine[2] * y + affine[4];
    out[i + 1] = affine[1] * x + affine[3] * y + affine[5];
  }
  return out;
}

/** A model-space point bound to a rest-grid cell with within-cell (s,t). */
export interface GridBinding {
  /** row*cols + col index of the containing cell. */
  cell: number;
  /** [0,1] within-cell horizontal, 0 at the left (smaller-x) edge. */
  s: number;
  /** [0,1] within-cell vertical, 0 at the TOP (larger-y) edge. */
  t: number;
}

/**
 * Bind a model-space point to the REST grid: computes the containing cell +
 * local (s,t) by linear mapping over the grid's actual column/row boundaries.
 * Out-of-bounds points clamp to an edge cell with s/t pinned to 0/1. Never
 * returns NaN. Do NOT call against a deformed grid.
 *
 * The rest grid is validated to be a regular axis-aligned lattice with EXACT
 * ordering, so boundaries are read DIRECTLY from `restGrid.points` (no sorting):
 *   - row-major, +y up; row 0 = TOP (LARGEST y, y DECREASES with row index);
 *   - column 0 = LEFT (smallest x, x INCREASES with column index).
 * Column x-boundaries are row 0's x values `points[col*2]`; row y-boundaries are
 * column 0's y values `points[(row*(cols+1))*2 + 1]`. Maps x left→right and y
 * top→bottom: `s = (x - xLeft)/(xRight - xLeft)`, `t = (yTop - y)/(yTop - yBottom)`
 * (numerator `yTop - y`, NOT `y - minY`, so rows are not vertically flipped).
 */
export function bindPointToRestGrid(
  x: number,
  y: number,
  restGrid: IkiWarpGrid,
): GridBinding {
  const { cols, rows, points } = restGrid;
  const stride = cols + 1;

  // Column boundaries: row 0's x values, increasing with column index.
  let col = cols - 1;
  for (let c = 0; c < cols; c++) {
    const xRight = points[(c + 1) * 2];
    if (x < xRight) {
      col = c;
      break;
    }
  }
  const xLeft = points[col * 2];
  const xRight = points[(col + 1) * 2];
  const s = clamp((x - xLeft) / (xRight - xLeft), 0, 1);

  // Row boundaries: column 0's y values, decreasing with row index (top→bottom).
  let row = rows - 1;
  for (let r = 0; r < rows; r++) {
    const yBottom = points[(r + 1) * stride * 2 + 1];
    if (y > yBottom) {
      row = r;
      break;
    }
  }
  const yTop = points[row * stride * 2 + 1];
  const yBottom = points[(row + 1) * stride * 2 + 1];
  const t = clamp((yTop - y) / (yTop - yBottom), 0, 1);

  return { cell: row * cols + col, s, t };
}

/**
 * Compute model-space positions for a warp-deformer child's mesh vertices:
 * transform each LOCAL-space vertex by `partAffine`, rebind to the RAW rest
 * grid, and bilinear-sample the deformed grid. Writes `out` (length ===
 * localVerts.length). Affine layout [a,b,c,d,e,f]: x'=a*x+c*y+e, y'=b*x+d*y+f.
 */
export function applyWarpToChild(
  localVerts: Float32Array | number[],
  partAffine: Affine,
  restGrid: IkiWarpGrid,
  deformedGrid: ResolvedWarpGrid,
  out: Float32Array,
): void {
  const n = localVerts.length / 2;
  for (let v = 0; v < n; v++) {
    const lx = localVerts[v * 2];
    const ly = localVerts[v * 2 + 1];
    const mx = partAffine[0] * lx + partAffine[2] * ly + partAffine[4];
    const my = partAffine[1] * lx + partAffine[3] * ly + partAffine[5];
    const binding = bindPointToRestGrid(mx, my, restGrid);
    const [sx, sy] = sampleWarpGrid(deformedGrid, binding);
    out[v * 2] = sx;
    out[v * 2 + 1] = sy;
  }
}

/**
 * Bilinear-sample a deformed grid at a binding, returning model-space [x, y].
 * Reads the 4 corner control points of `binding.cell` from `grid.points`, using
 * the SAME row/col convention as `bindPointToRestGrid` (s left→right between
 * col and col+1, t top→bottom between row and row+1).
 */
export function sampleWarpGrid(
  grid: ResolvedWarpGrid,
  binding: GridBinding,
): [number, number] {
  const { cols, points } = grid;
  const stride = cols + 1;
  const row = Math.floor(binding.cell / cols);
  const col = binding.cell % cols;
  const { s, t } = binding;

  const i00 = (row * stride + col) * 2;
  const i10 = (row * stride + col + 1) * 2;
  const i01 = ((row + 1) * stride + col) * 2;
  const i11 = ((row + 1) * stride + col + 1) * 2;

  // Top edge: lerp p00→p10 by s; bottom edge: lerp p01→p11 by s.
  const topX = points[i00] + (points[i10] - points[i00]) * s;
  const topY = points[i00 + 1] + (points[i10 + 1] - points[i00 + 1]) * s;
  const botX = points[i01] + (points[i11] - points[i01]) * s;
  const botY = points[i01 + 1] + (points[i11 + 1] - points[i01 + 1]) * s;

  // Vertical: lerp top→bottom by t.
  return [topX + (botX - topX) * t, topY + (botY - topY) * t];
}

/**
 * Rigid frame of a matrix deformer hung from a warp: returns
 * `translate(p') · rotate(θ) · translate(−p)`, where `p` is `pivot` bound to the
 * RAW rest grid and `p'` is that binding sampled on `localPoints`, the warp's
 * LOCAL deformed grid (rest + keyform offsets, no ancestor affine — the caller
 * composes that on top). θ is the rotation part (polar decomposition) of the
 * bilinear cell's Jacobian at the binding, each tangent divided by the rest
 * cell's width/height so the rest grid gives θ = 0. The warp's scale and shear
 * are deliberately dropped: a narrowing torso warp moves the head but never
 * squashes it.
 */
export function warpRigidFrame(
  pivot: { x: number; y: number },
  restGrid: IkiWarpGrid,
  localPoints: Float32Array,
): Affine {
  const { cols, rows } = restGrid;
  const binding = bindPointToRestGrid(pivot.x, pivot.y, restGrid);
  const [px, py] = sampleWarpGrid({ cols, rows, points: localPoints }, binding);

  const stride = cols + 1;
  const row = Math.floor(binding.cell / cols);
  const col = binding.cell % cols;
  const { s, t } = binding;
  const i00 = (row * stride + col) * 2;
  const i10 = (row * stride + col + 1) * 2;
  const i01 = ((row + 1) * stride + col) * 2;
  const i11 = ((row + 1) * stride + col + 1) * 2;

  const rest = restGrid.points;
  // Same boundaries as bindPointToRestGrid (row 0's x, column 0's y): the
  // validator tolerates 1e-6 of jitter elsewhere, which can zero a cell's own
  // corner difference.
  const cellWidth = rest[(col + 1) * 2] - rest[col * 2];
  const cellHeight =
    rest[row * stride * 2 + 1] - rest[(row + 1) * stride * 2 + 1];

  // Images of the rest x/y axes. t runs top→bottom, i.e. against +y, hence
  // the minus on ey.
  const q = localPoints;
  const exX = lerp(q[i10] - q[i00], q[i11] - q[i01], t) / cellWidth;
  const exY =
    lerp(q[i10 + 1] - q[i00 + 1], q[i11 + 1] - q[i01 + 1], t) / cellWidth;
  const eyX = -lerp(q[i01] - q[i00], q[i11] - q[i10], s) / cellHeight;
  const eyY =
    -lerp(q[i01 + 1] - q[i00 + 1], q[i11 + 1] - q[i10 + 1], s) / cellHeight;

  // A collapsed cell gives atan2(0, 0) = 0: the frame stays finite.
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
