/**
 * The public shapes of the auto-rig: what a host hands `generateIkiFromLayerSet`
 * and what the turn solve and the patch replay report back. Pixel measurement
 * lives in `layer-measure.ts`; everything here is already-decoded geometry.
 */

import { TURN } from "./profile";
import { type RigPlan, type RigPlanReport } from "./rig-plan";

const round2 = (v: number) => Math.round(v * 100) / 100;

/** One role layer, as a host measured it off its decoded pixels. */
export interface LayerInput {
  /** Canonical role (see `parseLayerRoles`); becomes the part ids
   *  `partIdsOfRole` lists. */
  role: string;
  fileName: string;
  canvasW: number;
  canvasH: number;
  /** Alpha bounding box in canvas px (y down) — the crop the atlas holds. */
  bbox: { x: number; y: number; w: number; h: number };
  cropW: number;
  cropH: number;
  /** Face only: half the opaque span of each crop row, canvas px (0 = none). */
  rowHalfWidths?: number[];
  /** `face` / `hair_front` / `hair_back` / `hair_side_L` / `hair_side_R` /
   *  `body` / `arm_L` / `arm_R` / `forearm_pose_L` / `forearm_pose_R` /
   *  `mouth_inner` / `lip_lower` / `lip_upper` only:
   *  per crop row, its opaque (alpha ≥ 128) runs as a flat list of canvas
   *  columns `[start0, end0, start1, end1, …]`, each end exclusive (`[]` for a
   *  row with none). The actual pixels, so a gap in the hair is a gap here:
   *  the turn and the nod read off it where back hair is painted behind the
   *  front hair, and the crown's turn reads the face's so it never bares skin.
   *  A side lock's place where it leaves the bangs, and its edges for the
   *  report. The body's place the hips (where it splits into legs), and an
   *  arm's place its shoulder and elbow pivots, a pose forearm's its
   *  elbow-end pivot, and a lip set's place the mouth's opening: the upper
   *  line's bottom, the interior's span, the skin's top. */
  rowRuns?: number[][];
  /** Nose only: the tight box of its alpha ≥ 128 pixels, canvas px. */
  denseCore?: { x: number; y: number; w: number; h: number };
  /** Face only: per crop column, the canvas row of the last pixel of the
   *  first dark stroke met going down from the plate's widest row (the jaw's
   *  outline, across a neck), or −1 where the column leaves the paint first.
   *  Where the head ends and the neck the body keeps begins. */
  jawRows?: number[];
}

/**
 * One side's iris against the `hair_front` run it would slide under on the
 * turn, on the row holding the iris centre. Model coordinates: x is canvas x
 * minus half the canvas width, y is half the canvas height minus canvas y.
 */
export interface IrisStrand {
  y: number;
  irisOuter: number;
  irisInner: number;
  runOuter: number;
  /** The run's face-side end; `null` for a fringe spanning the face. */
  runFace: number | null;
}

/**
 * Head-turn cues at ±30°, as `measure_turn_reference` reads them off a front
 * and a turned image. Shifts are fractions of the head half-width, taken as
 * magnitudes: that tool signs them by the reference's turn direction.
 */
export interface TurnTargets {
  eyeShift?: number;
  farEyeRatio?: number;
  silhouetteRatio?: number;
  noseShift?: number;
  mouthShift?: number;
  /** The head half-width the shifts are fractions of, canvas px. */
  headHalfWidth?: number;
}

/** A turn target this layer set cannot reach, or turn input that is malformed. */
export class TurnTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnTargetError";
  }
}

/**
 * Art geometry the rig cannot build on — a body whose hips leave no row line
 * under its pivots, or too little room for its motion (`body.ts`), an arm
 * without room for its pivots, a lip set whose interior has no opaque pixel
 * (`mouth.ts`). A fact about the layers, not a bug, so a host reports it as an
 * input error.
 */
export class LayerGeometryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LayerGeometryError";
  }
}

/**
 * The profile's own turn (`profile.ts`), in the cues' units — what a rig with
 * no `turnTargets` renders on a head whose silhouette at the eye row is back
 * hair about 1 hh (eye row → chin) wide. eyeShift: the eye pair's mean shift
 * at ±30 less the back hair's drift, over a 1 hh head half-width.
 * farEyeRatio: the far eye's width over the near one's. silhouetteRatio: the
 * silhouette holds its width.
 *
 * With no target given the rig renders the profile itself, whatever the cues
 * then read on its art (a head whose front hair or a `hair_side_*` lock draws
 * its silhouette at the eye row, and rides the face, reads a smaller
 * eyeShift); a given target is fitted.
 */
export const DEFAULT_TURN_TARGETS: Readonly<
  Required<Pick<TurnTargets, "eyeShift" | "farEyeRatio" | "silhouetteRatio">>
> = Object.freeze({
  eyeShift: round2((TURN.eyeFar + TURN.eyeNear) / 2 - TURN.hairBack),
  farEyeRatio: round2(TURN.eyeFarScale / TURN.eyeNearScale),
  silhouetteRatio: 1,
});

/** How far each feature family stands in front of the plate, as the depth a
 *  rotation would need to give its shift at ±30 (shift / sin 30°), in head
 *  half-widths — the nose leads the mouth and the mouth the eyes. */
export interface TurnDepths {
  eye: number;
  nose: number;
  mouth: number;
}

/** How much of a far iris's painted row the bangs' run covers. */
export interface StrandOverlap {
  /** The turn stop (AngleX, degrees) where the coverage is largest. */
  deg: number;
  /** Covered width there, canvas px. */
  px: number;
  /** The same in head half-widths. */
  hh: number;
  /** Covered width at rest. */
  restPx: number;
  /** Whether the iris went no deeper under the run than it is painted.
   *  Always `false` for a fringe spanning the face (`runFace: null`), which
   *  has no side to keep the iris clear of. */
  held: boolean;
}

export interface TurnSolveReport {
  /** The curvature the plate would need to put the eyes as far in front of
   *  its edge as their lead over it does, as a radius, canvas px. */
  radius: number;
  /** The measured head half-width, canvas px, which the shift cues are
   *  fractions of — on a set with none measured (hairless) the face crop's
   *  half-width, while the cues are then fractions of the plate's painted
   *  half-width at the eye row. */
  holdBase: number;
  depths: TurnDepths;
  /** What the rig renders at ±30° (mean of both directions). */
  achieved: { eyeShift: number; farEyeRatio: number; silhouetteRatio: number };
  /** Targets cut down to what this layer set can do. */
  clamped: (keyof TurnTargets)[];
  strandOverlap?: { left?: StrandOverlap; right?: StrandOverlap };
  /** The side locks' room, report only (nothing bounds by it): `left` is the
   *  lock on the −x side (the character's `hair_side_R`), `right` the one on
   *  +x, found by where its box lies about the head's axis (two locks on one
   *  side of the axis: the first role in the role table is reported).
   *  Present when a lock is. */
  hairSide?: { left?: HairSideRoom; right?: HairSideRoom };
}

/**
 * How one side lock keeps its room on the turn, measured as the far lock at
 * that side's far stops (−15 and −30 on the −x side, 15 and 30 on +x), px,
 * every x landed through the rendered rig. A number that cannot be read is
 * left out.
 */
export interface HairSideRoom {
  role: "hair_side_L" | "hair_side_R";
  /** The lock's outer edge against the plate's painted edge: over the lock's
   *  pixel rows that lie on the plate (`face.y0..y1`) and carry a run, the
   *  least of (the lock's outer edge landed − the plate's painted edge
   *  landed), signed outward: positive, the lock covers the plate's edge;
   *  negative, skin shows past it. `deg` is the stop and `y` the model row
   *  where it is least. Omitted when no lock row on the plate carries a run. */
  cover?: { deg: number; px: number; y: number };
  /** The far eye's outer tail on the eye's centre row, at the stop where
   *  `eyeToLock` is least. `eyeToLock`: the eye white's outer corner landed
   *  vs the lock's face-side edge landed there (the inner end of the run
   *  holding its outer edge), signed toward the face: positive, a gap;
   *  negative, the corner is under the lock by that much (intended).
   *  `lashToLock`: the lash box's outer x, landed on the eye's centre row
   *  too, against the same lock edge, when a `lash_*` is present.
   *  `eyeToPlate`: the plate's painted edge landed minus the eye's corner
   *  landed, signed toward the face: how far inside the plate the corner
   *  sits (where the ear begins). Omitted when the lock has
   *  no run on the eye's centre row. */
  tail?: {
    deg: number;
    eyeToLock: number;
    lashToLock?: number;
    eyeToPlate: number;
  };
  /** The lock carries no `rowRuns`: nothing else is reported. */
  unavailable?: string;
}

/**
 * One `displace` op of the rig patch layer: a displacement ADDED to one
 * EXISTING keyform stop of `target` on the freshly generated rig, so it is
 * replayed on every re-rig over whatever the generator now bakes. Every other
 * stop and the rest pose stay as generated; between stops the engine blends
 * linearly, so a fix at AngleX −30 shows at half strength at −15.
 */
export interface RigPatch {
  /** A feature grid (`eyeWarp_L`/`_R`, `browWarp_L`/`_R`, `noseWarp`,
   *  `mouthWarp`) or a mesh part with warps (`face`, `hair_front`, …). The
   *  body warp and the matrix deformers are not patchable. */
  target: string;
  /** The stop. A grid's names both `ParamAngleX` and `ParamAngleY`, each one
   *  of its stops (−30, 0, 30), never both 0; a part's names exactly one
   *  parameter it has a warp keyform at, never at that parameter's default
   *  nor where the rig shuts the part on purpose (`SHUT_BY` at 0). */
  at: Record<string, number>;
  /** A rectangle in fractions of the REST layer box of `role`, origin
   *  top-left, x right, y DOWN; it may reach past the box (x < 0 or > 1).
   *  The target's points whose REST position lies inside take the whole of
   *  `by`. */
  region: { role: string; x: [number, number]; y: [number, number] };
  /** In face widths (the `face` layer's crop width), screen axes: +dx toward
   *  the viewer's right (a character's `_L` side), +dy DOWN. */
  by: { dx: number; dy: number };
  /** Face widths past the region over which `by` eases to nothing; 0 or
   *  absent, a hard edge. */
  falloff?: number;
  /** Why the op exists, for whoever edits the patches next; the rig ignores
   *  it. */
  why?: string;
}

/** What one op moved on the rig it was replayed on. */
export interface PatchReport {
  /** The op's index in `patches`. */
  index: number;
  target: string;
  at: Record<string, number>;
  /** Points (grid) or vertices (part) the op moved at all. */
  moved: number;
  /** All of the target's points or vertices. */
  of: number;
  /** Grid targets only: the lattice columns and rows the moved points span,
   *  0 at the left and at the top. */
  cols?: [number, number];
  rows?: [number, number];
  /** The largest move, model px. */
  maxPx: number;
}

/** A patch op that is malformed or misses the rig: an unknown target, role,
 *  key or stop, the rest stop, a by-design closure, or a region that catches
 *  none of the target's points. Its message starts `patches[i]`. */
export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchError";
  }
}

export interface HeadEdges {
  left: { role: string; x: number }[];
  right: { role: string; x: number }[];
}

export interface GenerateOptions {
  turnTargets?: TurnTargets;
  /** Per-character tuning from the profile's defaults, validated against
   *  `RIG_PLAN_FIELDS`; a bad field throws `RigPlanError`. */
  rigPlan?: RigPlan;
  /** Removed: pass `rigPlan`. A value here throws `RigPlanError`. */
  style?: never;
  /** What the rig built with, next to what `rigPlan` asked — called for every
   *  model that validates, with or without a nose. */
  onRigPlanResolved?: (report: RigPlanReport) => void;
  onTurnSolved?: (report: TurnSolveReport) => void;
  /** Displacements added to the generated rig's stops (`RigPatch`), replayed
   *  on every rig; a refused op throws `PatchError` and rigs nothing. */
  patches?: RigPatch[];
  /** What each of `patches` moved, in order — called only when `patches` is
   *  given, and only for a model that validates. */
  onPatchesApplied?: (report: PatchReport[]) => void;
  headEdges?: HeadEdges;
  strandEdges?: { left?: IrisStrand; right?: IrisStrand };
}
