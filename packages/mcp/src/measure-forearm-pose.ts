/**
 * The measure's pose forearm checks. A pose forearm hangs from its arm's
 * elbow and is swapped in for the hanging forearm, so it has to meet the arm
 * where the rig turns it: the rig puts its pivot on the arm's elbow and
 * `forearm_pose.png` is composed so that its elbow end lands there, at the
 * arm's elbow width. The geometry is the rig's own: `armGeometry` on the arm
 * and `forearmPoseGeometry` on the pose forearm, run on one measurer as
 * `auto_rig_from_layers` runs them. A pose forearm too far off in any of
 * pivot, width or length shows a broken joint once the switch is on; the
 * canvas-edge check is the generic one in `measureDir`.
 */

import {
  LayerGeometryError,
  armGeometry,
  createLayerSetMeasurer,
  forearmPoseGeometry,
  type ArmGeometry,
  type ForearmPoseGeometry,
  type LayerInput,
  type LayerSetMeasurer,
} from "@ikijs/editor";
import type { LayerStats } from "./measure";
import { measured, px } from "./measure-arms";

/** The pose forearm roles, each with the arm it hangs from. */
export const POSE_ROLES = ["forearm_pose_L", "forearm_pose_R"] as const;
const ARM_OF: Record<(typeof POSE_ROLES)[number], "arm_L" | "arm_R"> = {
  forearm_pose_L: "arm_L",
  forearm_pose_R: "arm_R",
};

/** How far off the arm's elbow the pose forearm's pivot may be, px. Our own
 *  value: the composer pins it to within a pixel, so more is a layout `cx` /
 *  `cy` that moved it. */
export const POSE_PIVOT_TOLERANCE = 2;
/** How far the pose forearm's elbow end may differ from the arm's elbow run,
 *  as a share of the run. Our own value: past it the joint shows a step in
 *  the sleeve. */
export const POSE_WIDTH_TOLERANCE = 0.1;
/** How far the pose forearm's length (pivot to its top painted row) may
 *  differ from the hanging arm's (elbow to its last painted row), as a
 *  share of it. Our own value, looser than the width's: a raised hand is
 *  not a hanging one, but one twice as long is another arm. */
export const POSE_LENGTH_TOLERANCE = 0.15;

/** Model y of the last painted row of a layer, y up. */
function bottomRowY(layer: LayerInput): number {
  const painted =
    layer.rowRuns?.flatMap((runs, k) => (runs.length > 0 ? [k] : [])) ?? [];
  const k = painted.at(-1) ?? layer.bbox.h - 1;
  return layer.canvasH / 2 - (layer.bbox.y + k + 0.5);
}

/**
 * Warn of a pose forearm the rig refuses or would hang off its arm's elbow:
 * one without its arm, one on another canvas than its arm's, and one whose
 * pivot, elbow-end width or length is off the arm's. Each names its free
 * retune (`layout.forearm_pose_*`) or, where only a new drawing helps, the
 * regeneration. `layers` holds the measured, non-empty layers of `absDir` by
 * role.
 */
export async function forearmPoseWarnings(
  absDir: string,
  layers: Record<string, LayerStats>,
): Promise<string[]> {
  const warnings: string[] = [];
  for (const pose of POSE_ROLES) {
    const stats = layers[pose];
    if (stats === undefined) continue;
    const arm = ARM_OF[pose];
    const armStats = layers[arm];
    if (armStats === undefined) {
      warnings.push(
        `${pose}: no ${arm} layer — a pose forearm hangs from its arm's elbow, and auto_rig_from_layers refuses it.`,
      );
      continue;
    }
    if (
      stats.canvasW !== armStats.canvasW ||
      stats.canvasH !== armStats.canvasH
    ) {
      warnings.push(
        `${pose}: its canvas ${stats.canvasW}x${stats.canvasH} differs from ${arm}'s ` +
          `${armStats.canvasW}x${armStats.canvasH} — auto_rig_from_layers refuses layers of different ` +
          `sizes; recompose them together.`,
      );
      continue;
    }
    // Without a body the arm is already warned of (armWarnings).
    if (layers.body === undefined) continue;

    const measurer: LayerSetMeasurer = createLayerSetMeasurer({
      width: stats.canvasW,
      height: stats.canvasH,
    });
    let a: ArmGeometry;
    let armLayer: LayerInput;
    try {
      armLayer = await measured(measurer, absDir, arm);
      // Only the elbow and the seam run are read, none of which depends on
      // the side, so the body is not decoded: the axis is the role's own, as
      // the composer passes it.
      a = armGeometry(armLayer, arm === "arm_R" ? Infinity : -Infinity);
    } catch (err) {
      // The arm's own warning says it.
      if (err instanceof LayerGeometryError) continue;
      throw err;
    }
    const b = forearmPoseGeometry(await measured(measurer, absDir, pose));
    warnings.push(...jointWarnings(pose, arm, stats, a, armLayer, b));
  }
  return warnings;
}

function jointWarnings(
  pose: (typeof POSE_ROLES)[number],
  arm: string,
  stats: LayerStats,
  a: ArmGeometry,
  armLayer: LayerInput,
  b: ForearmPoseGeometry,
): string[] {
  const warnings: string[] = [];
  const key = `layout.${pose}`;

  // Pivot: model x grows right, y up; the layout's cy grows down. A layout
  // centre is the box's: the bbox's pixel centre (bboxCx) plus half a pixel.
  const dx = a.elbow.x - b.pivot.x;
  const dy = a.elbow.y - b.pivot.y;
  const off = Math.hypot(dx, dy);
  if (off > POSE_PIVOT_TOLERANCE) {
    warnings.push(
      `${pose}: its elbow end is ${px(off)} px off ${arm}'s elbow — the raised forearm detaches ` +
        `from the arm at the joint once it swaps in. Remove ${key}.cx/cy from the layout so it stays ` +
        `pinned on the elbow through later arm retunes (free), or set ${key}.cx to ` +
        `${Math.round(stats.bboxCx + 0.5 + dx)} and ${key}.cy to ${Math.round(stats.bboxCy + 0.5 - dy)} (free).`,
    );
  }

  // Width: B's elbow end against A's elbow run, by the w to set.
  const armRun = a.seamRun[1] - a.seamRun[0];
  const poseRun = 2 * b.radius;
  const widthRatio = poseRun / armRun;
  const widthBad = Math.abs(widthRatio - 1) > POSE_WIDTH_TOLERANCE;
  if (widthBad) {
    warnings.push(
      `${pose}: its elbow end is ${px(poseRun)} px wide, ${Math.round(Math.abs(widthRatio - 1) * 100)}% off ` +
        `${arm}'s elbow run (${px(armRun)} px) — the sleeve steps at the joint once it swaps in. ` +
        `Set ${key}.w to ${Math.round(stats.w / widthRatio)} (free).`,
    );
  }

  // Length: B from its pivot up to its hand, A from its elbow down to its
  // hand. A new w scales the width with it, so it only mends the length when
  // the width fits after.
  const armLen = a.elbow.y - bottomRowY(armLayer);
  const poseLen = b.top - b.pivot.y;
  const lengthRatio = poseLen / armLen;
  if (Math.abs(lengthRatio - 1) > POSE_LENGTH_TOLERANCE) {
    const fix = 1 / lengthRatio;
    const freeFix = Math.abs(widthRatio * fix - 1) <= POSE_WIDTH_TOLERANCE;
    warnings.push(
      `${pose}: its length from the elbow end to the hand is ${px(poseLen)} px against ${arm}'s ` +
        `${px(armLen)} px from its elbow to its hand — ` +
        (freeFix
          ? `the raised hand reaches the wrong height. Set ${key}.w to ${Math.round(stats.w * fix)} (free)` +
            (widthBad ? `, which fixes the width too.` : `.`)
          : `the raised hand reaches the wrong height, and no single w fits both its length and its width. ` +
            `Regenerate forearm_pose.png with the forearm and hand as long as the hanging arm's below its elbow. Billed.`),
    );
  }
  return warnings;
}
