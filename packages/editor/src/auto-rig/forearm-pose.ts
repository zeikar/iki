/**
 * The pose forearm. A second drawn forearm per side (`forearm_pose_L` /
 * `forearm_pose_R`), drawn raised: it hangs from the arm's elbow and is
 * swapped in for the hanging forearm by a switch.
 * - One part, the role's own id, over its crop's box on `armPoseDeformer_X`,
 *   a child of `armDeformer_X` pivoting at the arm's elbow. It is not a child
 *   of `forearmDeformer_X`, so `ParamElbowX` never moves it, and the shoulder
 *   still carries it.
 * - `ParamArmPoseX` (0..1) swaps: the hanging forearm and the elbow cap fade
 *   out on it, 1 to 0 (`armParts`), the pose forearm fades in, 0 to 1. The
 *   pair is exclusive by construction, and between the ends both show at
 *   partial opacity. The part has no mesh: the engine draws a meshless part
 *   as its full-box quad with its texture rect, and a rigid part needs no
 *   more.
 * - `ParamArmPoseAngleX` rocks it about the elbow, in degrees over
 *   `POSE_ANGLE_RANGE`. + tips the raised hand outward, away from the body,
 *   mirrored per side. The part points up from its pivot where the hanging
 *   forearm points down, so its rotate binding takes −side × the value; the
 *   elbow's multiplier is the same −side, which gives the shoulder's reading.
 * The composer puts the drawing's elbow end on the pivot (`measure` warns
 * when it is off), so the rig does not use the crop's own pivot
 * (`forearmPoseGeometry`).
 *
 * It draws after the hair, above the face and the front hair: a raised hand
 * passes them (`ROLE_TABLE`).
 */

import {
  StandardParameter as P,
  type IkiMatrixDeformer,
  type IkiPart,
} from "@ikijs/format";
import {
  ARM_IDS,
  endPivot,
  rotateBinding,
  type ArmGeometry,
  type ArmRole,
} from "./arms";
import { bh, boxOfLayer, bw, cx, cy, roundTo } from "./layout";
import type { LayerInput } from "./types";

export type ForearmPoseRole = "forearm_pose_L" | "forearm_pose_R";

/** The arm a pose forearm hangs from, and the pose forearm of an arm. */
export const ARM_OF_POSE: Record<ForearmPoseRole, ArmRole> = {
  forearm_pose_L: "arm_L",
  forearm_pose_R: "arm_R",
};
export const POSE_OF_ARM: Record<ArmRole, ForearmPoseRole> = {
  arm_L: "forearm_pose_L",
  arm_R: "forearm_pose_R",
};
/** Each pose forearm's swap and rock parameters. */
export const POSE_PARAMS: Record<
  ForearmPoseRole,
  { pose: string; angle: string }
> = {
  forearm_pose_L: { pose: P.ArmPoseLeft, angle: P.ArmPoseAngleLeft },
  forearm_pose_R: { pose: P.ArmPoseRight, angle: P.ArmPoseAngleRight },
};
/** Each pose forearm's deformer id. */
export const POSE_IDS: Record<ForearmPoseRole, string> = {
  forearm_pose_L: "armPoseDeformer_L",
  forearm_pose_R: "armPoseDeformer_R",
};
/** ParamArmPoseAngleX, degrees: our own, picked by eye on street;
 *  the span 30 puts 0, ±7.5 and ±15 on the playground's slider steps
 *  ((max − min) / 100 = 0.3). */
export const POSE_ANGLE_RANGE = [-15, 15] as const;

export interface ForearmPoseGeometry {
  /** The elbow end's pivot, model space: where the drawing's elbow end is
   *  centred. */
  pivot: { x: number; y: number };
  /** r_e: half the elbow end's width, px. */
  radius: number;
  /** The first painted row's model y: the raised hand's top. */
  top: number;
}

/**
 * The pose forearm's own geometry: the shoulder rule run from the bottom
 * (`endPivot`), since it is drawn standing up from its elbow, plus the top of
 * the paint.
 */
export function forearmPoseGeometry(layer: LayerInput): ForearmPoseGeometry {
  const { point, radius } = endPivot(layer, "bottom");
  const first = layer.rowRuns?.findIndex((runs) => runs.length > 0) ?? -1;
  const k = first < 0 ? 0 : first;
  return {
    pivot: point,
    radius,
    top: roundTo(layer.canvasH / 2 - (layer.bbox.y + k + 0.5), 0.01),
  };
}

/** The pose forearm's part over its crop's box, at `order`, fading in on its
 *  switch. No mesh: see the header. */
export function forearmPosePart(
  role: ForearmPoseRole,
  layer: LayerInput,
  order: number,
): IkiPart {
  const b = boxOfLayer(layer);
  return {
    id: role,
    color: [1, 1, 1, 1],
    width: bw(b),
    height: bh(b),
    transform: { x: cx(b), y: cy(b) },
    order,
    deformer: POSE_IDS[role],
    bindings: [
      { parameter: POSE_PARAMS[role].pose, channel: "opacity", from: 0, to: 1 },
    ],
  };
}

/** `armPoseDeformer_X`: hung from the arm's deformer at its elbow, turning
 *  by −side × `ParamArmPoseAngleX`. */
export function forearmPoseDeformer(
  role: ForearmPoseRole,
  arm: ArmGeometry,
): IkiMatrixDeformer {
  return {
    id: POSE_IDS[role],
    parent: ARM_IDS[ARM_OF_POSE[role]].armDeformer,
    pivot: { ...arm.elbow },
    bindings: [
      rotateBinding(POSE_PARAMS[role].angle, POSE_ANGLE_RANGE, -arm.side),
    ],
  };
}
