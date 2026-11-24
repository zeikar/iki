/**
 * Where the composer hangs an arm. One arm.png is the arm on the screen LEFT:
 * `arm_R` takes it as drawn and `arm_L` mirrored. Each of an arm's `cx` / `cy`
 * that the layout leaves unset is derived from the placed body's box: the
 * arm's shoulder pivot lands on the box's shoulder corner on that axis — the
 * box's left edge for `arm_R`, its right edge for `arm_L`, SHOULDER_DROP of
 * its height under its top. On a torso widest at its shoulders, the cap's
 * centre then sits on the torso's edge, overlapping it by the cap's radius.
 * An unset `w` is ARM_WIDTH of the body's width.
 *
 * The pivot is the rig's own: `armGeometry`, run on the resized part as
 * `auto_rig_from_layers` runs it on the composed layer, so the rig turns the
 * composed arm about the target to the pixel, with no second copy of its
 * shoulder rule here to keep in step.
 *
 * A pose forearm (`forearm_pose.png`: the screen-left forearm raised,
 * `forearm_pose_R` as drawn and `forearm_pose_L` mirrored) hangs from its
 * arm's elbow, so the composer puts its elbow end where the rig turns it. An
 * unset `w` scales it so its elbow-end width (2 r_e, measured on the trimmed
 * source) equals the placed arm's seam run, and an unset `cx` or `cy` pins
 * its elbow-end pivot (`forearmPoseGeometry`, measured on the resized part as
 * the shoulder is) on the arm's placed elbow. Both read the rig's geometry,
 * none of it copied here.
 */

import sharp from "sharp";
import {
  LayerGeometryError,
  armGeometry,
  createLayerSetMeasurer,
  forearmPoseGeometry,
  type ArmGeometry,
  type ForearmPoseGeometry,
} from "@ikijs/editor";
import type { ArmLayout } from "./compose";
import { AutoRigInputError } from "./limits";

/** An arm's default width, as a share of the placed body's width. Our own
 *  value, provisional: to be picked by eye on the first full-body character. */
export const ARM_WIDTH = 0.4;
/** How far under the body box's top its shoulder corners lie, as a share of
 *  its height. Our own value, provisional: to be picked by eye on the first
 *  full-body character. */
export const SHOULDER_DROP = 0.12;

/** A placed part's box on the canvas, px. */
interface PlacedBox {
  left: number;
  top: number;
  w: number;
  h: number;
}

/**
 * Where an arm's resized part lands: by its rig shoulder pivot on the body
 * box's shoulder corner for each of `cx` / `cy` left unset, centred on a set
 * one as every other role's part is. An arm the rig would refuse as too short
 * is refused here, path-qualified.
 */
export async function armPlacement(
  role: "arm_L" | "arm_R",
  cfg: Pick<ArmLayout, "cx" | "cy">,
  part: { buf: Buffer; w: number; h: number },
  body: PlacedBox,
): Promise<{
  left: number;
  top: number;
  /** The rig's elbow pivot on the canvas, px. */
  elbow: { x: number; y: number };
  /** The elbow seam's widest run, px: what a pose forearm's elbow end fits. */
  elbowRun: number;
}> {
  const { data } = await sharp(part.buf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const layer = createLayerSetMeasurer({ width: part.w, height: part.h }).add({
    role,
    fileName: "arm.png",
    rgba: data,
  });
  if (layer === null) {
    throw new AutoRigInputError(
      `layout.${role}: arm.png is empty after alpha threshold once resized`,
    );
  }
  let g: ArmGeometry;
  try {
    // The axis keeps `side` the role's own all the same: arm_R on the screen
    // left, arm_L on the right.
    g = armGeometry(layer, role === "arm_R" ? Infinity : -Infinity);
  } catch (err) {
    if (err instanceof LayerGeometryError) {
      throw new AutoRigInputError(`layout.${role}: ${err.message}`);
    }
    throw err;
  }
  // Model space is centred on the measured canvas, here the part itself.
  const pivotX = g.shoulder.x + part.w / 2;
  const pivotY = part.h / 2 - g.shoulder.y;
  const cornerX = role === "arm_R" ? body.left : body.left + body.w;
  const cornerY = body.top + SHOULDER_DROP * body.h;
  const left = Math.round(
    cfg.cx === undefined ? cornerX - pivotX : cfg.cx - part.w / 2,
  );
  const top = Math.round(
    cfg.cy === undefined ? cornerY - pivotY : cfg.cy - part.h / 2,
  );
  return {
    left,
    top,
    elbow: {
      x: left + g.elbow.x + part.w / 2,
      y: top + part.h / 2 - g.elbow.y,
    },
    elbowRun: g.seamRun[1] - g.seamRun[0],
  };
}

type PoseRole = "forearm_pose_L" | "forearm_pose_R";

/** A pose forearm's geometry on a PNG of the given size, read as the rig
 *  reads a layer; an empty one is refused path-qualified. */
async function poseGeometryOf(
  role: PoseRole,
  png: Buffer,
  size: { w: number; h: number },
  when: string,
): Promise<ForearmPoseGeometry> {
  const { data } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const layer = createLayerSetMeasurer({
    width: size.w,
    height: size.h,
  }).add({ role, fileName: "forearm_pose.png", rgba: data });
  if (layer === null) {
    throw new AutoRigInputError(
      `layout.${role}: forearm_pose.png is empty after alpha threshold${when}`,
    );
  }
  return forearmPoseGeometry(layer);
}

/**
 * The width that fits a pose forearm to its arm: the trimmed source scaled
 * so its elbow end's width (2 r_e) equals the arm's elbow run, at least 1.
 */
export async function forearmPoseWidth(
  role: PoseRole,
  trimmed: { data: Buffer; w: number; h: number },
  elbowRun: number,
): Promise<number> {
  const g = await poseGeometryOf(role, trimmed.data, trimmed, "");
  return Math.max(1, Math.round((trimmed.w * elbowRun) / (2 * g.radius)));
}

/**
 * Where a pose forearm's resized part lands: its elbow-end pivot on the
 * arm's placed elbow for each of `cx` / `cy` left unset, centred on a set one
 * as every other role's part is.
 */
export async function forearmPosePlacement(
  role: PoseRole,
  cfg: Pick<ArmLayout, "cx" | "cy">,
  part: { buf: Buffer; w: number; h: number },
  elbow: { x: number; y: number },
): Promise<{ left: number; top: number }> {
  const { pivot } = await poseGeometryOf(role, part.buf, part, " once resized");
  // Model space is centred on the canvas, here the part itself.
  const pivotX = pivot.x + part.w / 2;
  const pivotY = part.h / 2 - pivot.y;
  return {
    left: Math.round(
      cfg.cx === undefined ? elbow.x - pivotX : cfg.cx - part.w / 2,
    ),
    top: Math.round(
      cfg.cy === undefined ? elbow.y - pivotY : cfg.cy - part.h / 2,
    ),
  };
}
