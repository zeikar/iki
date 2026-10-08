/**
 * Everything a part does besides the head turn: the blink fold, gaze, brows,
 * mouth, hair sway, and the hang of hair and the neck's stillness under a
 * roll. Each is a per-vertex warp in the part's own ±0.5 space or a binding,
 * applied before the part's turn grid, so the turn carries it. Amplitudes are
 * the profile's (`profile.ts`).
 */

import {
  StandardParameter as P,
  type IkiBinding,
  type IkiMesh,
  type IkiWarp,
} from "@ikijs/format";
import {
  bh,
  bw,
  cx,
  DEG,
  meshPoints,
  roundTo,
  smoothstep,
  type Box,
} from "./layout";
import { AMPLITUDE, ROLL_DEG } from "./profile";

/** Hair sway parameters' range: a physics output, in degrees of swing. */
export const SWAY_RANGE = 20;
/** The sway grows down the layer as (distance from its top)^SWAY_CURVE. */
const SWAY_CURVE = 1.4;
/** The share of a roll the long hair gives back by hanging. */
const HAIR_HANG = 0.35;
/** Roll stops for the hang and the neck: the profile's roll (`ROLL_DEG`),
 *  which the linear blend between 0 and ±30 carries within about a pixel. */
export const Z_STOPS = [-30, 0, 30];

type Vec = [number, number];

/** A warp whose keyform at each value is the model-space displacement `f`
 *  gives each vertex (`i` its index), stored in the part's local units. */
export function localWarp(
  parameter: string,
  mesh: IkiMesh,
  box: Box,
  values: number[],
  f: (p: Vec, value: number, i: number) => Vec,
): IkiWarp {
  const pts = meshPoints(mesh, box);
  const w = bw(box);
  const h = bh(box);
  return {
    parameter,
    keyforms: values.map((value) => ({
      value,
      offsets: pts.flatMap((p, i) => {
        const [dx, dy] = f(p, value, i);
        return [roundTo(dx / w, 1e-4), roundTo(dy / h, 1e-4)];
      }),
    })),
  };
}

/** The roll AngleZ `v` gives a head that rolls `deg` at ±30, radians,
 *  CCW-positive (AngleZ is clockwise-positive, Live2D's). */
export const rollOf = (v: number, deg = ROLL_DEG): number =>
  (-v / 30) * deg * DEG;

/** How far past its own box, per side, a part's vertices can travel under
 *  its warps (each at its extremes, summed) and its translate bindings —
 *  the margin its turn grid must cover, or the engine clamps it flat. */
export interface Reach {
  left: number;
  right: number;
  bottom: number;
  top: number;
}

export function motionReach(
  warps: IkiWarp[] | undefined,
  mesh: IkiMesh | undefined,
  box: Box,
  extra: Vec = [0, 0],
): Reach {
  const out: Reach = {
    left: extra[0],
    right: extra[0],
    bottom: extra[1],
    top: extra[1],
  };
  if (mesh === undefined) return out;
  const pts = meshPoints(mesh, box);
  for (const warp of warps ?? []) {
    let l = 0;
    let r = 0;
    let b = 0;
    let t = 0;
    for (const k of warp.keyforms) {
      pts.forEach(([x, y], i) => {
        const px = x + k.offsets[2 * i] * bw(box);
        const py = y + k.offsets[2 * i + 1] * bh(box);
        l = Math.max(l, box.x0 - px);
        r = Math.max(r, px - box.x1);
        b = Math.max(b, box.y0 - py);
        t = Math.max(t, py - box.y1);
      });
    }
    out.left += l;
    out.right += r;
    out.bottom += b;
    out.top += t;
  }
  return out;
}

// --- eyes ---------------------------------------------------------------------

/** The eye white folds shut onto a crease, the upper lid coming `travel` of
 *  the eye's height down; as its clip region closes, the iris is cut away
 *  rather than squashed. Shut, it has no height at all: any band left open
 *  shows a strip of iris under the lash. A lower lash (`box`, drawn over the
 *  iris) folds onto the same crease of its `eye`, so it moves with the
 *  white's rows and closes into the seam under the upper lash. */
export function blinkFold(
  param: string,
  mesh: IkiMesh,
  box: Box,
  travel: number,
  eye: Box = box,
): IkiWarp {
  const yc = eye.y1 - travel * bh(eye);
  return localWarp(param, mesh, box, [0, 1], ([, y], v) =>
    v === 1 ? [0, 0] : [0, yc - y],
  );
}

/** The upper lash comes down onto the crease and flattens over the seam the
 *  folded white leaves. A lash is drawn arched; shut, that arch would read
 *  as a smile, so its middle comes down further than its ends. */
export function lashFold(
  param: string,
  mesh: IkiMesh,
  lash: Box,
  eye: Box,
  travel: number,
): IkiWarp {
  const yc = eye.y1 - travel * bh(eye) - 0.04 * bh(eye);
  const c = cx(lash);
  const half = bw(lash) / 2;
  const sag = 0.3 * bh(lash);
  return localWarp(param, mesh, lash, [0, 1], ([x, y], v) => {
    if (v === 1) return [0, 0];
    const u = (x - c) / half;
    return [0, yc + (y - lash.y0) * 0.5 - sag * (1 - u * u) - y];
  });
}

/** Gaze: the iris (and pupil) travel within the white, a fraction of the
 *  iris's own width; a highlight is a reflection and travels half as far. */
export function gazeBindings(irisW: number, share = 1): IkiBinding[] {
  const gx = AMPLITUDE.gazeX * irisW * share;
  const gy = AMPLITUDE.gazeY * irisW * share;
  return [
    {
      parameter: P.EyeballX,
      channel: "translateX",
      from: -round1(gx),
      to: round1(gx),
    },
    {
      parameter: P.EyeballY,
      channel: "translateY",
      from: -round1(gy),
      to: round1(gy),
    },
  ];
}

export function gazeReach(irisW: number, share = 1): Vec {
  return [AMPLITUDE.gazeX * irisW * share, AMPLITUDE.gazeY * irisW * share];
}

// --- brows ----------------------------------------------------------------------

/** How far a brow raises and lowers, px. */
export function browReach(hh: number): number {
  return AMPLITUDE.brow * hh;
}

export function browBindings(side: "L" | "R", reach: number): IkiBinding[] {
  const y = side === "L" ? P.BrowLeftY : P.BrowRightY;
  const a = side === "L" ? P.BrowLeftAngle : P.BrowRightAngle;
  return [
    {
      parameter: y,
      channel: "translateY",
      from: -round1(reach),
      to: round1(reach),
    },
    { parameter: a, channel: "rotate", from: -BROW_TILT, to: BROW_TILT },
  ];
}
export const BROW_TILT = 15;

// --- mouth ----------------------------------------------------------------------

/** Where a mouth's Form bend and widen are centred, and how far they reach:
 *  the centre x, the half-width, and the corners' lift. A stack of mouth parts
 *  (the lip set) shares the frame of their union, so every part at the same x
 *  moves the same and the corners stay joined; the default is the part's own
 *  box, as the single closed mouth has always had. */
export interface MouthFrame {
  c: number;
  half: number;
  amp: number;
}

export const mouthFrameOf = (box: Box): MouthFrame => ({
  c: cx(box),
  half: bw(box) / 2,
  amp: 0.3 * bh(box),
});

/** Smile lifts the corners and widens the mouth a little; frown the reverse. */
export function mouthForm(
  mesh: IkiMesh,
  box: Box,
  frame: MouthFrame = mouthFrameOf(box),
): IkiWarp {
  const { c, half, amp: a } = frame;
  return localWarp(P.MouthForm, mesh, box, [-1, 0, 1], ([x], v) => {
    if (v === 0) return [0, 0];
    const u = (x - c) / half;
    const widen = v > 0 ? 0.05 : 0.03;
    return [v * widen * (x - c), v * a * (u * u - 0.3)];
  });
}

/** The open drawing grows out of the closed lips: shut, it is a line along
 *  its own top lip; open, it is as wide as the profile's mouth gets. */
export function mouthOpenGrow(mesh: IkiMesh, box: Box): IkiWarp {
  const c = cx(box);
  return localWarp(P.MouthOpen, mesh, box, [0, 1], ([x, y], v) =>
    v === 1
      ? [(AMPLITUDE.mouthOpenWidth - 1) * (x - c), 0]
      : [0, box.y1 + (y - box.y1) * 0.2 - y],
  );
}

/** The closed lips widen as they open (and fade). */
export function mouthWiden(
  mesh: IkiMesh,
  box: Box,
  frame: MouthFrame = mouthFrameOf(box),
): IkiWarp {
  const c = frame.c;
  return localWarp(P.MouthOpen, mesh, box, [0, 1], ([x], v) => [
    v * (AMPLITUDE.mouthOpenWidth - 1) * (x - c),
    0,
  ]);
}

// --- hair -------------------------------------------------------------------------

/** Root-pinned sway: the top of the layer stays, its ends swing `amp` px at
 *  full sway. */
export function hairSway(
  param: string,
  mesh: IkiMesh,
  box: Box,
  amp: number,
): IkiWarp {
  return localWarp(
    param,
    mesh,
    box,
    [-SWAY_RANGE, 0, SWAY_RANGE],
    ([, y], v) => {
      const t = Math.max(0, (box.y1 - y) / bh(box));
      return [(v / SWAY_RANGE) * amp * t ** SWAY_CURVE, 0];
    },
  );
}

/**
 * Hang under a roll: the head rotates `deg` about `pivot` at AngleZ ±30;
 * each vertex is turned back by `weight(y, i)` of that. The head's world roll
 * is `ROLL_DEG`; on a body its own roll is that less the body's roll at the
 * chin (`headOwnRoll`). The neck undoes all of the head's own roll, so it
 * rides the torso; long hair undoes some of the world roll, so it hangs
 * rather than swinging out like a board.
 */
export function tiltHang(
  mesh: IkiMesh,
  box: Box,
  pivot: Vec,
  weight: (y: number, i: number) => number,
  deg = ROLL_DEG,
): IkiWarp {
  return localWarp(P.AngleZ, mesh, box, Z_STOPS, ([x, y], v, i) => {
    const g = weight(y, i);
    if (g === 0 || v === 0) return [0, 0];
    const a = -g * rollOf(v, deg);
    const px = x - pivot[0];
    const py = y - pivot[1];
    return [
      pivot[0] + px * Math.cos(a) - py * Math.sin(a) - x,
      pivot[1] + px * Math.sin(a) + py * Math.cos(a) - y,
    ];
  });
}

/** Long hair's hang weight: none above the pivot, rising to HAIR_HANG at the
 *  layer's bottom. */
export function hairHangWeight(
  pivotY: number,
  bottom: number,
): (y: number) => number {
  // Hair that ends above the pivot (a fringe) hangs from nothing: it rolls
  // with the head.
  if (bottom >= pivotY) return () => 0;
  return (y) => HAIR_HANG * smoothstep(pivotY, bottom, y);
}

const round1 = (v: number) => roundTo(v, 0.1);
