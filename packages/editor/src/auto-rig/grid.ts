/**
 * Warp grids: a family's rest lattice, its turn × nod keyforms, and the
 * landing of a point through them — the same bind-to-rest-cell, sample-the-
 * deformed-cell bilinear the engine renders with, so a cue measured here is
 * the cue the render shows.
 */

import type { Field } from "./fields";
import { cellsFor, clamp, roundTo, type Box } from "./layout";

/** AngleX and AngleY stops: every motion is linear in each on either side of
 *  rest, so the extremes and rest carry it exactly, and the bilinear blend
 *  between them adds a turn and a nod. */
export const X_STOPS = [-30, 0, 30];
export const Y_STOPS = [-30, 0, 30];

export interface Lattice {
  box: Box;
  cols: number;
  rows: number;
  /** Rest points, row-major, row 0 on top. */
  points: number[];
}

export function lattice(
  box: Box,
  cell: number,
  min: number,
  max: number,
): Lattice {
  const cols = cellsFor(box.x1 - box.x0, cell, min, max);
  const rows = cellsFor(box.y1 - box.y0, cell, min, max);
  const points: number[] = [];
  for (let r = 0; r <= rows; r++) {
    const y = box.y1 - ((box.y1 - box.y0) * r) / rows;
    for (let c = 0; c <= cols; c++) {
      points.push(
        roundTo(box.x0 + ((box.x1 - box.x0) * c) / cols, 0.01),
        roundTo(y, 0.01),
      );
    }
  }
  return { box, cols, rows, points };
}

/** Keyforms for every (X_STOPS[i], Y_STOPS[j]) stop, filed at j·|X| + i. */
export function bake(l: Lattice, field: Field): number[][] {
  const out: number[][] = [];
  for (const ay of Y_STOPS) {
    for (const ax of X_STOPS) {
      const offsets: number[] = [];
      for (let k = 0; k < l.points.length; k += 2) {
        if (ax === 0 && ay === 0) {
          offsets.push(0, 0);
          continue;
        }
        const [dx, dy] = field(l.points[k], l.points[k + 1], ax, ay);
        offsets.push(roundTo(dx, 0.1), roundTo(dy, 0.1));
      }
      out.push(offsets);
    }
  }
  return out;
}

/** The offsets at (ax, AngleY 0): the engine's linear blend between the two
 *  AngleX stops around it. */
export function keyformAt(keyforms: number[][], ax: number): number[] {
  const j = Y_STOPS.indexOf(0);
  const row = X_STOPS.map((_, i) => keyforms[j * X_STOPS.length + i]);
  return blendStops(X_STOPS, row, ax);
}

/** Linear blend of per-stop offset arrays at `v` (clamped to the stops). */
export function blendStops(
  values: number[],
  offsets: number[][],
  v: number,
): number[] {
  const x = clamp(v, values[0], values[values.length - 1]);
  let i = 0;
  while (i < values.length - 2 && x > values[i + 1]) i++;
  const t = (x - values[i]) / (values[i + 1] - values[i]);
  return offsets[i].map((o, k) => o + (offsets[i + 1][k] - o) * t);
}

/** Where a rest point lands on the deformed grid (rest + offsets). */
export function land(
  l: Lattice,
  offsets: number[],
  x: number,
  y: number,
): [number, number] {
  const { cols, rows, points } = l;
  const stride = cols + 1;
  let col = cols - 1;
  for (let c = 0; c < cols; c++) {
    if (x < points[(c + 1) * 2]) {
      col = c;
      break;
    }
  }
  let row = rows - 1;
  for (let r = 0; r < rows; r++) {
    if (y > points[(r + 1) * stride * 2 + 1]) {
      row = r;
      break;
    }
  }
  const x0 = points[col * 2];
  const x1 = points[(col + 1) * 2];
  const yT = points[row * stride * 2 + 1];
  const yB = points[(row + 1) * stride * 2 + 1];
  const s = clamp((x - x0) / (x1 - x0), 0, 1);
  const t = clamp((yT - y) / (yT - yB), 0, 1);
  const at = (r: number, c: number): [number, number] => {
    const k = (r * stride + c) * 2;
    return [points[k] + offsets[k], points[k + 1] + offsets[k + 1]];
  };
  const p00 = at(row, col);
  const p10 = at(row, col + 1);
  const p01 = at(row + 1, col);
  const p11 = at(row + 1, col + 1);
  const topX = p00[0] + (p10[0] - p00[0]) * s;
  const topY = p00[1] + (p10[1] - p00[1]) * s;
  const botX = p01[0] + (p11[0] - p01[0]) * s;
  const botY = p01[1] + (p11[1] - p01[1]) * s;
  return [topX + (botX - topX) * t, topY + (botY - topY) * t];
}
