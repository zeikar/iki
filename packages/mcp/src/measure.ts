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
import { decodePng } from "./node-images";
import { AutoRigInputError, MAX_LAYERS, resolveInputDir } from "./limits";

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
/** Lash-vs-sclera ink-centre drift tolerated as intrinsic asymmetry, as a
 *  fraction of the eye width. See the check for why it is not zero. */
const LASH_CENTRE_TOL_FRAC = 0.03;
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

/**
 * Measure every `*.png` in an already-resolved layers directory (`preview.png`
 * is the composer's contact sheet, not a role) and run the geometry checks.
 */
export async function measureDir(absDir: string): Promise<MeasureReport> {
  const files = fs
    .readdirSync(absDir)
    .filter((f) => f.endsWith(".png") && f !== "preview.png")
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
    const edges: [string, number, number, number][] = [
      ["top", m.edgeTop, m.w, m.marginTop],
      ["left", m.edgeLeft, m.h, m.marginLeft],
      ["right", m.edgeRight, m.h, m.marginRight],
    ];
    // A torso is meant to run off the bottom of the canvas.
    if (role !== "body")
      edges.push(["bottom", m.edgeBottom, m.w, m.marginBottom]);
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
            `which shows as a straight seam once the head turns. Cause: ${remedy}`,
        );
      }
    }
  }

  // 1b. A straight cut through the drawing, wherever it falls in the bbox.
  for (const [role, m] of Object.entries(layers)) {
    // `body` moves only as a rigid whole (a light share of the head's turn
    // and breath), so no pose can uncover a cut in it; its top is deliberately
    // cut flat where the jaw covers it.
    if (role === "body") continue;
    if (
      m.flatCutRun > FLAT_CUT_MAX_FRAC * m.w &&
      m.flatCutRun >= FLAT_CUT_MIN_PX
    ) {
      warnings.push(
        `${role}: ${m.flatCutRun}px of straight flat edge at y=${m.flatCutY} ` +
          `(${pct(m.flatCutRun / m.w)} of its width) — the source art is cut through there. ` +
          `It hides while the head faces front and opens into a seam on turn. ` +
          `Regenerate this part with the whole subject inside the frame.`,
      );
    }
  }

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
    // a fault). What must line up is the horizontal centre and the top edge; a
    // drift there means the two layout entries fell out of sync and the fold
    // will tear.
    if (lash) {
      const dx = lash.bboxCx - eye.bboxCx;
      const dTop = lash.marginTop - eye.marginTop;
      // dx compares INK centres, and the lash's ink is narrower than the frame it
      // shares with the sclera, so a lash whose flick runs one way sits a pixel or
      // two off-centre while its layout entry is perfectly in sync — a real run
      // measured 1.5 px on a 128 px eye and the warning could not be acted on.
      // Scale the tolerance with the eye so the desync this guards (14 px on a
      // real character) still trips it. dTop stays strict: the fold seam rides
      // that edge, and both layers ink the same top row when they are in sync.
      if (Math.abs(dx) > eye.w * LASH_CENTRE_TOL_FRAC || Math.abs(dTop) > 0.5) {
        warnings.push(
          `lash_${side}: centre is ${dx.toFixed(1)} px and top edge ${dTop.toFixed(1)} px off eye_${side}. ` +
            `They are split from one source and MUST share cx/cy/w in layout, or the blink fold tears. Retune to match.`,
        );
      }
    }
  }

  // 6. Optional roles that change how finished the character reads.
  for (const [role, why] of [
    ["body", "without it the character reads as a floating head on head-turn"],
    ["hair_back", "without it the silhouette is flat behind the face"],
    [
      "nose",
      "without it nothing on the face slides on the head turn — the features stay on the plate",
    ],
  ]) {
    if (layers[role] === undefined) warnings.push(`${role}: missing — ${why}.`);
  }

  return { layers, empty, warnings };
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

  lines.push("", "# checks", "");
  if (result.warnings.length === 0) {
    lines.push("all geometry checks passed");
  } else {
    for (const w of result.warnings) lines.push(`- ${w}`);
  }
  return lines.join("\n");
}
