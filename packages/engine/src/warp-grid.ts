import type { IkiDeformer, IkiWarpGrid } from "@iki/format";
import type { Affine } from "./affine";
import type { ParameterStore } from "./parameter-store";
import { accumulateKeyformOffsets } from "./warp";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** A warp deformer's deformed control grid for one frame. */
export interface ResolvedWarpGrid {
  cols: number;
  rows: number;
  /** Deformed control points, MODEL space, length (cols+1)*(rows+1)*2. */
  points: Float32Array;
}

/**
 * For each warp deformer: take its rest `grid.points`, ADD the interpolated
 * grid-keyform offsets (accumulateKeyformOffsets) in the deformer's own rest
 * frame, THEN apply the parent matrix deformer's resolved world affine (if any)
 * — i.e. `parentAffine · (rest + offsets)`. Returns a Map from warp-deformer id
 * to its deformed grid (model space).
 *
 * `matrixWorlds` is the output of resolveDeformerWorlds (matrix deformers only);
 * warp deformers are skipped by that resolver (they are non-affine).
 *
 * ORDER IS CRITICAL: keyform offsets FIRST (curvature added in the rest frame),
 * parent affine SECOND — so the curvature rotates WITH the parent head rather
 * than staying pinned to world axes. The reversed order (affine then offsets)
 * pushes the bend along world-x even when the head is turned (coordinate bug).
 */
export function resolveWarpGrids(
  deformers: IkiDeformer[],
  params: ParameterStore,
  matrixWorlds: Map<string, Affine>,
): Map<string, ResolvedWarpGrid> {
  const resolved = new Map<string, ResolvedWarpGrid>();

  for (const d of deformers) {
    if (d.kind !== "warp") continue;

    const { cols, rows, points: restPoints } = d.grid;
    const points = Float32Array.from(restPoints);

    // 1. Curvature in the rest frame: offsets += per-control-point deltas.
    for (const warp of d.warps ?? []) {
      accumulateKeyformOffsets(
        warp.keyforms,
        params.get(warp.parameter),
        points,
      );
    }

    // 2. Parent matrix deformer's world affine (if any): parentAffine · (rest + offsets).
    if (d.parent !== undefined) {
      const parentAffine = matrixWorlds.get(d.parent);
      if (parentAffine) {
        for (let i = 0; i < points.length; i += 2) {
          const x = points[i];
          const y = points[i + 1];
          points[i] =
            parentAffine[0] * x + parentAffine[2] * y + parentAffine[4];
          points[i + 1] =
            parentAffine[1] * x + parentAffine[3] * y + parentAffine[5];
        }
      }
    }

    resolved.set(d.id, { cols, rows, points });
  }

  return resolved;
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
