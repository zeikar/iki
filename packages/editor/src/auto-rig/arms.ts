/**
 * The arms. Each `arm_L` / `arm_R` layer is one drawing of the whole arm,
 * hanging, its shoulder at the top. It becomes two parts on two nested matrix
 * deformers hung from the body warp:
 * - the upper arm (the role's own id) on `armDeformer_X`, which turns about
 *   the shoulder, the deltoid cap's centre;
 * - the forearm (`forearm_X`) on `forearmDeformer_X`, a child of the arm's,
 *   which turns about the elbow.
 * The shoulder pivot rides an all-weight-1 cell of the body warp (`body.ts`),
 * so the arm breathes and turns with the chest rigidly, never sheared.
 *
 * Both parts are cut from the one crop: they share its box, transform and
 * texture rect, and their meshes meet on the seam, the elbow pivot's row. The
 * upper arm is the band above the seam. The forearm is the band below it plus
 * a half-disc fan above it, centred on the elbow pivot. Iki has no glue
 * between meshes, and two bands hinged at a seam open a wedge as wide as the
 * arm on a bend; the half-disc turns about its own centre, so it rotates into
 * itself and keeps the joint covered at any bend.
 *
 * Draw order: hair_back < body < arm_L, forearm_L, arm_R, forearm_R < face …
 * < hair_front. The forearm draws over the upper arm, so its cap hides the
 * seam.
 *
 * Signs: ParamArmX + raises the arm outward on either side and ParamElbowX +
 * turns the forearm the same way, both in degrees 1:1. A rotation is
 * CCW-positive, so an arm whose shoulder lies right of the body's axis (+x,
 * the character's left) turns CCW for +, and one at −x turns CW.
 */

import {
  StandardParameter as P,
  type IkiDeformerBinding,
  type IkiMatrixDeformer,
  type IkiMesh,
  type IkiPart,
} from "@ikijs/format";
import { BODY_WARP_ID } from "./body";
import { bh, boxOfLayer, bw, cx, cy, roundTo } from "./layout";
import { LayerGeometryError, type LayerInput } from "./types";

type Point = { x: number; y: number };

export type ArmRole = "arm_L" | "arm_R";

/** The elbow lies this share of the way from the shoulder's row down to the
 *  arm's last painted row (an arm drawn with its hand). Our own value. */
export const ELBOW_AT = 0.42;
/** The rows the upper arm's width is read on, as fractions of the crop's
 *  height, top to bottom: under the deltoid cap, above the elbow. Our own
 *  values. */
const CAP_ROWS = [0.1, 0.3] as const;
/** The elbow cap's fan segments over its half-turn. Our own value. */
export const CAP_SEGMENTS = 12;
/** ParamArmX and ParamElbowX, degrees: from a little across the body to
 *  150° out, 30° short of straight up. Our own values. */
export const ARM_RANGE = [-30, 150] as const;
/** Each arm's shoulder and elbow parameters. */
export const ARM_PARAMS: Record<ArmRole, { arm: string; elbow: string }> = {
  arm_L: { arm: P.ArmLeft, elbow: P.ElbowLeft },
  arm_R: { arm: P.ArmRight, elbow: P.ElbowRight },
};
/** Each arm's forearm part id (the upper arm keeps the role's) and its two
 *  deformer ids. */
export const ARM_IDS: Record<
  ArmRole,
  { forearm: string; armDeformer: string; forearmDeformer: string }
> = {
  arm_L: {
    forearm: "forearm_L",
    armDeformer: "armDeformer_L",
    forearmDeformer: "forearmDeformer_L",
  },
  arm_R: {
    forearm: "forearm_R",
    armDeformer: "armDeformer_R",
    forearmDeformer: "forearmDeformer_R",
  },
};

export interface ArmGeometry {
  /** The shoulder pivot, model space: the deltoid cap's centre. */
  shoulder: Point;
  /** r_u: the upper arm's half-width under the cap, px. */
  shoulderRadius: number;
  /** The elbow pivot, model space. Its y is the seam the two meshes meet on. */
  elbow: Point;
  /** The forearm's half-disc radius, px. */
  capRadius: number;
  /** +1 for a shoulder right of the body's axis (+ turns CCW), −1 left of it
   *  (+ turns CW). */
  side: 1 | -1;
}

/**
 * The arm's pivots, read off the widest opaque run of each crop row
 * (`rowRuns`); a row without one, or a layer without runs, reads as the
 * crop:
 * - r_u is half the median width over the `CAP_ROWS` rows;
 * - the shoulder pivot lies r_u under the first painted row's centre, at the
 *   run centre of the row it lands in;
 * - the elbow is the centre of the row `ELBOW_AT` of the way from there to
 *   the last painted row, at its run centre;
 * - the cap radius is half the elbow's run + 1 px, kept inside the crop.
 * Pivots are on the 0.01 grid, as the written model is. `bodyAxisX` is the
 * body's axis, model x: the shoulder's side of it sets the sign. An arm too
 * short for its width to put the elbow under the shoulder would rig
 * inverted, so it throws `LayerGeometryError`.
 */
export function armGeometry(layer: LayerInput, bodyAxisX: number): ArmGeometry {
  const { bbox, canvasW, canvasH, rowRuns } = layer;
  const b = boxOfLayer(layer);
  // Crop row k's widest run, canvas columns [start, end).
  const span = (k: number): [number, number] => {
    const runs = rowRuns?.[k] ?? [];
    if (runs.length === 0) return [bbox.x, bbox.x + bbox.w];
    let [s, e] = [runs[0], runs[1]];
    for (let i = 2; i < runs.length; i += 2) {
      if (runs[i + 1] - runs[i] > e - s) [s, e] = [runs[i], runs[i + 1]];
    }
    return [s, e];
  };
  const centreX = (k: number) => {
    const [s, e] = span(k);
    return (s + e) / 2 - canvasW / 2;
  };
  // Model y of crop row k's centre; k may be fractional.
  const rowY = (k: number) => canvasH / 2 - (bbox.y + k + 0.5);

  const painted =
    rowRuns?.flatMap((runs, k) => (runs.length > 0 ? [k] : [])) ?? [];
  const first = painted[0] ?? 0;
  const last = painted.at(-1) ?? bbox.h - 1;

  const lo = Math.ceil(CAP_ROWS[0] * bbox.h);
  // At least one row, on a crop too short for the band to hold one.
  const hi = Math.max(lo, Math.floor(CAP_ROWS[1] * bbox.h));
  const widths: number[] = [];
  for (let k = lo; k <= hi; k++) {
    const [s, e] = span(k);
    widths.push(e - s);
  }
  widths.sort((p, q) => p - q);
  const ru = widths[widths.length >> 1] / 2;

  // The shoulder's row, fractional: r_u under the first painted row.
  const ks = first + ru;
  const shoulder = {
    x: roundTo(centreX(Math.round(ks)), 0.01),
    y: roundTo(rowY(ks), 0.01),
  };
  const ke = Math.round(ks + ELBOW_AT * (last - ks));
  if (ke <= ks) {
    throw new LayerGeometryError(
      `auto-rig: layer "${layer.fileName}": the arm is too short for its width to place a shoulder above an elbow (draw the arm hanging, shoulder at the top)`,
    );
  }
  const elbow = { x: roundTo(centreX(ke), 0.01), y: roundTo(rowY(ke), 0.01) };
  const [s, e] = span(ke);
  const capRadius = Math.min(
    (e - s) / 2 + 1,
    elbow.x - b.x0,
    b.x1 - elbow.x,
    b.y1 - elbow.y,
  );
  return {
    shoulder,
    shoulderRadius: ru,
    elbow,
    capRadius,
    side: shoulder.x > bodyAxisX ? 1 : -1,
  };
}

/** A mesh from part-local ±0.5 vertices (a band's four corners, then any
 *  fan's centre and arc), its UVs following them (u = x + 0.5,
 *  v = 0.5 − y). */
function meshOf(vertices: number[], indices: number[]): IkiMesh {
  const uvs = vertices.map((v, i) =>
    roundTo(i % 2 === 0 ? v + 0.5 : 0.5 - v, 1e-5),
  );
  return { vertices, uvs, indices };
}

/**
 * The arm's two parts over its crop's box: the upper arm, the band from the
 * crop's top to the seam, on `armDeformer_X` at `order`; the forearm, the
 * band from the seam to the crop's bottom plus the elbow cap, on
 * `forearmDeformer_X` at `order + 1`. The cap is a fan of `CAP_SEGMENTS`
 * triangles from the elbow pivot over the half-disc above the seam. Their
 * texture rect is the host's, as every part's is: both take the crop's
 * (`partIdsOfRole`).
 */
export function armParts(
  role: ArmRole,
  layer: LayerInput,
  g: ArmGeometry,
  order: number,
): [IkiPart, IkiPart] {
  const b = boxOfLayer(layer);
  const lx = (x: number) => roundTo((x - cx(b)) / bw(b), 1e-5);
  const ly = (y: number) => roundTo((y - cy(b)) / bh(b), 1e-5);
  const seam = ly(g.elbow.y);
  // A full-width band from `top` down to `bottom`, split as `gridMesh`
  // splits a cell.
  const band = (top: number, bottom: number) => [
    -0.5,
    top,
    0.5,
    top,
    -0.5,
    bottom,
    0.5,
    bottom,
  ];
  const quad = [2, 3, 0, 0, 3, 1];

  const cap = [lx(g.elbow.x), seam];
  const fan: number[] = [];
  for (let i = 0; i <= CAP_SEGMENTS; i++) {
    const a = (Math.PI * i) / CAP_SEGMENTS;
    cap.push(
      lx(g.elbow.x + g.capRadius * Math.cos(a)),
      ly(g.elbow.y + g.capRadius * Math.sin(a)),
    );
    // The centre is vertex 4, after the band's four.
    if (i > 0) fan.push(4, 4 + i, 5 + i);
  }

  const part = (
    id: string,
    deformer: string,
    at: number,
    mesh: IkiMesh,
  ): IkiPart => ({
    id,
    color: [1, 1, 1, 1],
    width: bw(b),
    height: bh(b),
    transform: { x: cx(b), y: cy(b) },
    order: at,
    deformer,
    mesh,
  });
  const ids = ARM_IDS[role];
  return [
    part(role, ids.armDeformer, order, meshOf(band(0.5, seam), quad)),
    part(
      ids.forearm,
      ids.forearmDeformer,
      order + 1,
      meshOf([...band(seam, -0.5), ...cap], [...quad, ...fan]),
    ),
  ];
}

/**
 * The arm's two matrix deformers: `armDeformer_X`, hung from the body warp
 * at the shoulder, and `forearmDeformer_X`, hung from it at the elbow. Each
 * turns on its parameter, declared over `ARM_RANGE`, by side × the value in
 * degrees.
 */
export function armDeformers(
  role: ArmRole,
  g: ArmGeometry,
): [IkiMatrixDeformer, IkiMatrixDeformer] {
  const ids = ARM_IDS[role];
  const params = ARM_PARAMS[role];
  // A binding maps the parameter's range onto [from, to]: these give
  // side · value, so 0 rests.
  const rotate = (parameter: string): IkiDeformerBinding => ({
    parameter,
    channel: "rotate",
    from: g.side * ARM_RANGE[0],
    to: g.side * ARM_RANGE[1],
  });
  return [
    {
      id: ids.armDeformer,
      parent: BODY_WARP_ID,
      pivot: { ...g.shoulder },
      bindings: [rotate(params.arm)],
    },
    {
      id: ids.forearmDeformer,
      parent: ids.armDeformer,
      pivot: { ...g.elbow },
      bindings: [rotate(params.elbow)],
    },
  ];
}
