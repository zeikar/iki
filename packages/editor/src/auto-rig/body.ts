/**
 * The body warp: one root warp grid over the whole body. It turns the upper
 * body on BodyAngleX/Y/Z, follows the head's turn (AngleX) and tilt (AngleZ)
 * a little, and breathes, with everything under the hips planted. The head
 * and the shoulders hang from it as matrix deformers, each riding the cell
 * that holds its pivot rigidly (the engine's `warpRigidFrame`).
 *
 * Every warp offsets a lattice point by its row line's weight times one field
 * (the keyform table in `buildBodyWarp`). The row lines run in three bands,
 * top to bottom:
 * - band A, weight 1, from P (`BODY_GRID_PAD`) above the highest of the
 *   body's top and the pivots down to `yFull`: CHEST_DROP under the chin, or
 *   P above the lowest pivot if that is lower;
 * - the ramp, weight smoothstep(a, yFull, y), down to the hips' line a
 *   (`hipLine`), weight 0, so the waist bends smoothly into the legs;
 * - one weight-0 cell from a to P under the lower of a and the body's bottom.
 * On a body too short for that, `yFull` is the midpoint of a and the lowest
 * pivot: both bands shrink to the gap between them, and a stays the zero line.
 *
 * Each pivot's cell is all weight 1. Every pivot lies strictly above `yFull`,
 * and the engine binds a point that sits on a row line into the cell below
 * that line, so the cell holding a pivot has its four corners in band A. The
 * cell then moves by one affine map, and a matrix child rides it rigidly: the
 * head and the shoulders turn with the upper body and are never sheared by
 * the ramp.
 *
 * Every line and pivot is on the 0.01 grid, as the written model is, so the
 * bands need the lowest pivot only 0.02 above the hips, room for `yFull`
 * between them; less is art the rig cannot build on (`LayerGeometryError`).
 */

import {
  StandardParameter as P,
  type IkiGridWarp,
  type IkiMesh,
  type IkiWarpDeformer,
} from "@ikijs/format";
import {
  bh,
  boxOfLayer,
  bw,
  cellsFor,
  cx,
  cy,
  DEG,
  roundTo,
  smoothstep,
  type Box,
} from "./layout";
import { Z_STOPS } from "./drivers";
import { X_STOPS } from "./grid";
import { AMPLITUDE, BODY, ROLL_DEG } from "./profile";
import { LayerGeometryError, type LayerInput } from "./types";

type Point = { x: number; y: number };

export const BODY_WARP_ID = "bodyWarp";
/** P: how far the lattice reaches past the body and every pivot, px. Our
 *  own value. */
export const BODY_GRID_PAD = 6;
/** Band A reaches this far under the chin, hh: the chest moves as one. Our
 *  own value. */
export const CHEST_DROP = 0.8;
/** The body crop's rows the leg split is looked for in, as fractions of its
 *  height, top to bottom. Our own values. */
const HIP_BAND = [0.35, 0.75] as const;
/** A run is a leg when it is at least this share of the crop's width. Our
 *  own value. */
const LEG_MIN = 0.1;
/** With no leg split and no cut, the hips lie this share of the body's
 *  height under its top. Our own value. */
export const HIP_FRACTION = 0.5;
/** The body mesh's rows are at most this tall, px. Our own value. */
export const BODY_MESH_PX = 48;
/** BodyAngleX/Y/Z stops: each motion is linear either side of rest, so the
 *  extremes and rest carry it exactly. */
const BODY_STOPS = [-10, 0, 10];

/**
 * The hips' line a, model y: the body warp's weight-0 line, which nothing
 * under moves. The first rule that applies:
 * 1. the leg split: the top edge of the first crop row in `HIP_BAND` holding
 *    two or more runs (`rowRuns`) each at least `LEG_MIN` of the crop's
 *    width;
 * 2. the cut: a crop reaching the canvas's last row (a waist-cut bust) is
 *    planted at its bottom edge;
 * 3. `HIP_FRACTION` of the body's height under its top.
 */
export function hipLine(layer: LayerInput): number {
  const { bbox, canvasH, rowRuns } = layer;
  // Model y of the crop's top edge; crop row k's top edge is `top − k`.
  const top = canvasH / 2 - bbox.y;
  if (rowRuns !== undefined) {
    const legMin = LEG_MIN * bbox.w;
    const last = Math.floor(HIP_BAND[1] * bbox.h);
    for (let k = Math.ceil(HIP_BAND[0] * bbox.h); k <= last; k++) {
      const runs = rowRuns[k];
      let legs = 0;
      for (let i = 0; i < runs.length; i += 2) {
        if (runs[i + 1] - runs[i] >= legMin) legs++;
      }
      if (legs >= 2) return roundTo(top - k, 0.01);
    }
  }
  if (bbox.y + bbox.h === canvasH) return roundTo(top - bbox.h, 0.01);
  return roundTo(top - HIP_FRACTION * bbox.h, 0.01);
}

export interface BodyLattice {
  /** Column lines, model x, left to right. */
  xs: number[];
  /** Row lines, model y, top to bottom. */
  ys: number[];
  /** Each row line's weight. */
  weights: number[];
  /** Band A's lowest line, model y. */
  yFull: number;
}

/**
 * The body warp's rest lattice: its row lines and their weights as the
 * header sets them out, its columns even over the body and every pivot, P to
 * spare. `chin` and `pivots` are the pivots of the matrix deformers that hang
 * from the warp, `anchor` the hips' line (`hipLine`), which comes through as
 * the zero-weight line unchanged.
 */
export function bodyLattice(
  body: LayerInput,
  chin: Point,
  hh: number,
  pivots: Point[],
  anchor: number,
): BodyLattice {
  const b = boxOfLayer(body);
  // Lines are worked out in whole hundredths, the grid the model is written
  // on, so every gap is exact. Each value is snapped by the same `roundTo`
  // the written pivots go through: a bare Math.round(v·100) disagrees with
  // it on some x.xx5 inputs, which could put a written pivot on `yFull`.
  const g = (v: number) => Math.round(roundTo(v, 0.01) * 100);
  const pad = BODY_GRID_PAD * 100;
  const all = [chin, ...pivots];
  const a = g(anchor);
  const p = Math.min(...all.map((q) => g(q.y)));
  if (p - a < 2) {
    throw new LayerGeometryError(
      `auto-rig: layer "${body.fileName}": its hips (y ${anchor}) leave no row line strictly between them and the lowest of the head's and shoulders' pivots (y ${p / 100}), so the body warp cannot plant the legs below the pivots`,
    );
  }
  let full = Math.min(g(chin.y - CHEST_DROP * hh), p - pad);
  if (full - a < pad) {
    // A short body: the midpoint of the hips and the lowest pivot, a whole
    // hundredth clear of each.
    full = Math.min(Math.max(Math.round((a + p) / 2), a + 1), p - 1);
  }
  const top = Math.max(g(b.y1), ...all.map((q) => g(q.y))) + pad;
  const bottom = Math.min(a, g(b.y0)) - pad;

  // Lines `from` down to `to` in `cells` even rows, snapped to the grid, the
  // count lowered until the spacing is at least one hundredth: snapped, the
  // lines then still strictly decrease.
  const split = (from: number, to: number, cells: number): number[] => {
    const n = Math.max(1, Math.min(cells, from - to));
    const out = [from];
    for (let i = 1; i < n; i++) {
      out.push(Math.round(from - ((from - to) * i) / n));
    }
    out.push(to);
    return out;
  };
  const bandA = split(top, full, cellsFor((top - full) / 100, 96, 1, 8));
  const ramp = split(full, a, cellsFor((full - a) / 100, 96, 2, 8));
  const rows = [...bandA, ...ramp.slice(1, -1)];
  const ys = [...rows.map((y) => y / 100), anchor, bottom / 100];
  const weights = [...rows.map((y) => smoothstep(a, full, y)), 0, 0];

  const x0 = Math.min(b.x0, ...all.map((q) => q.x)) - BODY_GRID_PAD;
  const x1 = Math.max(b.x1, ...all.map((q) => q.x)) + BODY_GRID_PAD;
  const cols = cellsFor(x1 - x0, 96, 2, 8);
  const xs: number[] = [];
  for (let c = 0; c <= cols; c++) {
    xs.push(roundTo(x0 + ((x1 - x0) * c) / cols, 0.01));
  }
  return { xs, ys, weights, yFull: full / 100 };
}

/**
 * The body part's mesh, in its ±0.5 space, row 0 on top. The engine moves
 * mesh vertices and a triangle interpolates between them, so a triangle
 * across the hips' line would drag the pixels under it along: the mesh's row
 * lines are every lattice row line inside the box (`rows`, top to bottom;
 * the hips' line and `yFull` among them) plus the box's top and bottom, each
 * gap split evenly into rows at most BODY_MESH_PX tall. Every field is linear
 * in x, so the columns are even.
 */
export function bodyMesh(b: Box, rows: number[]): IkiMesh {
  const lines = [b.y1, ...rows.filter((y) => y > b.y0 && y < b.y1), b.y0];
  const ys = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const [from, to] = [lines[i - 1], lines[i]];
    const n = Math.ceil((from - to) / BODY_MESH_PX);
    for (let k = 1; k < n; k++) ys.push(from - ((from - to) * k) / n);
    ys.push(to);
  }
  const cols = cellsFor(bw(b), BODY_MESH_PX, 2, 16);
  const vertices: number[] = [];
  const uvs: number[] = [];
  for (const y of ys) {
    const vy = roundTo((y - cy(b)) / bh(b), 1e-5);
    for (let c = 0; c <= cols; c++) {
      const vx = roundTo(c / cols - 0.5, 1e-5);
      vertices.push(vx, vy);
      uvs.push(roundTo(vx + 0.5, 1e-5), roundTo(0.5 - vy, 1e-5));
    }
  }
  const indices: number[] = [];
  for (let r = 0; r + 1 < ys.length; r++) {
    for (let c = 0; c < cols; c++) {
      const tl = r * (cols + 1) + c;
      const tr = tl + 1;
      const bl = tl + cols + 1;
      const br = bl + 1;
      indices.push(bl, br, tl, tl, br, tr);
    }
  }
  return { vertices, uvs, indices };
}

/**
 * The root body warp and the body part's mesh on its lattice. Its `warps`,
 * in this order, each offset lattice point p = (x, y) by its line's weight w
 * times (at the + extreme; − mirrors the shift and the angle, the narrowing
 * holds):
 * - BodyAngleX ±10: x by bodySlide·hh − bodyNarrow·(x − cx(body));
 * - BodyAngleY ±10: y by bodyBow·hh (+ rises, − bows);
 * - BodyAngleZ ±10: the rotation about H = (cx(body), a) by −bodyRoll;
 * - AngleX ±30 (the follow): BodyAngleX's field at bodyFollowX of it;
 * - AngleZ ±30 (the follow): the rotation about H by −β, β = `followRoll`;
 * - Breath 1: y by breath·hh (the shoulders' breath).
 * BodyAngleZ and AngleZ are clockwise-positive (Live2D's) and a rotation is
 * CCW-positive, hence the minus. Rest keyforms are zero, and offsets are
 * rounded to 0.01 px, which keeps the roll the engine reads back off a cell
 * within 0.02° of its design value.
 */
export function buildBodyWarp({
  body,
  chin,
  hh,
  pivots,
}: {
  body: LayerInput;
  chin: Point;
  hh: number;
  pivots: Point[];
}): { deformer: IkiWarpDeformer; mesh: IkiMesh } {
  const b = boxOfLayer(body);
  const anchor = hipLine(body);
  const { xs, ys, weights } = bodyLattice(body, chin, hh, pivots, anchor);
  const hx = cx(b);
  // The upper body's field at the extreme's share t (−1, 0 or 1).
  const turn = (x: number, t: number) =>
    t * BODY.slide * hh - Math.abs(t) * BODY.narrow * (x - hx);
  const roll = (x: number, y: number, deg: number): [number, number] => {
    const c = Math.cos(deg * DEG) - 1;
    const s = Math.sin(deg * DEG);
    const [dx, dy] = [x - hx, y - anchor];
    return [c * dx - s * dy, s * dx + c * dy];
  };
  const warp = (
    parameter: string,
    values: number[],
    field: (x: number, y: number, t: number) => [number, number],
  ): IkiGridWarp => {
    const extreme = Math.max(...values.map(Math.abs));
    return {
      parameter,
      keyforms: values.map((value) => ({
        value,
        offsets: ys.flatMap((y, r) =>
          xs.flatMap((x) => {
            const [dx, dy] = field(x, y, value / extreme);
            return [
              roundTo(weights[r] * dx, 0.01),
              roundTo(weights[r] * dy, 0.01),
            ];
          }),
        ),
      })),
    };
  };
  const deformer: IkiWarpDeformer = {
    kind: "warp",
    id: BODY_WARP_ID,
    grid: {
      cols: xs.length - 1,
      rows: ys.length - 1,
      points: ys.flatMap((y) => xs.flatMap((x) => [x, y])),
    },
    warps: [
      warp(P.BodyAngleX, BODY_STOPS, (x, _y, t) => [turn(x, t), 0]),
      warp(P.BodyAngleY, BODY_STOPS, (_x, _y, t) => [0, t * BODY.bow * hh]),
      warp(P.BodyAngleZ, BODY_STOPS, (x, y, t) =>
        roll(x, y, -t * BODY.rollDeg),
      ),
      warp(P.AngleX, X_STOPS, (x, _y, t) => [BODY.followX * turn(x, t), 0]),
      warp(P.AngleZ, Z_STOPS, (x, y, t) => roll(x, y, -t * BODY.followRoll)),
      warp(P.Breath, [0, 1], (_x, _y, t) => [0, t * AMPLITUDE.breathBody * hh]),
    ],
  };
  return { deformer, mesh: bodyMesh(b, ys) };
}

/**
 * The head's own roll at AngleZ ±30, degrees. Its world roll there is
 * `ROLL_DEG`. With a body, the head hangs from the body warp, whose follow
 * rolls the chin's cell by exactly β = `BODY.followRoll` at that extreme (the
 * cell is all weight 1, so it moves as a pure rotation), so the head's own
 * roll is ROLL_DEG − β and the two sum to ROLL_DEG. Under BodyAngleZ alone
 * the head's own roll is 0 and its world roll is the body's. Without a body,
 * β = 0.
 */
export function headOwnRoll(hasBody: boolean): number {
  return hasBody ? ROLL_DEG - BODY.followRoll : ROLL_DEG;
}

/**
 * The head's own breath at Breath 1, hh. The chin's net lift is
 * `breathHead`. With a body, the body warp already lifts the chin's cell
 * (all weight 1) by `breathBody`, so the head's own is
 * breathHead − breathBody, a slight drop. The neck island's
 * (breathBody − breathHead), relative to the head, then lands it at
 * breathBody, with the shoulders. Without a body, it is `breathHead`.
 */
export function headOwnBreath(hasBody: boolean): number {
  return hasBody
    ? AMPLITUDE.breathHead - AMPLITUDE.breathBody
    : AMPLITUDE.breathHead;
}
