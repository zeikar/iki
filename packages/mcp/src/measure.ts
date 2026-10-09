/**
 * Measure composed Iki role layers and flag the failure modes that have
 * actually shipped broken characters. Read-only: it never edits anything.
 *
 * Ports the geometry checks that shipped as a script in the Claude Code plugin,
 * so a plugin user gets them from the MCP server instead of an ad-hoc `sharp`
 * install. They exist because "the eyes look too big" is not actionable but
 * "the iris is 33% of the sclera width, target 0.45-0.72" is. Every check below
 * is one that cost a real regeneration or re-tune round to find by eye.
 *
 * `sharp` must stay confined to @ikijs/mcp; the decode goes through
 * ./node-images, this package's single image-decode boundary.
 */

import fs from "node:fs";
import path from "node:path";
import { decodePng, detectAlphaBbox } from "./node-images";
import { AutoRigInputError, MAX_LAYERS, resolveInputDir } from "./limits";
import { ARM_ROLES, armWarnings } from "./measure-arms";
import { POSE_ROLES, forearmPoseWarnings } from "./measure-forearm-pose";
import { isLipRole, lipWarnings, type LipFacts } from "./measure-lips";
import { SPECK_CORE_FRACTION, denseCoreOf, isSpeckCore } from "./measure-turn";

// Iris width as a fraction of sclera width. Below the floor the eye reads as a
// bead floating in white — that is the failure this check was written for, and
// it caught a model that shipped at 0.33. The ceiling was a guess and it was
// too tight: measured on a real anime reference the iris runs about 0.70 of the
// eye, with the white reduced to corner crescents, so 0.6 flagged the correct
// value as a fault three rounds running.
const IRIS_RATIO_MIN = 0.45;
const IRIS_RATIO_MAX = 0.72;
// A sclera flatter than this cannot hold a round iris: the iris overflows the
// lids no matter how narrow it is.
const EYE_ASPECT_MIN = 0.5;
// How far the iris centre may sit from the white's centre of mass. The two axes
// are not the same problem. Sideways drift is always a fault — that is the bug
// this check was written for, a lash that fell out of sync with its sclera by
// 14px. Vertically the reference itself rides its iris HIGH, tucked under the
// lash with roughly a sixth of the aperture showing as white below it, so a
// deliberate lift of that order is correct and a 3px ceiling flagged it.
const IRIS_OFFSET_MAX_X = 3;
const IRIS_OFFSET_MAX_Y = 10;
// A cropped part shows a long, nearly-continuous opaque run along one bbox edge,
// and that straight seam appears the moment the head turns. A round part's edge
// row is a short tangent run, so a fraction test alone flags every iris; both a
// high fraction AND real length are required to separate the two. Observed:
// genuine crops read 60-93%, circle tangents 8-14%.
const EDGE_SOLID_MAX = 0.5;
/** Share of a lash's opaque pixels tolerated off its sclera. In sync there
 *  are none — the sclera was recoloured from those very pixels. A real eye
 *  measured 0 of 934 in sync, then 6-12 at a 1 px drift, 45-50 at 2 px and
 *  104-110 at 4 px, whichever way it drifted. */
const LASH_STRAY_TOL_FRAC = 0.02;
/** How much further short of the outer corner than of the nose side an eye's
 *  lash may stop, as a fraction of the eye width, before the eye reads as
 *  drawn facing the other way. Three real eyewhites drawn reversed stopped
 *  4.0-6.1% further short there; one drawn the right way stops short at the
 *  nose side instead, and one with a wing at each end at neither. */
const EYE_FACING_TOL_FRAC = 0.02;
const EDGE_RUN_MIN_PX = 40;
// Longest straight "art appears out of nothing" run tolerated inside a part, as
// a fraction of its width. A body generated with hair draped over the shoulders
// had that hair cut flat by its own frame; the cut hid behind the head at rest
// and opened into a seam on turn. Measured: that part ran 15% of its width,
// a clean one 5%, so the boundary sits between them.
const FLAT_CUT_MAX_FRAC = 0.1;
// ...and long in absolute terms. A mouth's upper lip is a naturally horizontal
// run that clears the fraction test on a narrow part while being only ~15px.
const FLAT_CUT_MIN_PX = 40;
// The cut is antialiased, so the transition is a soft cliff rather than
// transparent-to-opaque; 8/200 finds nothing at all on real art.
const FLAT_CUT_ALPHA_ABOVE = 120;
const FLAT_CUT_ALPHA_BELOW = 140;

/** Alpha-derived geometry of one layer, in canvas pixels. */
export interface LayerStats {
  w: number;
  h: number;
  /** Longest flat cut through the art, and the row it runs along (-1 if none). */
  flatCutRun: number;
  flatCutY: number;
  bboxCx: number;
  bboxCy: number;
  massCx: number;
  massCy: number;
  /** Distance from the layer's content to each canvas edge. */
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
  /** Fraction of each bbox edge that is opaque. */
  edgeTop: number;
  edgeBottom: number;
  edgeLeft: number;
  edgeRight: number;
  canvasW: number;
  canvasH: number;
}

export interface MeasureReport {
  /** Measured stats by role (the layer's file name without `.png`). */
  layers: Record<string, LayerStats>;
  /** Roles whose PNG is fully transparent — nothing to measure. */
  empty: string[];
  warnings: string[];
  /**
   * The lip set's opening as the rig reads it, set whenever the three lip
   * layers are present and readable. The fold's dead zone `deadZone` is the
   * `MouthOpen` below which the slit between the lips has not opened, and
   * it varies with the drawing (0.04 on one opening, 0.33 on another), so a
   * half-open mouth that shows no slit is judged against it, not against a
   * fixed number.
   */
  lips?: LipFacts;
}

export type MeasureResult =
  | ({ ok: true; layersDir: string; passed: boolean } & MeasureReport)
  | { ok: false; error: string };

export interface MeasureInput {
  /** Directory of role-named layer PNGs (relative paths resolve against cwd). */
  layersDir: string;
}

/**
 * Scan one layer PNG's alpha channel. Returns null for a fully transparent
 * layer. A decode failure surfaces as a path-qualified AutoRigInputError.
 */
export async function layerStats(filePath: string): Promise<LayerStats | null> {
  const { width: W, height: H, rgba } = await decodePng(filePath);
  const alpha = (x: number, y: number) => rgba[(y * W + x) * 4 + 3];

  let minX = W;
  let minY = H;
  let maxX = -1;
  let maxY = -1;
  let sumX = 0;
  let sumY = 0;
  let n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (alpha(x, y) > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        sumX += x;
        sumY += y;
        n++;
      }
    }
  }
  if (maxX < 0) return null; // fully transparent

  const edge = (pts: number[]) =>
    pts.filter((v) => v > 200).length / pts.length;
  const top: number[] = [];
  const bottom: number[] = [];
  const left: number[] = [];
  const right: number[] = [];
  for (let x = minX; x <= maxX; x++) {
    top.push(alpha(x, minY));
    bottom.push(alpha(x, maxY));
  }
  for (let y = minY; y <= maxY; y++) {
    left.push(alpha(minX, y));
    right.push(alpha(maxX, y));
  }

  // Longest contiguous run of pixels where the art appears out of nothing along
  // one row — transparent above, opaque below. Organic art (hair, cloth) meets
  // its silhouette at an angle, so a long FLAT run like this means the source
  // image was cropped through the drawing. It is often interior to the bbox
  // (a hair strand cut short above a wider shoulder line), which is why the
  // bbox-edge test alone misses it, and it only becomes visible once the head
  // turns and uncovers the cut.
  let flatCutRun = 0;
  let flatCutY = -1;
  for (let y = minY + 1; y <= maxY; y++) {
    let run = 0;
    for (let x = minX; x <= maxX; x++) {
      if (
        alpha(x, y - 1) < FLAT_CUT_ALPHA_ABOVE &&
        alpha(x, y) > FLAT_CUT_ALPHA_BELOW
      ) {
        run++;
        if (run > flatCutRun) {
          flatCutRun = run;
          flatCutY = y;
        }
      } else {
        run = 0;
      }
    }
  }

  return {
    w: maxX - minX + 1,
    h: maxY - minY + 1,
    flatCutRun,
    flatCutY,
    bboxCx: (minX + maxX) / 2,
    bboxCy: (minY + maxY) / 2,
    massCx: sumX / n,
    massCy: sumY / n,
    marginTop: minY,
    marginBottom: H - 1 - maxY,
    marginLeft: minX,
    marginRight: W - 1 - maxX,
    edgeTop: edge(top),
    edgeBottom: edge(bottom),
    edgeLeft: edge(left),
    edgeRight: edge(right),
    canvasW: W,
    canvasH: H,
  };
}

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

/** An arm's seams show once it raises, every other part's on the head turn. A
 *  pose forearm raises with its arm, and shows only once the switch is on. */
const isArm = (role: string) =>
  (ARM_ROLES as readonly string[]).includes(role) ||
  (POSE_ROLES as readonly string[]).includes(role);

/** A nose's dense core that `isSpeckCore` judged a speck of its part, as sizes
 *  in px: compose's verdict on the trimmed source part, or the composed
 *  layer's against its crop. */
export interface NoseSpeck {
  core: { w: number; h: number };
  part: { w: number; h: number };
}

/**
 * The nose-speck warning. Each source says only what its own reader did:
 * `"compose"` judged the trimmed source part, before resampling, and composed
 * it whole; `"layer"` judged the layer file against its crop, which is what
 * `auto_rig_from_layers` reads. The remedy is the same either way.
 */
function noseSpeckWarning(
  { core, part }: NoseSpeck,
  source: "compose" | "layer",
): string {
  const [found, consequence] =
    source === "compose"
      ? [
          `the source part's dense core is ${core.w}x${core.h} in its ${part.w}x${part.h} trimmed part`,
          `compose_layers_from_parts sized and placed the whole part instead — layout.nose's w and h now size it, feather included`,
        ]
      : [
          `the layer's dense core is ${core.w}x${core.h} in its ${part.w}x${part.h} crop`,
          `auto_rig_from_layers turns and tilts the nose about its whole crop instead`,
        ];
  return (
    `nose: ${found} — under ${SPECK_CORE_FRACTION} of its width or height, a speck: a lone nostril ` +
    `mark or highlight at alpha >= 128, not the drawing, so ${consequence}. Regenerate the nose with ` +
    `its shading painted denser, so the drawing itself reaches alpha 128. Billed.`
  );
}

/**
 * Count the lash's opaque pixels, and those of them that land where its
 * sclera is transparent. Both are canvas-sized layers, so a pixel's position
 * is the same canvas point in each.
 */
async function lashOffSclera(
  eyePath: string,
  lashPath: string,
): Promise<{ opaque: number; off: number }> {
  const eye = await decodePng(eyePath);
  const lash = await decodePng(lashPath);
  let opaque = 0;
  let off = 0;
  for (let y = 0; y < lash.height; y++) {
    for (let x = 0; x < lash.width; x++) {
      if (lash.rgba[(y * lash.width + x) * 4 + 3] < 128) continue;
      opaque++;
      const onEye = x < eye.width && y < eye.height;
      if (!onEye || eye.rgba[(y * eye.width + x) * 4 + 3] <= 8) off++;
    }
  }
  return { opaque, off };
}

/**
 * Measure every `*.png` in an already-resolved layers directory but the
 * `preview*.png` ones (`preview.png` is the composer's contact sheet, and a
 * caller's own previews sit beside it; none is a role) and run the geometry
 * checks.
 * `noseSpeck` is compose's own verdict on the nose's source part when that
 * part's core was a speck, and the nose check reports it as given. Left out —
 * compose found no speck, or `measure_layers` — that check judges the `nose`
 * layer file against its crop instead, as `auto_rig_from_layers` does.
 */
export async function measureDir(
  absDir: string,
  noseSpeck?: NoseSpeck,
): Promise<MeasureReport> {
  const files = fs
    .readdirSync(absDir)
    .filter((f) => f.endsWith(".png") && !f.startsWith("preview"))
    .sort();
  if (files.length === 0) {
    throw new AutoRigInputError(`no role layers in ${absDir}`);
  }
  // Same agent-supplied-input surface autoRigFromLayers bounds: a `layersDir`
  // pointed at an asset folder would decode every PNG in it before reporting.
  if (files.length > MAX_LAYERS) {
    throw new AutoRigInputError(
      `too many layers in ${absDir}: ${files.length} > ${MAX_LAYERS}`,
    );
  }

  const layers: Record<string, LayerStats> = {};
  const empty: string[] = [];
  for (const f of files) {
    const role = path.basename(f, ".png");
    const m = await layerStats(path.join(absDir, f));
    if (!m) {
      empty.push(role);
      continue;
    }
    layers[role] = m;
  }

  const warnings: string[] = [];

  // 1. Art running to its own edge → a straight seam appears on head turn.
  //    Two very different faults look identical in the flattened layer, and the
  //    remedies cost differently, so tell them apart before prescribing one: a
  //    part the CANVAS clipped has no margin left on that side (retune, free),
  //    while a part placed with room whose own drawing runs to its frame does
  //    (regenerate, billed). A real run lost a regeneration to this: the source
  //    kept 44 px of margin and the default layout pushed it 70 px off-canvas,
  //    so redrawing it reproduced the clip exactly.
  for (const [role, m] of Object.entries(layers)) {
    // A lip layer's straight edges are the split's cuts, not the art's; the
    // lip checks read what the rig does with them.
    if (isLipRole(role)) continue;
    const edges: [string, number, number, number][] = [
      ["top", m.edgeTop, m.w, m.marginTop],
      ["left", m.edgeLeft, m.h, m.marginLeft],
      ["right", m.edgeRight, m.h, m.marginRight],
    ];
    // A bust's torso is meant to run off the bottom of a square canvas. A
    // full body stands on a taller one with its soles inside it, where two
    // soles' flat bottoms could trip the generic check, so a check of its own
    // replaces it: paint on the canvas's last row is feet cut off.
    if (role !== "body") {
      edges.push(["bottom", m.edgeBottom, m.w, m.marginBottom]);
    } else if (m.canvasH > m.canvasW && m.marginBottom === 0) {
      warnings.push(
        `body: its bottom row is the canvas's last — on a tall canvas that cuts the feet off. ` +
          `Free fix: raise canvasHeight (the canvas grows downward, nothing else moves) and ` +
          `remeasure; regenerate body.png only if the drawing itself stops short of the soles.`,
      );
    }
    for (const [side, v, span, margin] of edges) {
      if (v > EDGE_SOLID_MAX && v * span >= EDGE_RUN_MIN_PX) {
        const remedy =
          margin === 0
            ? // margin 0 is consistent with a clipped placement AND with art
              // already cropped flush that happens to sit on the boundary, and
              // the flattened layer cannot separate them — so name the free
              // move rather than the cause. If moving it inward leaves the
              // edge opaque, the drawing is the one at fault.
              `it sits flush against the canvas ${side}, which a clipped placement and already-cropped ` +
              `art both produce. Move it inward first — retune layout.${role}.cx/cy/w, free — and ` +
              `remeasure; regenerate only if the edge is still opaque with margin to spare.`
            : `its own drawing runs to the frame ${margin} px inside the canvas — regenerate that part ` +
              `with empty margin on that side. Billed.`;
        warnings.push(
          `${role}: ${pct(v)} of its ${side} edge is opaque — the art is cut off there, ` +
            `which shows as a straight seam ${isArm(role) ? "once the arm raises" : "once the head turns"}. ` +
            `Cause: ${remedy}`,
        );
      }
    }
  }

  // 1b. A straight cut through the drawing, wherever it falls in the bbox.
  for (const [role, m] of Object.entries(layers)) {
    // `body` bends as one drawing, so no pose opens a cut in it; its top is
    // deliberately cut flat where the jaw covers it, and stays under the jaw
    // because the head rides the body.
    if (role === "body" || isLipRole(role)) continue;
    if (
      m.flatCutRun > FLAT_CUT_MAX_FRAC * m.w &&
      m.flatCutRun >= FLAT_CUT_MIN_PX
    ) {
      warnings.push(
        `${role}: ${m.flatCutRun}px of straight flat edge at y=${m.flatCutY} ` +
          `(${pct(m.flatCutRun / m.w)} of its width) — the source art is cut through there. ` +
          (isArm(role)
            ? `It hides at rest and opens into a seam once the arm raises. `
            : `It hides while the head faces front and opens into a seam on turn. `) +
          `Regenerate this part with the whole subject inside the frame.`,
      );
    }
  }

  // 1c. The arms: each needs a body, and its shoulder cap the torso under it.
  warnings.push(...(await armWarnings(absDir, layers)));

  // 1d. The pose forearms: each needs its arm, and its elbow end the arm's elbow.
  warnings.push(...(await forearmPoseWarnings(absDir, layers)));

  // 1e. The lip set: the fold's contract per column, the opening's size, the
  //     line's weight, key green left, an interior with holes.
  const lip = await lipWarnings(absDir, layers);
  warnings.push(...lip.warnings);

  // 2/3/4. Eye stack geometry, per side.
  for (const side of ["L", "R"]) {
    const eye: LayerStats | undefined = layers[`eye_${side}`];
    const iris: LayerStats | undefined = layers[`iris_${side}`];
    const lash: LayerStats | undefined = layers[`lash_${side}`];
    if (!eye) continue;

    const aspect = eye.h / eye.w;
    if (aspect < EYE_ASPECT_MIN) {
      warnings.push(
        `eye_${side}: sclera aspect h/w=${aspect.toFixed(2)} is flatter than ${EYE_ASPECT_MIN} — ` +
          `a round iris cannot sit inside it. Free fix first: set layout.eye_${side}.h and ` +
          `layout.lash_${side}.h to ${Math.ceil(eye.w * EYE_ASPECT_MIN)} (both, or the fold tears) — ` +
          `stretching a flat white lens is invisible. Regenerate the eyewhite taller only if that ` +
          `distorts the lash.`,
      );
    }

    if (iris) {
      const ratio = iris.w / eye.w;
      if (ratio < IRIS_RATIO_MIN || ratio > IRIS_RATIO_MAX) {
        warnings.push(
          `iris_${side}: width is ${pct(ratio)} of the sclera (target ${IRIS_RATIO_MIN}-${IRIS_RATIO_MAX}) — ` +
            `retune layout.iris_${side}.w (keep it a fraction of the eye width), no regeneration needed.`,
        );
      }
      const dx = iris.bboxCx - eye.massCx;
      const dy = iris.bboxCy - eye.massCy;
      if (
        Math.abs(dx) > IRIS_OFFSET_MAX_X ||
        Math.abs(dy) > IRIS_OFFSET_MAX_Y
      ) {
        warnings.push(
          `iris_${side}: sits (${dx.toFixed(1)}, ${dy.toFixed(1)}) px from the white's centre of mass — ` +
            `retune layout.iris_${side}.cx/cy. The sclera's bbox centre is NOT its visual centre when the ` +
            `lash flick stretches the box.`,
        );
      }
    }

    // 5. The lash and the white are split from ONE source and pasted with the
    // same cx/cy/w, so their frames coincide even though the lash only inks the
    // upper part of it (its content sits higher — that is the fold working, not
    // a fault). In sync, the lash is ink the sclera was recoloured from, so
    // every opaque lash pixel lies on the sclera, and both ink the same top
    // row; a drift moves pixels off it, and a lash scaled down inside it (a w
    // or h out of sync) drops its top row — the seam the fold rides — either
    // way tearing the fold. Neither the ink centres nor the frame's sides can
    // stand in for that: a lash stops short of the tear duct (5b), so a
    // correctly composed eye's ink sits 3-5% of its width off the sclera's
    // centre, while a lash drifting in toward that bare end stays inside the
    // frame.
    //
    // 5b. Which way the eye was drawn. A lash runs out to the outer corner,
    // wing and all, and stops short of the tear duct at the inner one, so in
    // the frame it shares with the sclera it is the nose end that the lash
    // leaves bare. A lash that stops short of the OUTER end instead is an
    // eyewhite drawn facing the other way: the wings point in, and "left eye"
    // in a prompt cannot prevent it, since it reads as the viewer's left or
    // the character's. The ends are read, not the ink's centroid: a thin wing
    // widens the frame far more than it moves the centroid, which reads a
    // correctly drawn eye as reversed. Only a lash in sync is read — a drift
    // moves the ends too, and is check 5's to report, not the drawing's.
    if (lash) {
      const { opaque, off } = await lashOffSclera(
        path.join(absDir, `eye_${side}.png`),
        path.join(absDir, `lash_${side}.png`),
      );
      const dTop = lash.marginTop - eye.marginTop;
      const faults = [
        ...(off > opaque * LASH_STRAY_TOL_FRAC
          ? [`${off} of its ${opaque} opaque px lie off eye_${side}'s sclera`]
          : []),
        ...(Math.abs(dTop) > 0.5
          ? [`its top edge is ${dTop.toFixed(1)} px off the sclera's`]
          : []),
      ];
      if (faults.length > 0) {
        warnings.push(
          `lash_${side}: ${faults.join(" and ")} — they are split from one source and MUST share ` +
            `cx/cy/w/h in layout, or the blink fold tears. Retune to match.`,
        );
      } else {
        // How far short of each side of the frame the lash stops.
        const bareLeft = lash.marginLeft - eye.marginLeft;
        const bareRight = lash.marginRight - eye.marginRight;
        // eye_R is the screen-left eye: its outer corner is its left end.
        const [bareOuter, bareInner] =
          side === "R" ? [bareLeft, bareRight] : [bareRight, bareLeft];
        if ((bareOuter - bareInner) / eye.w > EYE_FACING_TOL_FRAC) {
          warnings.push(
            `eye_${side}: its lash stops ${pct(bareOuter / eye.w)} of the eye width short of the outer corner ` +
              `and ${pct(bareInner / eye.w)} short of the nose side — the eyewhite is drawn facing the other way, ` +
              `lash wing at the inner corner. The composer reads eyewhite.png as the eye on the screen LEFT: lash ` +
              `wing at the image's left end, lash-free tear duct at its right. Free fix: compose again with ` +
              `mirrorParts: ["eyewhite.png"] — no regeneration.`,
          );
        }
      }
    }
  }

  // 6. A nose whose dense core is a speck of its part (`isSpeckCore`). A
  //    speck compose found in the source part, before resampling, is reported
  //    as given: a dot blurred under alpha 128 no longer shows in the file.
  //    Otherwise the file is judged against its crop — what the rig reads —
  //    which also catches a core that only resampling made a speck.
  if (noseSpeck !== undefined) {
    warnings.push(noseSpeckWarning(noseSpeck, "compose"));
  } else if (layers.nose !== undefined) {
    const nose = await decodePng(path.join(absDir, "nose.png"));
    const core = denseCoreOf(nose.rgba, nose.width, nose.height);
    if (core !== null) {
      const crop = detectAlphaBbox(nose.rgba, nose.width, nose.height);
      if (isSpeckCore(core, crop))
        warnings.push(noseSpeckWarning({ core, part: crop }, "layer"));
    }
  }

  // 7. Optional roles that change how finished the character reads.
  for (const [role, why] of [
    ["body", "without it the character reads as a floating head on head-turn"],
    ["hair_back", "without it the silhouette is flat behind the face"],
    [
      "nose",
      "without it the head still turns on the default profile, but there is no nose to lead it, and no turn fit to the art (`turnTargets` is inert, no `turn` report)",
    ],
  ]) {
    if (layers[role] === undefined) warnings.push(`${role}: missing — ${why}.`);
  }

  return {
    layers,
    empty,
    warnings,
    ...(lip.lips === undefined ? {} : { lips: lip.lips }),
  };
}

/**
 * Measure a caller-supplied layers directory.
 *
 * Error boundary: ONLY AutoRigInputError (caller input / filesystem) →
 * `{ ok:false }`, matching autoRigFromLayers; any other throw propagates.
 */
export async function measureLayers(
  input: MeasureInput,
): Promise<MeasureResult> {
  try {
    const layersDir = resolveInputDir(input.layersDir);
    const report = await measureDir(layersDir);
    return {
      ok: true,
      layersDir,
      ...report,
      passed: report.warnings.length === 0,
    };
  } catch (err) {
    if (err instanceof AutoRigInputError)
      return { ok: false, error: err.message };
    throw err;
  }
}

/**
 * Render a measurement as plain text: the per-layer table first (numbers to
 * argue with), then the checks that fired. Takes the report itself rather than
 * a MeasureResult so a caller holding one inline (no `ok` to unwrap) can print
 * it too; a failed measurement has no report to render.
 */
export function formatMeasureReport(
  result: MeasureReport & { layersDir: string },
): string {
  const lines = [
    `# layers  (${result.layersDir})`,
    "",
    "role          size        bbox-centre    mass-centre   margins t/b/l/r",
  ];
  // Roles come off a sorted file listing, so sorting the two groups back
  // together restores that order.
  for (const role of [...Object.keys(result.layers), ...result.empty].sort()) {
    const m = result.layers[role];
    if (m === undefined) {
      lines.push(`${role.padEnd(13)} EMPTY (fully transparent)`);
      continue;
    }
    lines.push(
      `${role.padEnd(13)} ${`${m.w}x${m.h}`.padEnd(11)} ` +
        `${`${m.bboxCx.toFixed(0)},${m.bboxCy.toFixed(0)}`.padEnd(14)} ` +
        `${`${m.massCx.toFixed(0)},${m.massCy.toFixed(0)}`.padEnd(13)} ` +
        `${m.marginTop}/${m.marginBottom}/${m.marginLeft}/${m.marginRight}`,
    );
  }

  if (result.lips !== undefined) {
    const { opening, deadZone } = result.lips;
    lines.push(
      "",
      `lips: opening ${opening.width} px wide, ${opening.height} px tall at its centre under a ${opening.line} px line — no slit below MouthOpen ${deadZone.toFixed(2)}`,
    );
  }

  lines.push("", "# checks", "");
  if (result.warnings.length === 0) {
    lines.push("all geometry checks passed");
  } else {
    for (const w of result.warnings) lines.push(`- ${w}`);
  }
  return lines.join("\n");
}
