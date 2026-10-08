/**
 * The measure's arm checks. An arm hangs from the body's shoulder, and raising
 * it turns its shoulder cap about the rig's shoulder pivot, so the torso has
 * to reach under that cap or a gap opens beside the shoulder. The pivot is
 * the rig's own: `armGeometry`, run on the layer as `auto_rig_from_layers`
 * runs it, so the cap measured here is the one the rig turns.
 */

import path from "node:path";
import {
  LayerGeometryError,
  armGeometry,
  createLayerSetMeasurer,
  type ArmGeometry,
  type LayerInput,
  type LayerSetMeasurer,
} from "@ikijs/editor";
import type { LayerStats } from "./measure";
import { decodePng } from "./node-images";

/** The arm roles, screen right (`arm_L`) then screen left (`arm_R`). */
export const ARM_ROLES = ["arm_L", "arm_R"] as const;

/** How far an arm's shoulder cap must reach under the torso's edge on the
 *  shoulder pivot's row, as a share of its radius r_u. Our own value: a
 *  raised arm turns its cap about the pivot, so a cap that barely meets the
 *  torso's edge swings clear of it and bares the gap beside the shoulder. */
export const CAP_OVERLAP = 0.5;

/** A px figure as the report prints it: pivots sit on half px. */
export const px = (v: number) => `${Number(v.toFixed(1))}`;

/** Decode a role's layer in `absDir` and measure it on `measurer`. */
export async function measured(
  measurer: LayerSetMeasurer,
  absDir: string,
  role: string,
): Promise<LayerInput> {
  const fileName = `${role}.png`;
  const { rgba } = await decodePng(path.join(absDir, fileName));
  // layerStats counts alpha > 8 and the measurer alpha >= 8, so a layer
  // measured non-empty is never empty here.
  return measurer.add({ role, fileName, rgba })!;
}

/**
 * Warn of an arm layer the rig refuses or would hang with a gap at the
 * shoulder: one without a body, one on another canvas than the body's, one
 * too short to place an elbow under its shoulder, and one whose shoulder cap
 * does not reach `CAP_OVERLAP` of its radius under the torso's edge.
 * `layers` holds the measured, non-empty layers of `absDir` by role.
 */
export async function armWarnings(
  absDir: string,
  layers: Record<string, LayerStats>,
): Promise<string[]> {
  const warnings: string[] = [];
  const body = layers.body;
  // Opened for the first arm that reaches the overlap, so the body decodes once.
  let set: { measurer: LayerSetMeasurer; body: LayerInput } | undefined;

  for (const arm of ARM_ROLES) {
    const stats = layers[arm];
    if (stats === undefined) continue;
    if (body === undefined) {
      warnings.push(
        `${arm}: no body layer — an arm hangs from the body's shoulder, and auto_rig_from_layers refuses it.`,
      );
      continue;
    }
    // One measurer reads every buffer at one size, and a buffer of another
    // shape but the same area would pass its length check and be read with
    // the wrong stride.
    if (stats.canvasW !== body.canvasW || stats.canvasH !== body.canvasH) {
      warnings.push(
        `${arm}: its canvas ${stats.canvasW}x${stats.canvasH} differs from body's ` +
          `${body.canvasW}x${body.canvasH} — auto_rig_from_layers refuses layers of different ` +
          `sizes; recompose them together.`,
      );
      continue;
    }
    if (set === undefined) {
      const measurer = createLayerSetMeasurer({
        width: body.canvasW,
        height: body.canvasH,
      });
      set = { measurer, body: await measured(measurer, absDir, "body") };
    }

    let g: ArmGeometry;
    try {
      // The body box's centre, model x: the axis the rig reads an arm's side
      // off.
      g = armGeometry(
        await measured(set.measurer, absDir, arm),
        set.body.bbox.x + set.body.bbox.w / 2 - body.canvasW / 2,
      );
    } catch (err) {
      if (err instanceof LayerGeometryError) {
        warnings.push(
          `${arm}: ${err.message} — auto_rig_from_layers refuses it. Regenerate arm.png drawn ` +
            `hanging, shoulder at the top. Billed.`,
        );
        continue;
      }
      throw err;
    }
    const cap = capWarning(arm, g, set.body);
    if (cap !== undefined) warnings.push(cap);
  }
  return warnings;
}

/**
 * The shoulder cap against the torso's edge on the arm's side, on the canvas
 * row holding the shoulder pivot: the cap reaches r_u past the pivot, so it
 * overlaps the torso by r_u less the pivot's distance outside that edge.
 */
function capWarning(
  arm: (typeof ARM_ROLES)[number],
  g: ArmGeometry,
  body: LayerInput,
): string | undefined {
  // Model space is centred on the canvas, y up.
  const pivotX = g.shoulder.x + body.canvasW / 2;
  const row = Math.floor(body.canvasH / 2 - g.shoulder.y);
  const runs = body.rowRuns?.[row - body.bbox.y] ?? [];
  if (runs.length === 0) {
    return (
      `${arm}: the body has no paint on its shoulder pivot's row (y=${row}) — the torso shows a ` +
      `gap beside the shoulder once the arm raises. Retune layout.${arm}.cy onto the shoulder (free).`
    );
  }
  // The outermost run's end on the arm's side; a run's end column is exclusive.
  const edge = g.side === 1 ? runs[runs.length - 1] : runs[0];
  const overlap = g.shoulderRadius - g.side * (pivotX - edge);
  const need = CAP_OVERLAP * g.shoulderRadius;
  if (overlap >= need) return undefined;
  return (
    `${arm}: its shoulder cap reaches ${px(overlap)} px under the torso's edge on its pivot row ` +
    `(y=${row}), under half its radius (${px(need)} px) — a gap opens beside the shoulder once ` +
    `the arm raises. Move layout.${arm}.cx ${Math.ceil(need - overlap)} px toward the body (free).`
  );
}
