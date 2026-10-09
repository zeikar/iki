/**
 * What the turn solve reads off the layers — the cue rows, the silhouette,
 * the landmarks — and the lander that reads a finished rig back the way the
 * engine renders it.
 */

import { StandardParameter as P, type IkiPart } from "@ikijs/format";
import type { HeadFrame } from "./head";
import {
  boxOfLayer,
  boxOfPixels,
  bw,
  cx,
  cy,
  meshPoints,
  type Box,
} from "./layout";
import { mouthAnchor } from "./mouth";
import { roleSpec, type Family } from "./roles";
import { blendStops, keyformAt, land, type Lattice } from "./grid";
import { familyField, type TurnModel } from "./fields";
import type { IrisRow, Lander, SolveContext } from "./solve";
import type { GenerateOptions, IrisStrand, LayerInput } from "./types";

interface SideBox {
  role: string;
  box: Box;
}

/** A pair of roles as they sit on the canvas, the −x one first — which is
 *  the character's right by convention, but the art decides. */
function sidePair(
  byRole: Map<string, LayerInput>,
  a: string,
  b: string,
): { left: SideBox; right: SideBox } | undefined {
  const la = byRole.get(a);
  const lb = byRole.get(b);
  if (la === undefined || lb === undefined) return undefined;
  const [lo, hi] = [
    { role: a, box: boxOfLayer(la) },
    { role: b, box: boxOfLayer(lb) },
  ].sort((p, q) => cx(p.box) - cx(q.box));
  return { left: lo, right: hi };
}

/** The irises on each side of the face, by x. */
export function sideIrises(byRole: Map<string, LayerInput>): {
  left?: Box;
  right?: Box;
} {
  const pair = sidePair(byRole, "iris_L", "iris_R");
  return pair === undefined
    ? {}
    : { left: pair.left.box, right: pair.right.box };
}

export function solveContext(
  frame: HeadFrame,
  byRole: Map<string, LayerInput>,
  options: GenerateOptions,
  hasNose: boolean,
): SolveContext {
  // The cue rows: each iris's painted span on its centre row, as measured;
  // failing that its crop less the one-pixel alpha margin; failing irises,
  // the eye whites.
  const row = (
    s: SideBox,
    strand: IrisStrand | undefined,
    sideSign: -1 | 1,
  ): IrisRow => {
    if (strand !== undefined) {
      const lo = sideSign < 0 ? strand.irisOuter : strand.irisInner;
      const hi = sideSign < 0 ? strand.irisInner : strand.irisOuter;
      return { role: s.role, lo, hi, y: strand.y };
    }
    const inset = bw(s.box) > 4 ? 1 : 0;
    return {
      role: s.role,
      lo: s.box.x0 + inset,
      hi: s.box.x1 - inset,
      y: cy(s.box),
    };
  };
  const eyes = sidePair(byRole, "eye_L", "eye_R")!;
  const irises = sidePair(byRole, "iris_L", "iris_R");
  const pair = irises ?? eyes;
  const strand = irises ? options.strandEdges : undefined;
  const left = row(pair.left, strand?.left, -1);
  const right = row(pair.right, strand?.right, 1);

  // The silhouette at the eye row: the layers the measurer found there, each
  // landing through its own motion; without them, the held outline or the
  // plate's own painted edge.
  let candidates: SolveContext["candidates"];
  const edges = options.headEdges;
  if (
    frame.hairShell &&
    edges &&
    edges.left.length > 0 &&
    edges.right.length > 0
  ) {
    candidates = {
      left: edges.left.map((e) => ({ role: e.role, x: e.x })),
      // A right edge names its outermost pixel column; the boundary is one on.
      right: edges.right.map((e) => ({ role: e.role, x: e.x + 1 })),
    };
  } else if (frame.hairShell) {
    candidates = {
      left: [{ role: "hair_back", x: frame.shellLeft }],
      right: [{ role: "hair_back", x: frame.shellRight }],
    };
  } else {
    const w = frame.paintedHalfAt(frame.eyeY);
    candidates = {
      left: [{ role: "face", x: frame.axisX - w }],
      right: [{ role: "face", x: frame.axisX + w }],
    };
  }
  const restHalf =
    (Math.max(...candidates.right.map((c) => c.x)) -
      Math.min(...candidates.left.map((c) => c.x))) /
    2;

  const nose = byRole.get("nose");
  let noseAt: { x: number; y: number } | undefined;
  let noseBox: Box | undefined;
  if (hasNose && nose !== undefined) {
    noseBox = nose.denseCore
      ? boxOfPixels(nose.denseCore, nose.canvasW, nose.canvasH)
      : boxOfLayer(nose);
    noseAt = { x: cx(noseBox), y: cy(noseBox) };
  }
  const mouth = mouthAnchor(byRole);
  return {
    frame,
    left,
    right,
    candidates,
    restHalf,
    strand,
    hasHairFront: byRole.has("hair_front"),
    eyeBoxes: { left: eyes.left.box, right: eyes.right.box },
    noseAt,
    noseBox,
    mouthAt: mouth.at,
    mouthBox: mouth.box,
  };
}

/**
 * Lands a point the way the engine draws it: the part's mesh vertices go
 * through its baked grid at the stop (or take its own AngleX keyform), and
 * the point is read linearly off the mesh triangle it rests in — the GPU's
 * interpolation, not the field's. `from` names, per part, the first index of
 * the triangles a point may land on (the face's head island).
 */
export function renderedLander(
  turn: TurnModel,
  parts: IkiPart[],
  grids: Map<Family, { lattice: Lattice; keyforms: number[][] }>,
  from: Map<string, number> = new Map(),
): Lander {
  const analytic = new Map<Family, ReturnType<typeof familyField>>();
  const landed = new Map<string, number[]>();
  const field = (role: string) => {
    const family = roleSpec(role).family;
    let f = analytic.get(family);
    if (f === undefined) analytic.set(family, (f = familyField(turn, family)));
    return f;
  };
  return (role, x, y, ax) => {
    const family = roleSpec(role).family;
    const part = parts.find((p) => p.id === role);
    const g = grids.get(family);
    const warp = part?.warps?.find((w) => w.parameter === P.AngleX);
    if (part === undefined || part.mesh === undefined || (!g && !warp)) {
      return x + field(role)(x, y, ax, 0)[0];
    }
    const box: Box = {
      x0: part.transform.x - part.width / 2,
      x1: part.transform.x + part.width / 2,
      y0: part.transform.y - part.height / 2,
      y1: part.transform.y + part.height / 2,
    };
    const rest = meshPoints(part.mesh, box);
    const key = `${role}@${ax}`;
    let xs = landed.get(key);
    if (xs === undefined) {
      if (g) {
        const offsets = keyformAt(g.keyforms, ax);
        xs = rest.map(([px, py]) => land(g.lattice, offsets, px, py)[0]);
      } else {
        const k = warp!.keyforms;
        const offsets = blendStops(
          k.map((kf) => kf.value),
          k.map((kf) => kf.offsets),
          ax,
        );
        xs = rest.map(([px], i) => px + offsets[2 * i] * bw(box));
      }
      landed.set(key, xs);
    }
    const idx = part.mesh.indices;
    for (let t = from.get(role) ?? 0; t < idx.length; t += 3) {
      const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
      const [ax0, ay0] = rest[a];
      const [bx0, by0] = rest[b];
      const [cx0, cy0] = rest[c];
      const d = (by0 - cy0) * (ax0 - cx0) + (cx0 - bx0) * (ay0 - cy0);
      if (Math.abs(d) < 1e-9) continue;
      const u = ((by0 - cy0) * (x - cx0) + (cx0 - bx0) * (y - cy0)) / d;
      const v = ((cy0 - ay0) * (x - cx0) + (ax0 - cx0) * (y - cy0)) / d;
      const w = 1 - u - v;
      if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
      return u * xs[a] + v * xs[b] + w * xs[c];
    }
    // Off the mesh (between islands, or past a trimmed cell): the field.
    return x + field(role)(x, y, ax, 0)[0];
  };
}
