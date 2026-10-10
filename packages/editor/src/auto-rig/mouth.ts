/**
 * The lip set: a mouth that folds open the way the eyelid folds shut. Three
 * parts, back to front: `mouth_inner` (the interior and the opening's lower
 * outline band), `lip_lower` (the lower lip's skin) and `lip_upper` (the upper
 * lip line and the corner hooks).
 *
 * What the rig reads is the layers' own alpha edges, as exclusive run
 * boundaries in model y (+y up; a run of crop rows `[a, b)` is the span
 * `[rowTop(b), rowTop(a)]`). Per canvas column inside the opening (where
 * `mouth_inner` has a run): the interior's top `T` and bottom `Bb`, the line
 * of `lip_upper` at the interior's top (`Tu` its bottom edge, `lineTop` its
 * top) and the skin's top `Bl`. Each part has one affine warp per column that
 * lands its OWN boundary on its target, so no relation between two parts'
 * boundaries enters the closure; there is no colour read. The art's contract:
 * the interior reaches the line (`T >= Tu`; lower would show the face between
 * them at rest) and the skin reaches the interior (`Bl >= Bb`; an overlap is
 * fine, a gap is not).
 *
 * The line is thinned at every key: its column is squashed toward its bottom
 * edge by `UPPER_THIN` (`Tu` in the opening, the line's own bottom past it),
 * one scale per column so the mesh, linear between its rows, keeps that edge
 * where it was drawn. The thin belongs to the stack above the line's bottom,
 * not to the line alone: the contract lets the interior reach up inside the
 * line's ink (`Tu <= T <= lineTop`), and a line thinned over it would uncover
 * it under its old top, so the interior's rows above `Tu` come down by the
 * same scale. The fold below acts on the thinned positions.
 *
 * MouthOpen 0 folds shut onto a seam, 1 is the art as drawn and thinned (the
 * widening of `mouthWiden` apart). The line comes down until its bottom edge
 * is on the seam, the skin until its top is one overlap `w'` up under the
 * line, and the interior's bottom rides the skin's top, so the band is never
 * covered. The interior's top closes onto the same edge, `S + w'`: the whole
 * column scales by `v` about it, so shut its height is zero (a degenerate
 * triangle draws nothing, at every column and between knots; an inverted
 * sliver would leak through texture filtering where the line is thin), and
 * its top sits `w'(1 - v)` above the line's bottom edge, under the line's ink,
 * so the slit between the line and the skin is always backed. The slit opens
 * once `v * H > w'(1 - v)`; that dead zone is accepted: lip-sync noise near 0
 * does not flicker through it.
 *
 * Shut, the line is shaped the way an artist draws a closed mouth: from
 * `END_TAPER_FROM` of the opening's half-width out, each column is squashed
 * about its thinned centre row, down to `END_TAPER` of its height at the
 * line's box edge, so the ends taper; the drawn flick past a corner is pulled
 * toward it (`FLICK_PULL`) and squashed to `FLICK_SQUASH`. Every closed-key
 * shape is linear in `1 - v`. `w'` therefore follows the shaped line, not the
 * drawn one: it is measured up from the closed line's bottom edge (which the
 * taper raises by half the height it takes off) by the stroke `w` (the line's
 * height at the opening's centre), capped by the column's own ink and thinned
 * and squashed with the line. The skin's top and the interior's closing point
 * then stay inside the line's closed ink at every column, the tapered ends
 * included, and tucked skin never shows above the line.
 *
 * The seam is the line's drawn bottom edge `Tu` plus one smooth closing
 * travel `D`, a cubic in the column index pinned to zero at the opening's two
 * end columns, so the closed line's ends are the drawn line's own ends. It is
 * fitted by least squares to the raw per-column travel `(T - UPPER_SHARE * H)
 * - Tu`, how far the line's bottom is from the share's point in the
 * interior's span. The travel is fitted, not the seam, because `Tu` is an
 * integer-row read: a smooth seam minus that staircase is a sawtooth the mesh
 * would carry into the rendered line, while a smooth travel carries the
 * drawn stroke (whose antialiased edge is smooth) as one piece. The share sets
 * the travel's depth (the sag), the art's two arcs its shape; the cubic keeps
 * an asymmetric mouth's tilt and cannot wobble.
 *
 * The lower lip's columns outside the opening (the corner hooks) do not fold,
 * the line's are only thinned and shaped (no travel), and the interior's edge
 * columns read the nearest opening column.
 *
 * Knots: the three parts share column knots every `MOUTH_KNOT_PX` plus the
 * opening's boundaries `x0`, `x1` and `x1 + 1`, each an integer canvas
 * boundary. The fit's x is the column index, which is the mesh's boundary
 * position: a knot at boundary `b` samples column `b`, so the mesh renders the
 * fit exactly at its knots and the pinned ends render as pinned (`x1` and
 * `x1 + 1` both sample the last column; the second sits at its right edge).
 * The preview resamples each column through the lip meshes' own landed rows
 * (`mouthRestShift`). A part's mesh rounds its local x, so one knot
 * reconstructs to slightly different model x per part; the fold therefore
 * reads the knot itself, by vertex index, and maps every knot through one rule
 * (`columnOfKnot`).
 *
 * The anchor (`mouthAnchor`) is where the head's frame and the turn read the
 * mouth's resting place (the chin lead, the chin estimate, the solve). A
 * single closed mouth is its box centre (its box the union with `mouth_open`);
 * for a lip set it is the seam at the opening's centre column, where the lips
 * meet, with the interior's centre across and the union of the three as box.
 */

import {
  StandardParameter as P,
  type IkiMesh,
  type IkiWarp,
} from "@ikijs/format";
import { localWarp, mouthFrameOf, type MouthFrame } from "./drivers";
import {
  bh,
  boxOfLayer,
  cellsFor,
  columnMesh,
  cx,
  cy,
  unionBoxes,
  type Box,
} from "./layout";
import { LIP_ROLES, type LipRole } from "./roles";
import { LayerGeometryError, type LayerInput } from "./types";

export { LIP_ROLES, type LipRole };

/** The share of the interior's span the upper lip takes when shut; it sets
 *  the closed line's sag. Picked by eye on bob's regenerated keyed mouth
 *  against the legacy closed drawing, 2026-10-09: at 0.4 the closed line's
 *  sag reads like the legacy closed smile (0.3 is shallower, 0.5 deeper). */
export const UPPER_SHARE = 0.4;
/** The share of its height the stack above the line's bottom edge keeps, at
 *  every key. The spike's on bob (`iki-char/gate/lips4`): 0.7; 0.5 broke a
 *  76 px mouth's line into dashes. */
export const UPPER_THIN = 0.7;
/** The closed line's height share, about its centre row, where the taper's
 *  ramp ends: at `lip_upper`'s box edge, reached in the opening only where
 *  no flick runs past the corner (a flick column takes `FLICK_SQUASH`; on
 *  bob's lips-gen2 the opening's end columns get 0.62 and 0.64). The
 *  spike's on bob: 0.35. */
export const END_TAPER = 0.35;
/** Where the closed line's taper starts, as a share of the opening's
 *  half-width from its centre. The spike's on bob: 0.7. */
export const END_TAPER_FROM = 0.7;
/** The share of its length the drawn flick past a corner keeps at the closed
 *  key: the rest it is pulled toward the corner. The spike's on bob: 0.5. */
export const FLICK_PULL = 0.5;
/** The drawn flick's height share at the closed key. The spike's on bob:
 *  0.25. */
export const FLICK_SQUASH = 0.25;
/** Column (and row) pitch of the lip meshes, px. */
export const MOUTH_KNOT_PX = 4;

export const isLipSet = (byRole: Map<string, LayerInput>): boolean =>
  LIP_ROLES.every((r) => byRole.has(r));

/** Per canvas column, its opaque runs as `[top, bottom)` crop rows, top
 *  first: the transpose of `rowRuns`. */
export function columnRuns(layer: LayerInput): Map<number, number[][]> {
  const cols = new Map<number, number[][]>();
  (layer.rowRuns ?? []).forEach((runs, k) => {
    for (let i = 0; i < runs.length; i += 2) {
      for (let c = runs[i]; c < runs[i + 1]; c++) {
        const list = cols.get(c) ?? [];
        const last = list[list.length - 1];
        if (last !== undefined && last[1] === k) last[1] = k + 1;
        else list.push([k, k + 1]);
        cols.set(c, list);
      }
    }
  });
  return cols;
}

/** A run's exclusive edges in model y: its top (larger y) and bottom. */
const edgesOf = (layer: LayerInput, run: number[]) => ({
  top: layer.canvasH / 2 - (layer.bbox.y + run[0]),
  bottom: layer.canvasH / 2 - (layer.bbox.y + run[1]),
});

/** What the fold reads off one canvas column, all model y. */
export interface OpeningColumn {
  /** The interior's top and bottom edges. */
  T: number;
  Bb: number;
  /** The upper line's bottom and top edges, and its height. */
  Tu: number;
  lineTop: number;
  lineH: number;
  /** The skin's top edge. */
  Bl: number;
  /** The interior's span. */
  H: number;
  /** How far the skin tucks up under the line shut: inside the thinned,
   *  squashed line's ink. */
  overlap: number;
  /** Where the lips meet when shut: the line's bottom edge after its smooth
   *  closing travel. */
  seam: number;
}

export interface Opening {
  /** The first and last canvas columns where `mouth_inner` has a run. */
  x0: number;
  x1: number;
  /** The opening's centre column: where the stroke and the anchor are read. */
  centre: number;
  canvasW: number;
  /** The stroke: the line's height at the opening's centre column. */
  w: number;
  /** A column's values; outside `x0..x1`, or in a gap, the nearest one's. */
  at(col: number): OpeningColumn;
  /** The upper line at a column of `lip_upper`, model y: inside the opening
   *  the run the contract reads (`Tu`, `lineTop`) and the closed taper's
   *  squash; past it (the drawn flick) the column's own ink span and
   *  `FLICK_SQUASH`; `undefined` where `lip_upper` has no run. */
  line(
    col: number,
  ): { bottom: number; top: number; squash: number } | undefined;
}

export function mouthOpening(byRole: Map<string, LayerInput>): Opening {
  const inner = byRole.get("mouth_inner")!;
  const upper = byRole.get("lip_upper")!;
  const lower = byRole.get("lip_lower")!;
  const innerCols = columnRuns(inner);
  if (innerCols.size === 0) {
    throw new LayerGeometryError(
      `auto-rig: layer "${inner.fileName}": mouth_inner has no opaque pixel (alpha ≥ 128) to read the opening off`,
    );
  }
  const upperCols = columnRuns(upper);
  const lowerCols = columnRuns(lower);
  const cols = [...innerCols.keys()];
  const x0 = Math.min(...cols);
  const x1 = Math.max(...cols);

  const read = (
    col: number,
  ): Omit<OpeningColumn, "overlap" | "seam"> | undefined => {
    const runs = innerCols.get(col);
    if (runs === undefined) return undefined;
    // Several runs in one column (a tooth, a tongue gap) are one interior:
    // the fold spans the first run's top to the last run's bottom.
    const T = edgesOf(inner, runs[0]).top;
    const Bb = edgesOf(inner, runs[runs.length - 1]).bottom;
    // The lowest run of the upper lip whose top edge is at or above the
    // interior's top: on contract art the one containing it.
    const line = [...(upperCols.get(col) ?? [])]
      .reverse()
      .map((r) => edgesOf(upper, r))
      .find((e) => e.top >= T);
    const Tu = line?.bottom ?? T;
    const lineTop = line?.top ?? T;
    const skin = lowerCols.get(col)?.[0];
    return {
      T,
      Bb,
      Tu,
      lineTop,
      lineH: lineTop - Tu,
      Bl: skin === undefined ? Bb : edgesOf(lower, skin).top,
      H: T - Bb,
    };
  };

  // Every column of the opening, a gap reading the nearest column with a run.
  const reads: Omit<OpeningColumn, "overlap" | "seam">[] = [];
  for (let c = x0; c <= x1; c++) {
    // The left neighbour wins a tie.
    let r: Omit<OpeningColumn, "overlap" | "seam"> | undefined;
    for (let d = 0; (r = read(c - d) ?? read(c + d)) === undefined; d++);
    reads.push(r);
  }

  // The travel's fit: D(x) = (x - x0)(x - x1)(p + q (x - m)), p and q from the
  // 2x2 normal equations over the opening's columns. Under 4 columns the
  // system is singular (at 3 only the middle column has a nonzero basis, and
  // (x - m) is 0 there), so the travel is zero and the closed line is the
  // drawn line.
  const m = (x0 + x1) / 2;
  let p = 0;
  let q = 0;
  if (reads.length >= 4) {
    let s11 = 0;
    let s12 = 0;
    let s22 = 0;
    let t1 = 0;
    let t2 = 0;
    reads.forEach((r, i) => {
      const x = x0 + i;
      const b1 = (x - x0) * (x - x1);
      const b2 = b1 * (x - m);
      const d = r.T - UPPER_SHARE * r.H - r.Tu;
      s11 += b1 * b1;
      s12 += b1 * b2;
      s22 += b2 * b2;
      t1 += b1 * d;
      t2 += b2 * d;
    });
    const det = s11 * s22 - s12 * s12;
    p = (t1 * s22 - t2 * s12) / det;
    q = (s11 * t2 - s12 * t1) / det;
  }
  const columns: Omit<OpeningColumn, "overlap">[] = reads.map((r, i) => {
    const x = x0 + i;
    return { ...r, seam: r.Tu + (x - x0) * (x - x1) * (p + q * (x - m)) };
  });
  const clamp = (col: number) => Math.min(x1, Math.max(x0, col));
  const base = (col: number) => columns[clamp(col) - x0];
  const centre = Math.round((x0 + x1) / 2);
  const w = base(centre).lineH;
  // The closed taper: 1 out to its start, then linear in the distance from
  // the centre down to END_TAPER at lip_upper's box-edge column on that side.
  const from = END_TAPER_FROM * ((x1 - x0 + 1) / 2);
  const squash = (col: number) => {
    const d = Math.abs(col - centre);
    const edge =
      col < centre
        ? centre - upper.bbox.x
        : upper.bbox.x + upper.bbox.w - 1 - centre;
    const t = d <= from ? 0 : d >= edge ? 1 : (d - from) / (edge - from);
    return 1 - (1 - END_TAPER) * t;
  };
  return {
    x0,
    x1,
    centre,
    canvasW: inner.canvasW,
    w,
    at(col) {
      const b = base(col);
      const s = squash(clamp(col));
      // Up from the closed line's bottom, which the taper raises by half the
      // height it takes off: the capped stroke, thinned and squashed with
      // the line, so the skin's top stays inside the closed ink.
      return {
        ...b,
        overlap:
          UPPER_THIN * ((b.lineH * (1 - s)) / 2 + Math.min(w, b.lineH) * s),
      };
    },
    line(col) {
      if (col >= x0 && col <= x1) {
        const b = base(col);
        return { bottom: b.Tu, top: b.lineTop, squash: squash(col) };
      }
      const runs = upperCols.get(col);
      if (runs === undefined) return undefined;
      return {
        bottom: edgesOf(upper, runs[runs.length - 1]).bottom,
        top: edgesOf(upper, runs[0]).top,
        squash: FLICK_SQUASH,
      };
    },
  };
}

/**
 * `[dx, dy]` of a model-y rest position at pixel column `col` for MouthOpen
 * `v` (0 shut, 1 as drawn), the thin first at every `v` and the fold on the
 * thinned position. `lip_upper`'s column is squashed toward its line's bottom;
 * shut, squashed by its `squash` about the thinned centre row and carried by
 * the travel, or past the opening (the drawn flick, which now moves too)
 * squashed and pulled toward the corner. `lip_lower` moves by its travel in
 * the opening and 0 outside it. `mouth_inner`, its rows above `Tu` thinned,
 * scales its column by `v` about `S + w'`, which carries its top and bottom
 * edges along the line and the skin and needs no read of its own height.
 */
export function mouthFold(
  role: LipRole,
  opening: Opening,
): (col: number, y: number, v: number) => [number, number] {
  const { x0, x1 } = opening;
  return (col, y, v) => {
    const k = 1 - v;
    const inside = col >= x0 && col <= x1;
    switch (role) {
      case "lip_lower": {
        if (!inside) return [0, 0];
        const c = opening.at(col);
        return [0, (c.seam + c.overlap - c.Bl) * k];
      }
      case "mouth_inner": {
        const c = opening.at(col);
        const thin = y > c.Tu ? c.Tu + UPPER_THIN * (y - c.Tu) : y;
        const S = c.seam + c.overlap;
        return [0, S + v * (thin - S) - y];
      }
      case "lip_upper": {
        // A column with no ink (the box's margin past the line's end) takes
        // the nearest inked one toward the opening, so the cells it shares
        // with the ink move with it.
        let c = col;
        let line = opening.line(c);
        while (line === undefined)
          line = opening.line((c += col < x0 ? 1 : -1));
        const thin = line.bottom + UPPER_THIN * (y - line.bottom);
        const mid = line.bottom + (UPPER_THIN * (line.top - line.bottom)) / 2;
        const travel = inside ? opening.at(col).seam - line.bottom : 0;
        const shut = mid + line.squash * (thin - mid) + travel;
        // A knot at canvas boundary `b` samples column `b`, so `col` is its x.
        const pull = inside
          ? 0
          : (1 - FLICK_PULL) * ((col < x0 ? x0 : x1 + 1) - col);
        return [pull * k, thin - y + (shut - thin) * k];
      }
    }
  };
}

/** The pixel column a knot (model x) samples: a knot at canvas boundary `c`
 *  samples column `c`, except the boundary after the opening's last column,
 *  which samples the last. */
export function columnOfKnot(knot: number, opening: Opening): number {
  const boundary = Math.round(knot + opening.canvasW / 2);
  return boundary === opening.x1 + 1 ? opening.x1 : boundary;
}

/** The MouthOpen fold as a warp on a part's mesh. `xs` are the model-x knots
 *  the mesh was cut on (`mouthMesh`); a vertex's knot is read by its index,
 *  never from its rounded position. */
export function mouthFoldWarp(
  role: LipRole,
  mesh: IkiMesh,
  xs: number[],
  box: Box,
  opening: Opening,
): IkiWarp {
  const fold = mouthFold(role, opening);
  return localWarp(P.MouthOpen, mesh, box, [0, 1], (p, v, i) =>
    fold(columnOfKnot(xs[i % xs.length], opening), p[1], v),
  );
}

/** A lip's dy at MouthOpen 0 at a canvas pixel `(col, row)` as the mesh
 *  renders it, for the composer's closed preview: read at the pixel's centre
 *  off the STORED offsets (the numbers the `.iki` carries, rounded as
 *  `localWarp` rounds them) of the `columnMesh` triangle containing it — the
 *  cell by knot and row, its triangle by the cell's top-left–bottom-right
 *  diagonal, the three vertices weighted barycentrically. The thin and the
 *  taper move a column's rows by different amounts and the renderer is
 *  linear over a triangle, never bilinear over a cell, so no one row stands
 *  for the column. `undefined` for a pixel centre outside the part's box (the
 *  mesh's domain), which has no field. `byRole` must be the layers as the rig
 *  measures them (the canvas-sized ones): a box measured on a smaller frame
 *  clamps differently, and the knot grid starts at the union's edge. */
export function mouthRestShift(
  byRole: Map<string, LayerInput>,
): (
  role: "lip_upper" | "lip_lower",
  col: number,
  row: number,
) => number | undefined {
  const rig = buildMouthRig(byRole);
  const fields = new Map<
    string,
    { box: Box; xs: number[]; rows: number; dy: number[] }
  >();
  for (const role of ["lip_upper", "lip_lower"] as const) {
    const box = boxOfLayer(byRole.get(role)!);
    const { mesh, xs } = mouthMesh(box, rig.knots);
    const warp = mouthFoldWarp(role, mesh, xs, box, rig.opening);
    const offsets = warp.keyforms[0].offsets;
    fields.set(role, {
      box,
      xs,
      rows: offsets.length / 2 / xs.length - 1,
      dy: offsets.filter((_, i) => i % 2 === 1).map((o) => o * bh(box)),
    });
  }
  const { canvasW, canvasH } = byRole.get("lip_upper")!;
  return (role, col, row) => {
    const { box, xs, rows, dy } = fields.get(role)!;
    const x = col + 0.5 - canvasW / 2;
    const y = canvasH / 2 - (row + 0.5);
    if (x < box.x0 || x > box.x1 || y < box.y0 || y > box.y1) return undefined;
    let k = 1;
    while (k < xs.length - 1 && xs[k] < x) k++;
    // The cell's fractions: fx along the knots, fy down the rows (row 0 is
    // the box's top, as `mouthMesh` lays them).
    const down = ((box.y1 - y) / bh(box)) * rows;
    const r = Math.min(rows - 1, Math.floor(down));
    const fx = (x - xs[k - 1]) / (xs[k] - xs[k - 1]);
    const fy = down - r;
    const at = (i: number, j: number) => dy[i * xs.length + j];
    const tl = at(r, k - 1);
    const br = at(r + 1, k);
    // The diagonal runs TL→BR, so the lower-left triangle [BL, BR, TL] is
    // the one with fx <= fy.
    if (fx <= fy) {
      const bl = at(r + 1, k - 1);
      return tl + fy * (bl - tl) + fx * (br - bl);
    }
    const tr = at(r, k);
    return tl + fx * (tr - tl) + fy * (br - tr);
  };
}

/** The knots (model x) shared by the three parts over their union: its edges,
 *  every `MOUTH_KNOT_PX` between, and the opening's first column, its last
 *  column and the boundary after it. */
export function mouthKnots(union: Box, opening: Opening): number[] {
  const half = opening.canvasW / 2;
  const step = MOUTH_KNOT_PX;
  const xs = [union.x0];
  while (xs[xs.length - 1] + step < union.x1 - 0.3 * step)
    xs.push(xs[xs.length - 1] + step);
  xs.push(union.x1);
  const fixed = new Set([union.x0, union.x1]);
  for (const x of [
    opening.x0 - half,
    opening.x1 - half,
    opening.x1 + 1 - half,
  ]) {
    // Fixed before the lookup: a boundary already on a grid knot must not be
    // replaced by the next one either.
    fixed.add(x);
    if (xs.includes(x)) continue;
    const near = xs.findIndex((v) => Math.abs(v - x) < 0.3 * step);
    // Unlike `hairFrontGrid`, which skips a bend within reach of an edge, the
    // opening's boundaries must be knots, at the cost of a ~1 px cell; an
    // edge or an earlier boundary is never replaced. `x1` is one so that the
    // last column's own index, where the travel is pinned, is a knot: the
    // boundary after it samples the same column but sits at its right edge.
    if (near >= 0 && !fixed.has(xs[near])) xs[near] = x;
    else xs.push(x);
  }
  xs.sort((p, q) => p - q);
  for (const x of xs) {
    if (!Number.isInteger(x + half)) {
      throw new Error(
        `auto-rig: mouth knot ${x} is not an integer canvas boundary`,
      );
    }
  }
  return xs;
}

/** A part's mesh over `box` on the knots inside it plus its edges, rows every
 *  `MOUTH_KNOT_PX`; `xs` is the knot list the fold indexes. */
export function mouthMesh(
  box: Box,
  knots: number[],
): { mesh: IkiMesh; xs: number[] } {
  const xs = [box.x0, ...knots.filter((k) => k > box.x0 && k < box.x1), box.x1];
  const rows = cellsFor(bh(box), MOUTH_KNOT_PX, 2, 40);
  const ys = Array.from(
    { length: rows + 1 },
    (_, r) => box.y1 - (bh(box) * r) / rows,
  );
  return { mesh: columnMesh(box, { xs, ys }), xs };
}

export interface MouthRig {
  opening: Opening;
  /** The Form and widen frame of the union, shared by the three parts. */
  frame: MouthFrame;
  knots: number[];
  union: Box;
}

export function buildMouthRig(byRole: Map<string, LayerInput>): MouthRig {
  const opening = mouthOpening(byRole);
  const union = unionBoxes(LIP_ROLES.map((r) => boxOfLayer(byRole.get(r)!)));
  return {
    opening,
    frame: mouthFrameOf(union),
    knots: mouthKnots(union, opening),
    union,
  };
}

/** Where the mouth is, for the head's frame and the turn: a lip set's
 *  interior centre across, the seam at the opening's centre down, and the
 *  union of its parts; a single closed mouth's centre and its box (with the
 *  open drawing's, when there is one). */
export function mouthAnchor(byRole: Map<string, LayerInput>): {
  at: { x: number; y: number };
  box: Box;
} {
  const box = (role: string) => boxOfLayer(byRole.get(role)!);
  if (isLipSet(byRole)) {
    const opening = mouthOpening(byRole);
    return {
      at: {
        x: cx(box("mouth_inner")),
        y: opening.at(opening.centre).seam,
      },
      box: unionBoxes(LIP_ROLES.map(box)),
    };
  }
  const m = box("mouth");
  return {
    at: { x: cx(m), y: cy(m) },
    box: byRole.has("mouth_open") ? unionBoxes([m, box("mouth_open")]) : m,
  };
}
