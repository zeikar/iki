/**
 * Where the composer hangs an arm. One arm.png is the arm on the screen LEFT:
 * `arm_R` takes it as drawn and `arm_L` mirrored. Each of an arm's `cx` / `cy`
 * that the layout leaves unset is derived from the placed body's box: the
 * arm's shoulder pivot lands on the box's shoulder corner on that axis — the
 * box's left edge for `arm_R`, its right edge for `arm_L`, SHOULDER_DROP of
 * its height under its top. On a torso widest at its shoulders, the cap's
 * centre then sits on the torso's edge, overlapping it by the cap's radius.
 * A body whose row there is its neck (a long neck, as the skill draws it)
 * has its shoulders read off its paint instead (`shoulderLine`): the corner
 * then lies the cap's radius under the shoulders' first row, the cap's top
 * on the shoulder line.
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
  type LayerInput,
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
/** The share of the body box's height, from its top, its shoulders are
 *  sought in: above the band the rig looks for the hips in. Our own value. */
export const UPPER_BODY = 0.35;
/** A plateau, a run of rows the width barely changes over, is at least this
 *  share of the body's rows long. Our own value. */
export const PLATEAU_ROWS = 0.02;
/** Within a plateau every row is within this share of its first row's width.
 *  Our own value: a drawn outline's jitter stays well under it, a skirt's
 *  or a cloak's steady flare leaves it within a few rows. */
export const PLATEAU_TOL = 0.03;
/** A plateau the shoulders can be is reached by a step: over the PLATEAU_ROWS
 *  of rows above it the width rose at least this share of its own (the
 *  shoulders' corners). A flare's tail, flattening out within the band, is
 *  reached by a drift instead. Our own value: twice PLATEAU_TOL. */
export const PLATEAU_STEP = 0.06;
/** A row at least this share of the shoulders' widest is on the shoulders.
 *  Our own value. */
export const SHOULDER_SPAN = 0.9;
/** A row above the shoulders under this share of their span is the neck (or
 *  a collar), not the shoulder. Our own value: a drawn neck is well under
 *  half the shoulders' width, a sloping shoulder's upper rows well over. */
export const NECK_SPAN = 0.6;

/** The body's shoulders as its paint has them, in its layer's crop rows
 *  (`rowRuns`, from `bbox.y`). */
export interface ShoulderLine {
  /** The shoulders' first crop row: the first at SHOULDER_SPAN of `span`. */
  row: number;
  /** The shoulders' widest row, px. */
  span: number;
  /** Each crop row's outermost paint, px (0 for a row with none). */
  widths: number[];
}

/**
 * The shoulders of a body layer, each row's width its outermost paint: the
 * first plateau of rows (PLATEAU_ROWS long, within PLATEAU_TOL) inside
 * UPPER_BODY of its rows, reached by a step (PLATEAU_STEP), that is not a
 * neck, and the first row at
 * SHOULDER_SPAN of its width. A plateau is a neck when a row under it inside
 * that band is wider than it by more than 1 / NECK_SPAN: a torso under a neck,
 * or a skirt flaring out under the shoulders. Bounding the span to a plateau,
 * not the widest row of the band, keeps a flare that never narrows (an A-line
 * dress, a cloak, a poncho) from being read as the shoulders. On the corpus's
 * full bodies an accepted arm's top lies within about 1.5 % of the body's
 * height of it. null for a layer without `rowRuns` or without paint there,
 * and for a silhouette without such a plateau (one widening all the way down
 * the band): the caller keeps SHOULDER_DROP's row then.
 */
export function shoulderLine(body: LayerInput): ShoulderLine | null {
  const runs = body.rowRuns;
  if (runs === undefined) return null;
  const widths = runs.map((r) => (r.length === 0 ? 0 : r[r.length - 1] - r[0]));
  const upper = Math.min(
    widths.length,
    Math.max(1, Math.ceil(UPPER_BODY * widths.length)),
  );
  const long = Math.max(2, Math.round(PLATEAU_ROWS * widths.length));
  for (let s = 0; s < upper; ) {
    const w0 = widths[s];
    let end = s + 1;
    while (
      end < upper &&
      w0 > 0 &&
      Math.abs(widths[end] - w0) <= PLATEAU_TOL * w0
    )
      end++;
    if (w0 === 0 || end - s < long) {
      s++;
      continue;
    }
    if (s >= long && widths[s] - widths[s - long] < PLATEAU_STEP * w0) {
      s = end; // reached by a drift: a flare flattening out, not the shoulders
      continue;
    }
    let span = 0;
    for (let k = s; k < end; k++) span = Math.max(span, widths[k]);
    let below = 0;
    for (let k = end; k < upper; k++) below = Math.max(below, widths[k]);
    if (below * NECK_SPAN > span) {
      s = end; // a neck (or shoulders over a flare): the shoulders are further down, if anywhere
      continue;
    }
    const row = widths.findIndex((w) => w >= SHOULDER_SPAN * span);
    return { row, span, widths };
  }
  return null;
}

/**
 * Whether a body's crop row is its neck: above its shoulder line and under
 * NECK_SPAN of its span.
 */
export const onNeck = (line: ShoulderLine, row: number): boolean =>
  row >= 0 && row < line.row && line.widths[row] < NECK_SPAN * line.span;

/** A body layer's shoulders (`shoulderLine`) and the canvas row its crop
 *  starts on, from the placed body's PNG. */
async function bodyShoulders(
  body: PlacedBox,
): Promise<{ line: ShoulderLine; y0: number } | null> {
  const { data } = await sharp(body.buf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const layer = createLayerSetMeasurer({ width: body.w, height: body.h }).add({
    role: "body",
    fileName: "body.png",
    rgba: data,
  });
  const line = layer === null ? null : shoulderLine(layer);
  return layer === null || line === null
    ? null
    : { line, y0: body.top + layer.bbox.y };
}

/**
 * The row an arm's shoulder pivot hangs on by default, canvas px:
 * SHOULDER_DROP of the body box's height under its top, unless that row is
 * the neck (`onNeck`); then `radius` (the cap's, r_u) under the shoulders'
 * first row, so the cap's top lies on the shoulder line.
 */
async function shoulderY(body: PlacedBox, radius: number): Promise<number> {
  const fraction = body.top + SHOULDER_DROP * body.h;
  const shoulders = await bodyShoulders(body);
  if (shoulders === null) return fraction;
  const { line, y0 } = shoulders;
  return onNeck(line, Math.floor(fraction) - y0)
    ? y0 + line.row + radius
    : fraction;
}

/** A placed part's box on the canvas, px, and its PNG. */
interface PlacedBox {
  left: number;
  top: number;
  w: number;
  h: number;
  buf: Buffer;
}

/**
 * Where an arm's resized part lands: by its rig shoulder pivot on the body
 * box's shoulder corner (`shoulderY`) for each of `cx` / `cy` left unset,
 * centred on a set one as every other role's part is. An arm the rig would
 * refuse as too short is refused here, path-qualified.
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
  const cornerY = await shoulderY(body, g.shoulderRadius);
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
