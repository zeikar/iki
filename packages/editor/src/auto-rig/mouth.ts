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
 * MouthOpen 0 folds shut onto a seam, 1 is the art as drawn (the widening of
 * `mouthWiden` apart). The line comes down until its bottom edge is on the
 * seam, the skin until its top is one overlap `w'` up under the line (`w'` is
 * the stroke `w`, the line's height at the opening's centre, capped by the
 * line's own ink at that column so tucked skin never shows above it), and the
 * interior's bottom rides the skin's top, so the band is never covered. The
 * interior's top closes onto the same edge, `S + w'`: the whole column scales
 * by `v` about it, so shut its height is zero (a degenerate triangle draws
 * nothing, at every column and between knots; an inverted sliver would leak
 * through texture filtering where the line is thin), and its top sits
 * `w'(1 - v)` above the line's bottom edge, under the line's ink, so the slit
 * between the line and the skin is always backed. The slit opens once
 * `v * H > w'(1 - v)`; that dead zone is accepted: lip-sync noise near 0 does
 * not flicker through it.
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
 * A lip's columns outside the opening (the corner hooks) do not fold; only
 * the interior's edge columns read the nearest opening column.
 *
 * Knots: the three parts share column knots every `MOUTH_KNOT_PX` plus the
 * opening's boundaries `x0`, `x1` and `x1 + 1`, each an integer canvas
 * boundary. The fit's x is the column index, which is the mesh's boundary
 * position: a knot at boundary `b` samples column `b`, so the mesh renders the
 * fit exactly at its knots and the pinned ends render as pinned (`x1` and
 * `x1 + 1` both sample the last column; the second sits at its right edge).
 * The preview shifts each column by the field at the column's centre
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
  /** How far the skin tucks up under the line. */
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
  const base = (col: number) => columns[Math.min(x1, Math.max(x0, col)) - x0];
  const centre = Math.round((x0 + x1) / 2);
  const w = base(centre).lineH;
  return {
    x0,
    x1,
    centre,
    canvasW: inner.canvasW,
    w,
    at(col) {
      const b = base(col);
      return { ...b, overlap: Math.max(0, Math.min(w, b.lineH)) };
    },
  };
}

/**
 * dy of a model-y rest position at pixel column `col` for MouthOpen `v`
 * (0 shut, 1 as drawn). A lip outside the opening moves 0; `mouth_inner`
 * scales its column by `v` about `S + w'`, which carries its top and bottom
 * edges along the line and the skin and needs no read of its own height.
 */
export function mouthFold(
  role: LipRole,
  opening: Opening,
): (col: number, y: number, v: number) => number {
  return (col, y, v) => {
    if (v === 1) return 0;
    if (role !== "mouth_inner" && (col < opening.x0 || col > opening.x1))
      return 0;
    const c = opening.at(col);
    const k = 1 - v;
    switch (role) {
      case "lip_upper":
        return (c.seam - c.Tu) * k;
      case "lip_lower":
        return (c.seam + c.overlap - c.Bl) * k;
      case "mouth_inner":
        return (c.seam + c.overlap - y) * k;
    }
  };
}

/** The pixel column a knot (model x) samples, or `undefined` for a lip's knot
 *  outside the opening; `mouth_inner` clamps to it instead. A knot at canvas
 *  boundary `c` samples column `c`, except the boundary after the last column,
 *  which samples the last. */
export function columnOfKnot(
  knot: number,
  opening: Opening,
  role: LipRole,
): number | undefined {
  const boundary = Math.round(knot + opening.canvasW / 2);
  const col = boundary === opening.x1 + 1 ? opening.x1 : boundary;
  if (col >= opening.x0 && col <= opening.x1) return col;
  return role === "mouth_inner"
    ? Math.min(opening.x1, Math.max(opening.x0, col))
    : undefined;
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
  return localWarp(P.MouthOpen, mesh, box, [0, 1], (p, v, i) => {
    const col = columnOfKnot(xs[i % xs.length], opening, role);
    return [0, col === undefined ? 0 : fold(col, p[1], v)];
  });
}

/** A lip's translate at MouthOpen 0 per canvas column as the mesh renders it,
 *  for the composer's closed preview: the linear interpolation at the column's
 *  centre between the STORED offsets of the part's two bracketing knots (the
 *  numbers the `.iki` carries, rounded as `localWarp` rounds them), 0 outside
 *  the part's box. `byRole` must be the layers as the rig measures them (the
 *  canvas-sized ones): a box measured on a smaller frame clamps differently,
 *  and the knot grid starts at the union's edge. */
export function mouthRestShift(
  byRole: Map<string, LayerInput>,
): (role: "lip_upper" | "lip_lower", col: number) => number {
  const rig = buildMouthRig(byRole);
  const fields = new Map<string, { box: Box; xs: number[]; dy: number[] }>();
  for (const role of ["lip_upper", "lip_lower"] as const) {
    const box = boxOfLayer(byRole.get(role)!);
    const { mesh, xs } = mouthMesh(box, rig.knots);
    const warp = mouthFoldWarp(role, mesh, xs, box, rig.opening);
    const offsets = warp.keyforms[0].offsets;
    fields.set(role, {
      box,
      xs,
      dy: xs.map((_, i) => offsets[2 * i + 1] * bh(box)),
    });
  }
  const half = rig.opening.canvasW / 2;
  return (role, col) => {
    const { box, xs, dy } = fields.get(role)!;
    const x = col + 0.5 - half;
    if (x < box.x0 || x > box.x1) return 0;
    let k = 1;
    while (k < xs.length - 1 && xs[k] < x) k++;
    const t = (x - xs[k - 1]) / (xs[k] - xs[k - 1]);
    return dy[k - 1] + (dy[k] - dy[k - 1]) * t;
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
