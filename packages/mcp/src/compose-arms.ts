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
 */

import sharp from "sharp";
import {
  LayerGeometryError,
  armGeometry,
  createLayerSetMeasurer,
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
): Promise<{ left: number; top: number }> {
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
  let shoulder: { x: number; y: number };
  try {
    // Only the shoulder is read. The axis keeps `side` the role's own all
    // the same: arm_R on the screen left, arm_L on the right.
    ({ shoulder } = armGeometry(
      layer,
      role === "arm_R" ? Infinity : -Infinity,
    ));
  } catch (err) {
    if (err instanceof LayerGeometryError) {
      throw new AutoRigInputError(`layout.${role}: ${err.message}`);
    }
    throw err;
  }
  // Model space is centred on the measured canvas, here the part itself.
  const pivotX = shoulder.x + part.w / 2;
  const pivotY = part.h / 2 - shoulder.y;
  const cornerX = role === "arm_R" ? body.left : body.left + body.w;
  const cornerY = body.top + SHOULDER_DROP * body.h;
  return {
    left: Math.round(
      cfg.cx === undefined ? cornerX - pivotX : cfg.cx - part.w / 2,
    ),
    top: Math.round(
      cfg.cy === undefined ? cornerY - pivotY : cfg.cy - part.h / 2,
    ),
  };
}
