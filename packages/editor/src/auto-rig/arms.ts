/**
 * The arms. Each `arm_L` / `arm_R` layer is one drawing of the whole arm,
 * hanging, its shoulder at the top. It becomes three parts on two nested
 * matrix deformers hung from the body warp:
 * - the upper arm (the role's own id) on `armDeformer_X`, which turns about
 *   the shoulder, the deltoid cap's centre;
 * - the forearm (`forearm_X`) on `forearmDeformer_X`, a child of the arm's,
 *   which turns about the elbow;
 * - the elbow cap (`elbow_X`), also on `forearmDeformer_X`, drawn behind the
 *   upper arm.
 * The shoulder pivot rides an all-weight-1 cell of the body warp (`body.ts`),
 * so the arm breathes and turns with the chest rigidly, never sheared.
 *
 * All three parts are cut from the one crop: they share its box, transform
 * and texture rect. The upper arm is the band above the seam, the elbow
 * pivot's row; the forearm is the band below it. Iki has no glue between
 * meshes, and two bands hinged at a seam open a wedge as wide as the arm on a
 * bend. The cap fills it: a half-disc fan centred on the elbow pivot turns
 * about its own centre, so it rotates into itself and keeps the joint covered
 * at any bend.
 *
 * Behind the upper arm, the cap shows only where the forearm's bend uncovers
 * it, so it must lie inside the paint at rest, or its edge would show past
 * the arm's. Its boundary is therefore the arm's own contour, not a circle:
 * `armGeometry` walks each of the fan's 13 rays out from the elbow to the
 * contour (`capRays`). A ring at the boundary, `CAP_RIM` wide, takes the UVs
 * of the seam row's edge cross-section swept round the arc, so the exposed
 * wedge carries the painted line, fading out in the antialias column as the
 * painted edge does; the fan inside it is the crop's own pixels.
 *
 * Draw order: hair_back < body < elbow_L, arm_L, forearm_L, elbow_R, arm_R,
 * forearm_R < face … < hair_front. The forearm draws over the upper arm,
 * which draws over the cap.
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
/** The elbow cap's fan segments over its half-turn: even, so a ray runs
 *  straight up (the top ray's index is half of `CAP_SEGMENTS`). Our own
 *  value. */
export const CAP_SEGMENTS = 12;
/** How far inside the arm's contour the cap's edge keeps, px: the contour's
 *  antialias column, a texel of the engine's LINEAR filtering, and one spare.
 *  Our own value. */
export const CAP_INSET = 3;
/** The cap's rim ring's width, as a share of the cap radius: the painted line
 *  and a little skin inside it. Our own value. */
export const CAP_RIM = 0.25;
/** ParamArmX and ParamElbowX, degrees: from a little across the body to
 *  150° out, 30° short of straight up. Our own values. */
export const ARM_RANGE = [-30, 150] as const;
/** Each arm's shoulder and elbow parameters. */
export const ARM_PARAMS: Record<ArmRole, { arm: string; elbow: string }> = {
  arm_L: { arm: P.ArmLeft, elbow: P.ElbowLeft },
  arm_R: { arm: P.ArmRight, elbow: P.ElbowRight },
};
/** Each arm's forearm and elbow cap part ids (the upper arm keeps the role's)
 *  and its two deformer ids. */
export const ARM_IDS: Record<
  ArmRole,
  { forearm: string; cap: string; armDeformer: string; forearmDeformer: string }
> = {
  arm_L: {
    forearm: "forearm_L",
    cap: "elbow_L",
    armDeformer: "armDeformer_L",
    forearmDeformer: "forearmDeformer_L",
  },
  arm_R: {
    forearm: "forearm_R",
    cap: "elbow_R",
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
  /** The elbow cap's largest radius, px. */
  capRadius: number;
  /** The cap's radius on each of its `CAP_SEGMENTS + 1` rays, from the elbow
   *  at angles 0..π, px: the walk out to the contour, less `CAP_INSET`, at
   *  most `capRadius`. */
  capRays: number[];
  /** The seam row's widest run, crop columns [start, end). */
  seamRun: [number, number];
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
 * - the cap radius is half the elbow's run + 1 px, kept inside the crop;
 * - each cap ray walks 1 px at a time from the elbow until it leaves the
 *   widest run of the crop row it is in (strictly inside: `start < x < end`,
 *   on canvas columns, the row the floor of the canvas y), then stops
 *   `CAP_INSET` short of that exit, and at `capRadius`.
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
  const inside = (x: number, y: number) => {
    const k = Math.floor(y) - bbox.y;
    if (k < 0 || k >= bbox.h) return false;
    const [rs, re] = span(k);
    return rs < x && x < re;
  };
  const capRays = Array.from({ length: CAP_SEGMENTS + 1 }, (_, i) => {
    const a = (Math.PI * i) / CAP_SEGMENTS;
    let t = 1;
    // Past capRadius + CAP_INSET the radius is capped whatever the contour
    // does, so the walk stops there.
    while (
      t <= capRadius + CAP_INSET &&
      inside(
        elbow.x + canvasW / 2 + t * Math.cos(a),
        canvasH / 2 - elbow.y - t * Math.sin(a),
      )
    ) {
      t++;
    }
    return Math.min(capRadius, Math.max(1, t - CAP_INSET));
  });
  return {
    shoulder,
    shoulderRadius: ru,
    elbow,
    capRadius,
    capRays,
    seamRun: [s - bbox.x, e - bbox.x],
    side: shoulder.x > bodyAxisX ? 1 : -1,
  };
}

/** A mesh from part-local ±0.5 vertices, its UVs following them
 *  (u = x + 0.5, v = 0.5 − y). */
function meshOf(vertices: number[], indices: number[]): IkiMesh {
  const uvs = vertices.map((v, i) =>
    roundTo(i % 2 === 0 ? v + 0.5 : 0.5 - v, 1e-5),
  );
  return { vertices, uvs, indices };
}

/**
 * The arm's three parts over its crop's box: the elbow cap, the upper arm and
 * the forearm, at `order`, `order + 1` and `order + 2`. The upper arm is the
 * band from the crop's top to the seam, on `armDeformer_X`; the forearm is
 * the band from the seam to the crop's bottom; the cap, on
 * `forearmDeformer_X`, is a fan from the elbow pivot over the arm's contour
 * above the seam (`capRays`) and a ring round it that sweeps the seam row's
 * edge cross-section (the right edge's on the right half, the left's on the
 * left; the top vertex is there twice, once for each). The ring's outer
 * vertex takes the column just past the run, the inner one `CAP_RIM` of the
 * cap radius inward, both at the seam's row, kept inside the crop. Their
 * texture rect is the host's, as every part's is: all take the crop's
 * (`partIdsOfRole`).
 */
export function armParts(
  role: ArmRole,
  layer: LayerInput,
  g: ArmGeometry,
  order: number,
): [IkiPart, IkiPart, IkiPart] {
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

  // The cap's vertices: the elbow, the fan's arc at the ring's inner radius,
  // then the ring's inner and outer arcs, whose top ray (π/2) is there twice.
  const rays = g.capRays.length;
  const top = (rays - 1) / 2;
  const at = (i: number, r: number) => {
    const a = (Math.PI * i) / (rays - 1);
    return [lx(g.elbow.x + r * Math.cos(a)), ly(g.elbow.y + r * Math.sin(a))];
  };
  const width = (i: number) =>
    Math.min(CAP_RIM * g.capRadius, g.capRays[i] / 2);
  const ringRays = Array.from({ length: rays }, (_, i) => i);
  ringRays.splice(top, 0, top);
  const vertices = [lx(g.elbow.x), seam];
  for (let i = 0; i < rays; i++) {
    vertices.push(...at(i, g.capRays[i] - width(i)));
  }
  const ringInner = vertices.length / 2;
  for (const i of ringRays) vertices.push(...at(i, g.capRays[i] - width(i)));
  const ringOuter = vertices.length / 2;
  for (const i of ringRays) vertices.push(...at(i, g.capRays[i]));

  const { uvs } = meshOf(vertices, []);
  // The seam row's edge cross-section, in u: the centre of the column just
  // past the run, which the crop may not hold when the run fills it.
  const col = (c: number) =>
    roundTo(Math.min(Math.max(c + 0.5, 0.5), bw(b) - 0.5) / bw(b), 1e-5);
  const v = roundTo(0.5 - seam, 1e-5);
  ringRays.forEach((i, j) => {
    // The first copy of the top ray is on the right, the second on the left.
    const right = j <= top;
    const outer = right ? g.seamRun[1] : g.seamRun[0] - 1;
    const step = right ? -width(i) : width(i);
    uvs[(ringInner + j) * 2] = col(outer + step);
    uvs[(ringInner + j) * 2 + 1] = v;
    uvs[(ringOuter + j) * 2] = col(outer);
    uvs[(ringOuter + j) * 2 + 1] = v;
  });

  const fan: number[] = [];
  for (let i = 0; i < rays - 1; i++) fan.push(0, 1 + i, 2 + i);
  const ring: number[] = [];
  for (let j = 0; j < ringRays.length - 1; j++) {
    // The top ray's two copies are not a segment.
    if (j === top) continue;
    const [p, q] = [ringInner + j, ringOuter + j];
    ring.push(p, q, q + 1, p, q + 1, p + 1);
  }

  const part = (
    id: string,
    deformer: string,
    z: number,
    mesh: IkiMesh,
  ): IkiPart => ({
    id,
    color: [1, 1, 1, 1],
    width: bw(b),
    height: bh(b),
    transform: { x: cx(b), y: cy(b) },
    order: z,
    deformer,
    mesh,
  });
  const ids = ARM_IDS[role];
  return [
    part(ids.cap, ids.forearmDeformer, order, {
      vertices,
      uvs,
      indices: [...fan, ...ring],
    }),
    part(role, ids.armDeformer, order + 1, meshOf(band(0.5, seam), quad)),
    part(
      ids.forearm,
      ids.forearmDeformer,
      order + 2,
      meshOf(band(seam, -0.5), quad),
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
