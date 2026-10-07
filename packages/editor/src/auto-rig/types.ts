/**
 * The public shapes of the auto-rig: what a host hands `generateIkiFromLayerSet`
 * and what the turn solve reports back. Pixel measurement lives in
 * `layer-measure.ts`; everything here is already-decoded geometry.
 */

import { TURN, type RigStyle } from "./profile";

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
  /** `face` / `hair_front` / `hair_back` / `body` / `arm_L` / `arm_R` only:
   *  per crop row, its opaque (alpha ≥ 128) runs as a flat list of canvas
   *  columns `[start0, end0, start1, end1, …]`, each end exclusive (`[]` for a
   *  row with none). The actual pixels, so a gap in the hair is a gap here:
   *  the turn and the nod read off it where back hair is painted behind the
   *  front hair, and the crown's turn reads the face's so it never bares skin.
   *  The body's place the hips (where it splits into legs), and an arm's place
   *  its shoulder and elbow pivots. */
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
 * Art geometry the rig cannot build on — today a body whose hips leave no row
 * line under its pivots, or too little room for its motion (`body.ts`). A fact about the layers, not a bug, so a
 * host reports it as an input error.
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
 * then read on its art (a head whose side locks draw its silhouette, and ride
 * the face, reads a smaller eyeShift); a given target is fitted.
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
}

export interface HeadEdges {
  left: { role: string; x: number }[];
  right: { role: string; x: number }[];
}

export interface GenerateOptions {
  turnTargets?: TurnTargets;
  /** Per-character tuning from the profile's defaults (`profile.ts`). */
  style?: RigStyle;
  onTurnSolved?: (report: TurnSolveReport) => void;
  headEdges?: HeadEdges;
  strandEdges?: { left?: IrisStrand; right?: IrisStrand };
}
