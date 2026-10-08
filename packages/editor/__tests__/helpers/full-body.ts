/**
 * `character()`'s bust standing on a full body: every head layer keeps its
 * box on a canvas extended down by `extend` px, and the torso layer becomes a
 * figure down to the feet whose `rowRuns` split into two legs at the crotch,
 * optionally with two capsule arms hanging beside it and two capsule pose
 * forearms standing up from their elbows. No pixels: the
 * generator reads geometry only.
 */
import { armGeometry } from "../../src/auto-rig/arms";
import type { GenerateOptions, LayerInput } from "../../src/auto-rig/types";
import { CANVAS, character } from "./character";

/** The body's crop, canvas px. */
export const BODY_BOX = { x: 300, y: 740, w: 401, h: 1640 };
/** The torso's run, canvas columns `[start, end)`, on rows BODY_BOX.y to
 *  CROTCH_ROW − 1. */
export const TORSO_RUNS = [300, 701];
/** The first row the legs part on: 0.46 of the body's height down, inside
 *  `HIP_BAND`. */
export const CROTCH_ROW = 1500;
/** The two legs' runs, canvas columns, on rows CROTCH_ROW to FEET_ROW. */
export const LEG_RUNS = [320, 490, 511, 681];
/** The body's last row. */
export const FEET_ROW = BODY_BOX.y + BODY_BOX.h - 1;
/** `arm_R`'s crop, canvas px: against the torso's left edge, from just under
 *  its top down to the crotch. The character's right arm, so on the viewer's
 *  left (`parameters.ts`, SIDE CONVENTION). */
export const ARM_R_BOX = { x: 200, y: 780, w: 100, h: 700 };
/** `arm_L`'s crop: `arm_R`'s mirrored about the body's axis, canvas column
 *  BODY_BOX.x + BODY_BOX.w / 2. */
export const ARM_L_BOX = { x: 701, y: 780, w: 100, h: 700 };
/** Each arm's round top (the deltoid cap) and bottom (the hand), px. */
export const ARM_RADIUS = 50;

/** Each pose forearm's crop: a capsule as wide as the arm, standing up from its
 *  arm's elbow — its last row is the elbow's row plus ARM_RADIUS, so the
 *  shoulder rule run from the bottom lands its pivot on the elbow — 400 tall.
 *  `forearm_pose_R` over `arm_R`, `forearm_pose_L` over `arm_L`. */
function poseBox(armBox: typeof ARM_R_BOX): typeof ARM_R_BOX {
  const probe: LayerInput = {
    role: "arm_R",
    fileName: "arm_R.png",
    canvasW: CANVAS.width,
    canvasH: CANVAS.height,
    bbox: { ...armBox },
    cropW: armBox.w,
    cropH: armBox.h,
    rowRuns: capsuleRuns(armBox),
  };
  const elbow = armGeometry(probe, BODY_BOX.x + BODY_BOX.w / 2).elbow;
  const elbowRow = CANVAS.height / 2 - elbow.y - 0.5;
  return { x: armBox.x, y: elbowRow + ARM_RADIUS - 399, w: armBox.w, h: 400 };
}
export const POSE_R_BOX = poseBox(ARM_R_BOX);
export const POSE_L_BOX = poseBox(ARM_L_BOX);

/** A capsule filling `box`: one run per row, centred on the crop, a half-disc
 *  of ARM_RADIUS at the top and the bottom (each read at the row's centre)
 *  and the crop's full width between. */
function capsuleRuns(box: typeof ARM_R_BOX): number[][] {
  const mid = box.x + box.w / 2;
  return Array.from({ length: box.h }, (_, k) => {
    const dy = Math.max(
      0,
      ARM_RADIUS - (k + 0.5),
      k + 0.5 - (box.h - ARM_RADIUS),
    );
    const half = Math.round(Math.sqrt(ARM_RADIUS ** 2 - dy ** 2));
    return [mid - half, mid + half];
  });
}

/**
 * The full body. With `arms`, it also carries `arm_L` and `arm_R`, capsules
 * hanging beside the torso, and with `poses` (which needs `arms`), the
 * `forearm_pose_L` and `forearm_pose_R` capsules. Off by default: the body's own cases read the
 * figure without them.
 */
export function fullBody({
  extend = 1600,
  arms = false,
  poses = false,
}: { extend?: number; arms?: boolean; poses?: boolean } = {}): {
  layers: LayerInput[];
  options: GenerateOptions;
  canvas: { width: number; height: number };
} {
  const canvas = { width: CANVAS.width, height: CANVAS.height + extend };
  const bust = character();
  const head = bust.layers
    .filter((l) => l.role !== "body")
    .map((l) => ({ ...l, canvasW: canvas.width, canvasH: canvas.height }));
  const body: LayerInput = {
    role: "body",
    fileName: "body.png",
    canvasW: canvas.width,
    canvasH: canvas.height,
    bbox: { ...BODY_BOX },
    cropW: BODY_BOX.w,
    cropH: BODY_BOX.h,
    rowRuns: Array.from({ length: BODY_BOX.h }, (_, k) =>
      BODY_BOX.y + k < CROTCH_ROW ? [...TORSO_RUNS] : [...LEG_RUNS],
    ),
  };
  const arm = (role: string, box: typeof ARM_R_BOX): LayerInput => ({
    role,
    fileName: `${role}.png`,
    canvasW: canvas.width,
    canvasH: canvas.height,
    bbox: { ...box },
    cropW: box.w,
    cropH: box.h,
    rowRuns: capsuleRuns(box),
  });
  const limbs = arms ? [arm("arm_L", ARM_L_BOX), arm("arm_R", ARM_R_BOX)] : [];
  const raised = poses
    ? [arm("forearm_pose_L", POSE_L_BOX), arm("forearm_pose_R", POSE_R_BOX)]
    : [];
  // Model y is centred on the canvas (`layout.ts`), so a box that keeps its
  // canvas rows moves up by half the extension.
  const { left, right } = bust.options.strandEdges!;
  const options: GenerateOptions = {
    ...bust.options,
    strandEdges: {
      left: { ...left!, y: left!.y + extend / 2 },
      right: { ...right!, y: right!.y + extend / 2 },
    },
  };
  return { layers: [body, ...limbs, ...head, ...raised], options, canvas };
}
