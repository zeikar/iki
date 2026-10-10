/**
 * The measure's lip set checks. The rig folds the mouth open off the layers'
 * own alpha edges, per canvas column inside the opening (where `mouth_inner`
 * has a run): the interior's top must reach the line above it and the skin must
 * reach the interior, or a gap shows the face between them at rest. The
 * geometry is the rig's own: `mouthOpening`, run on the three layers as
 * `auto_rig_from_layers` runs it. The composer meets that contract by
 * construction; these checks are for a set it did not cut (hand-prepared
 * layers, a re-cut) and for the drawings the contract cannot save: a mouth too
 * small to fold, a line too thin to close on, green the key left, an interior
 * with holes. The lip layers' straight edges are the split's cuts, and so are
 * the inside layers' (`mouth_tongue`, `mouth_teeth`), so the generic edge and
 * flat-cut checks skip them all (`isLipLayerRole`). Of an inside layer the rig reads
 * only its box, so it is checked for the set it needs, its canvas and its box.
 */

import path from "node:path";
import {
  ALPHA_OPAQUE,
  LIP_INSIDE_ROLES,
  LIP_ROLES,
  LayerGeometryError,
  columnRuns,
  createLayerSetMeasurer,
  isLipInsideRole,
  mouthOpening,
  type LayerInput,
  type LipInsideRole,
  type LipRole,
  type Opening,
} from "@ikijs/editor";
import type { LayerStats } from "./measure";
import { MIN_OPENING_WIDTH } from "./compose-lips";
import { decodePng } from "./node-images";

/** A lip set's layer: one of its three, or an inside layer. */
export const isLipLayerRole = (role: string): role is LipRole | LipInsideRole =>
  (LIP_ROLES as readonly string[]).includes(role) || isLipInsideRole(role);

/** The opening's height at its centre, rows, under which it is too small to
 *  fold. Our own value, provisional. */
const MIN_OPENING_ROWS = 8;
/** The line's height at the centre, rows, under which a closed mouth has no
 *  line to close on (a hairline folds to nothing). Our own value, provisional. */
const MIN_LINE_ROWS = 2;
/** Green excess `g - max(r, b)` above which an opaque lip pixel is key green
 *  left over rather than art. Our own value, provisional. */
const GREEN_EXCESS = 40;
/** The share of the opening's area that may be transparent inside
 *  `mouth_inner`'s own span before the face shows through it. Our own value,
 *  provisional. */
const INTERIOR_GAP_FRACTION = 0.05;

/** What the report says of the opening, for judging a half-open mouth. */
export interface LipFacts {
  opening: { width: number; height: number; line: number };
  /** `MouthOpen` below which the slit has not opened: `v* = w' / (H + w')`. */
  deadZone: number;
}

/** A list of columns as the warning names it: the count and the first. */
const columns = (cols: number[]) =>
  `${cols.length} column${cols.length === 1 ? "" : "s"} (first at x=${cols[0]})`;

/**
 * Warn of a lip set the rig refuses or would fold badly, and report the
 * opening it reads. `layers` holds the measured, non-empty layers of `absDir`
 * by role; a set with no lip layer is a legacy mouth and says nothing.
 */
export async function lipWarnings(
  absDir: string,
  layers: Record<string, LayerStats>,
): Promise<{ warnings: string[]; lips?: LipFacts }> {
  const warnings: string[] = [];
  const present = LIP_ROLES.filter((role) => layers[role] !== undefined);
  const inside = LIP_INSIDE_ROLES.filter((role) => layers[role] !== undefined);
  if (present.length === 0) {
    if (inside.length > 0) {
      warnings.push(
        `${inside.join("/")}: a lip set's inside layer with no lip set — auto_rig_from_layers refuses ` +
          `it (it is cut from the interior and clipped to it). Recompose from mouth_keyed.png + ` +
          `mouth_interior.png, or remove it.`,
      );
    }
    return { warnings };
  }

  const legacy = ["mouth", "mouth_open"].filter(
    (role) => layers[role] !== undefined,
  );
  if (legacy.length > 0) {
    warnings.push(
      `${present.join("/")}: the lip set cannot be mixed with ${legacy.join("/")} — auto_rig_from_layers ` +
        `refuses it. Remove one route: compose again with only mouth_keyed.png + mouth_interior.png, ` +
        `or without them.`,
    );
  }
  if (present.length < LIP_ROLES.length) {
    const missing = LIP_ROLES.filter((role) => layers[role] === undefined);
    warnings.push(
      `${present.join("/")}: partial lip set, missing ${missing.join("/")} — auto_rig_from_layers ` +
        `refuses it. Compose mouth_keyed.png + mouth_interior.png together, which cuts all three.`,
    );
    return { warnings };
  }

  const { mouth_inner: inner, lip_upper: upper } = layers;
  for (const role of ["lip_lower", "lip_upper", ...inside]) {
    const stats = layers[role];
    if (stats.canvasW !== inner.canvasW || stats.canvasH !== inner.canvasH) {
      warnings.push(
        `${role}: its canvas ${stats.canvasW}x${stats.canvasH} differs from mouth_inner's ` +
          `${inner.canvasW}x${inner.canvasH} — auto_rig_from_layers refuses layers of different ` +
          `sizes; recompose them together.`,
      );
      return { warnings };
    }
  }
  // Of an inside layer the rig reads only its box, and the cavity clips
  // whatever leaves its own: the measured alpha > 8 box (`bboxCx ± w/2`), in
  // pixel edges.
  const box = (m: LayerStats) => ({
    x0: m.bboxCx - m.w / 2,
    x1: m.bboxCx + m.w / 2,
    y0: m.bboxCy - m.h / 2,
    y1: m.bboxCy + m.h / 2,
  });
  const cavity = box(inner);
  for (const role of inside) {
    const b = box(layers[role]);
    if (
      b.x0 < cavity.x0 ||
      b.x1 > cavity.x1 ||
      b.y0 < cavity.y0 ||
      b.y1 > cavity.y1
    ) {
      warnings.push(
        `${role}: its box leaves mouth_inner's — the cavity clips it away there. Recompose from ` +
          `mouth_keyed.png + mouth_interior.png (free).`,
      );
    }
  }

  const measurer = createLayerSetMeasurer({
    width: inner.canvasW,
    height: inner.canvasH,
  });
  const set = new Map<string, LayerInput>();
  const green: string[] = [];
  for (const role of LIP_ROLES) {
    const fileName = `${role}.png`;
    const { rgba } = await decodePng(path.join(absDir, fileName));
    // Decoded here rather than through `measured`: the green scan below needs
    // the pixels. layerStats counts alpha > 8 and the measurer alpha >= 8, so
    // a layer measured non-empty is never empty here.
    set.set(role, measurer.add({ role, fileName, rgba })!);
    for (let i = 0; i < rgba.length; i += 4) {
      if (
        rgba[i + 3] >= ALPHA_OPAQUE &&
        rgba[i + 1] - Math.max(rgba[i], rgba[i + 2]) > GREEN_EXCESS
      ) {
        green.push(role);
        break;
      }
    }
  }
  let opening: Opening;
  try {
    opening = mouthOpening(set);
  } catch (err) {
    if (err instanceof LayerGeometryError) {
      warnings.push(err.message);
      return { warnings };
    }
    throw err;
  }

  const innerRuns = columnRuns(set.get("mouth_inner")!);
  const noInterior: number[] = [];
  const gap: number[] = [];
  const noLine: number[] = [];
  const skinGap: number[] = [];
  let area = 0;
  let hollow = 0;
  for (let x = opening.x0; x <= opening.x1; x++) {
    const runs = innerRuns.get(x);
    if (runs === undefined) {
      noInterior.push(x);
      continue;
    }
    const span = runs[runs.length - 1][1] - runs[0][0];
    area += span;
    hollow += span - runs.reduce((n, r) => n + r[1] - r[0], 0);
    const c = opening.at(x);
    if (c.lineH <= 0) noLine.push(x);
    else if (c.Tu > c.T) gap.push(x);
    if (c.Bl < c.Bb) skinGap.push(x);
  }
  // The composer always cuts to the contract, so these come from a set it did
  // not cut: recomposing from the two sources is the free fix.
  const recompose = (file: string, ask: string) =>
    `Recompose from mouth_keyed.png + mouth_interior.png (free); if it persists, regenerate ${file} ${ask}. Billed.`;
  const regenKeyed = recompose(
    "mouth_keyed.png",
    "with a closed outline and solid lips under it",
  );
  if (noInterior.length > 0) {
    warnings.push(
      `mouth_inner: no interior in ${columns(noInterior)} of the opening — the fold has nothing to scale there. ${recompose("mouth_interior.png", "as one solid cavity")}`,
    );
  }
  if (gap.length > 0) {
    warnings.push(
      `lip_upper: a gap between the line and the interior in ${columns(gap)} — the face shows through it ` +
        `at rest (the interior's top must reach the line's ink). ${regenKeyed}`,
    );
  }
  if (noLine.length > 0) {
    warnings.push(
      `lip_upper: no line above the interior in ${columns(noLine)} — nothing closes the mouth there. ${regenKeyed}`,
    );
  }
  if (skinGap.length > 0) {
    warnings.push(
      `lip_lower: a gap between the interior and the skin in ${columns(skinGap)} — the face shows through ` +
        `it once the mouth opens (the skin must reach the interior's bottom). ${regenKeyed}`,
    );
  }

  const width = opening.x1 - opening.x0 + 1;
  const centre = opening.at(opening.centre);
  if (width < MIN_OPENING_WIDTH * upper.w) {
    warnings.push(
      `mouth_inner: the opening is ${width} px wide, ${Math.round((100 * width) / upper.w)}% of lip_upper's ${upper.w} px ` +
        `(under ${Math.round(100 * MIN_OPENING_WIDTH)}%) — too narrow to fold; the slit stays a hairline. ` +
        `Regenerate mouth_keyed.png with the mouth open wider. Billed.`,
    );
  }
  if (centre.H < MIN_OPENING_ROWS) {
    // measure_layers sees only the layers, so a set layout.mouth_inner.h is
    // named in the message; a w past the canvas is not suggested at all.
    const w = Math.ceil((upper.w * MIN_OPENING_ROWS) / centre.H);
    const retune = w <= inner.canvasW ? w : null;
    warnings.push(
      `mouth_inner: the opening is ${centre.H} px tall at its centre (under ${MIN_OPENING_ROWS}) — too small to fold; ` +
        `the slit stays shut until MouthOpen is nearly 1. ` +
        (retune === null
          ? ""
          : `If the mouth is smaller than the reference's, set layout.mouth_inner.w to ${retune} ` +
            `(free; the whole set scales with it, so scale layout.mouth_inner.h too if it is set). Otherwise `) +
        `${retune === null ? "R" : "r"}egenerate mouth_keyed.png with the mouth open taller. Billed.`,
    );
  }
  if (opening.w < MIN_LINE_ROWS) {
    warnings.push(
      `lip_upper: the upper line is ${opening.w} px at the opening's centre (under ${MIN_LINE_ROWS}) — a hairline ` +
        `closes to nothing. Regenerate mouth_keyed.png ` +
        `with a bolder upper line, never thinner than the reference's mouth line. Billed.`,
    );
  }
  if (green.length > 0) {
    warnings.push(
      `${green.join("/")}: opaque green left (key green, g exceeds r and b by over ${GREEN_EXCESS}) — it shows as a ` +
        `green fringe on the lips. Regenerate mouth_keyed.png with the green only inside the opening, or ` +
        `mouth_interior.png without green in it. Billed.`,
    );
  }
  if (area > 0 && hollow > INTERIOR_GAP_FRACTION * area) {
    warnings.push(
      `mouth_inner: ${Math.round((100 * hollow) / area)}% of the opening is transparent inside the interior's ` +
        `own span (over ${Math.round(100 * INTERIOR_GAP_FRACTION)}%) — the face shows through it. ` +
        `Regenerate mouth_interior.png as one solid cavity. Billed.`,
    );
  }

  return {
    warnings,
    lips: {
      opening: { width, height: centre.H, line: opening.w },
      deadZone: centre.overlap / (centre.H + centre.overlap),
    },
  };
}
