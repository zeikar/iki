/**
 * The alpha rules a layer set is measured by, and the pre-rig measurement of
 * that set, in one DOM-free copy — the way `detectAlphaBbox` is one.
 *
 * Both auto-rig hosts — the editor app (canvas `getImageData`) and
 * `@ikijs/mcp`'s `auto_rig_from_layers` (a `sharp` raw buffer) — hand
 * `createLayerSetMeasurer` the RGBA they decoded and rig what it measures, and
 * `@ikijs/mcp`'s other tools (`measure_turn_reference`, `measure_layers`, the
 * composer) read the same rules. Two copies would have to be kept identical by
 * hand, or the head a render measures back, or the nose core the composer
 * placed, would part from the one the rig was fitted to. Only decoding differs
 * between the hosts.
 */

import { detectAlphaBbox } from "./alpha-bbox";
import type { IrisStrand, LayerInput } from "./auto-rig";

/** Half-height of the row band the head span is taken over, in px. Fixed at
 *  ±10 rows rather than scaled to the image, and that is the convention: any
 *  other measurement of head width meant to be compared with the one
 *  `@ikijs/mcp`'s `measure_turn_reference` takes off a render — one taken off
 *  layer alpha, a hand script — has to span the same band. Shared by that tool
 *  and `createLayerSetMeasurer`, so the head it spans off the layers' alpha
 *  union spans this band too. */
export const HEAD_BAND = 10;

/** Alpha at or above this is opaque. Shared by `@ikijs/mcp`'s
 *  `measure_turn_reference`, whose "alpha" foreground rule reads an engine
 *  render's silhouette by it, and by the layer-alpha silhouette
 *  `createLayerSetMeasurer` measures the head on, which has to follow that
 *  rule to be comparable with a render. */
export const ALPHA_OPAQUE = 128;

/**
 * A layer's dense core: the tight box of its pixels at alpha ≥ ALPHA_OPAQUE,
 * not grown. A soft-alpha part (a nose drawn as a shaded bump) is mostly
 * feather, and the core is the drawing a viewer reads inside it — `@ikijs/mcp`'s
 * composer sizes and places the nose by it, and `createLayerSetMeasurer` reads
 * the same core as the nose's `LayerInput.denseCore`, its turn landmark. It is
 * not the crop: that stays the alpha ≥ 8 box grown by 1 px (`detectAlphaBbox`).
 * `null` when no pixel reaches the threshold, a part painted wholly
 * translucent. A core that is a speck of its part (`isSpeckCore`) is not the
 * drawing either, and both readers fall back to the whole part, as they do for
 * `null`.
 */
export function denseCoreOf(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] >= ALPHA_OPAQUE) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * The fraction of its part's width, or of its height, under which a dense core
 * is a speck (`isSpeckCore`). Measured core/part ratios, width / height: the
 * hero's composed nose 0.72 / 0.76 (core 39×63 in a 54×83 crop), three
 * generated shaded-bump noses (the plugin's 0.11 nose prompt) 0.75–0.85 /
 * 0.79–0.91, `@ikijs/mcp`'s `writeSoftNose` test fixture 0.56 / 0.63 and its
 * `writeSoftNoseLayers` 0.40 / 0.40, a nostril mark ≤ 0.1. So the line sits at
 * least 1.6× under every real nose and fixture, and 2.5× over a speck. At the
 * line, sizing by the core would scale the whole part to 4× its layout width,
 * the largest blow-up `@ikijs/mcp`'s composer still accepts.
 */
export const SPECK_CORE_FRACTION = 0.25;

/**
 * Whether a dense core is a speck of its part: narrower than
 * SPECK_CORE_FRACTION of the part's width, or shorter than that fraction of
 * its height (strictly `<`). Either dimension counts, because the core does
 * more than size a nose: its bottom row is the tip the composer places, and
 * its top-centre the rig's tilt pivot, so a sliver misplaces the nose as
 * surely as a speck mis-sizes it. A speck is a lone nostril mark or highlight,
 * not the drawing, and every reader falls back to the whole part: `@ikijs/mcp`'s
 * compose sizes and places its trimmed source part whole, and
 * `createLayerSetMeasurer` hands the rig no core, so the crop stands in.
 *
 * The two apply it to different pixels — compose to the source part before
 * resampling, the rig and `measure_layers` to the composed layer against its
 * crop — so their verdicts can part, but only for a core within about a
 * resampled pixel of the line, or one resampling pushes across ALPHA_OPAQUE.
 * Compose's report carries its source verdict when that was a speck, and
 * otherwise what the composed layer shows, so it warns of a parting either
 * way; `measure_layers` reports the layer alone.
 */
export function isSpeckCore(
  core: { w: number; h: number },
  part: { w: number; h: number },
): boolean {
  return (
    core.w < SPECK_CORE_FRACTION * part.w ||
    core.h < SPECK_CORE_FRACTION * part.h
  );
}

/**
 * Outermost set pixels of `mask` across the row band `rowLo..rowHi` (clamped
 * to the image) — the silhouette span at that height. An empty band returns
 * `left > right`, which every caller has to check for.
 *
 * Shared by `@ikijs/mcp`'s `measure_turn_reference`, which spans a render's
 * head with it, and `createLayerSetMeasurer`, which spans the layers' alpha
 * union: the two heads are compared, so they have to be spanned the same way.
 */
export function foregroundSpan(
  mask: Uint8Array,
  width: number,
  height: number,
  rowLo: number,
  rowHi: number,
): { left: number; right: number } {
  let left = width;
  let right = -1;
  for (let y = Math.max(0, rowLo); y <= Math.min(height - 1, rowHi); y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  return { left, right };
}

/**
 * Half of a silhouette span, in px. The span is INCLUSIVE — `left` and `right`
 * are both foreground columns — so the head is `right - left + 1` px wide.
 * Shared by `@ikijs/mcp`'s `measure_turn_reference` and
 * `createLayerSetMeasurer`: the two head half-widths are compared against each
 * other, so they cannot be halved differently.
 */
export function headHalfOf(span: { left: number; right: number }): number {
  return (span.right - span.left + 1) / 2;
}

/** One decoded layer, as a host hands it to `LayerSetMeasurer.add`. */
export interface RgbaLayer {
  /** Canonical role, e.g. "eye_L" — the host has run `parseLayerRoles` on
   *  the set already. */
  role: string;
  /** Original file name: the `LayerInput`'s own, and named in errors. */
  fileName: string;
  /** Straight-alpha RGBA, stride 4, `canvas.width × canvas.height` pixels —
   *  canvas `ImageData.data` or a `sharp` raw buffer alike. */
  rgba: ArrayLike<number>;
}

/** A pixel darker than this share of the plate's median skin luminance is
 *  line work: the jaw's outline, not its shading. */
const DARK_SHARE = 0.55;

/**
 * The face plate's jaw line, per crop column: going down from the plate's
 * widest row, the canvas row of the last pixel of the first dark stroke met
 * (the jaw's outline where a neck runs on below it), or −1 where the column
 * leaves the paint first. `undefined` when no column meets a stroke — art
 * with no line work, which the generator then reads off its outline alone.
 */
function jawRowsOf(
  rgba: ArrayLike<number>,
  canvasW: number,
  bbox: { x: number; y: number; w: number; h: number },
  rowLeft: Int32Array,
  rowRight: Int32Array,
): number[] | undefined {
  const lum = (p: number) =>
    0.299 * rgba[p * 4] + 0.587 * rgba[p * 4 + 1] + 0.114 * rgba[p * 4 + 2];
  const hist = new Uint32Array(256);
  let count = 0;
  let widest = bbox.y;
  let widestSpan = -1;
  for (let y = bbox.y; y < bbox.y + bbox.h; y++) {
    const span = rowRight[y] - rowLeft[y];
    if (span >= widestSpan) {
      widestSpan = span;
      widest = y;
    }
    for (let x = bbox.x; x < bbox.x + bbox.w; x++) {
      const p = y * canvasW + x;
      if (rgba[p * 4 + 3] < ALPHA_OPAQUE) continue;
      hist[Math.min(255, Math.round(lum(p)))]++;
      count++;
    }
  }
  if (count === 0) return undefined;
  let median = 0;
  for (let acc = 0; median < 255; median++) {
    acc += hist[median];
    if (acc * 2 >= count) break;
  }
  const dark = DARK_SHARE * median;
  const out: number[] = [];
  let found = false;
  for (let x = bbox.x; x < bbox.x + bbox.w; x++) {
    let row = -1;
    for (let y = widest + 1; y < bbox.y + bbox.h; y++) {
      const p = y * canvasW + x;
      if (rgba[p * 4 + 3] < ALPHA_OPAQUE) break;
      if (lum(p) >= dark) continue;
      let end = y;
      while (
        end + 1 < bbox.y + bbox.h &&
        rgba[((end + 1) * canvasW + x) * 4 + 3] >= ALPHA_OPAQUE &&
        lum((end + 1) * canvasW + x) < dark
      ) {
        end++;
      }
      row = end;
      break;
    }
    if (row >= 0) found = true;
    out.push(row);
  }
  return found ? out : undefined;
}

/**
 * Measures a layer set one decoded layer at a time, so a host holds one
 * full-canvas RGBA buffer at once, however many layers the set has. Call
 * `finish` once, after the last `add`: it hands back its own `layers` array,
 * which a later `add` would change.
 */
export interface LayerSetMeasurer {
  /**
   * Measure one layer while its `rgba` is in memory, keeping no reference to
   * it: only the set's opaque union, this layer's per-row opaque extent and
   * the `LayerInput` it returns outlive the call, so the host may drop `rgba`
   * as soon as it returns. Returns the layer's `LayerInput` — its crop
   * box, the face's `rowHalfWidths`, the face's and hair layers' `rowRuns`, the nose's
   * `denseCore` unless that is a speck of its crop (`isSpeckCore`) — or
   * `null` for an empty layer, one with no pixel at or above
   * `ALPHA_BBOX_THRESHOLD`, which it records nothing for: the host reports
   * that with its own error. Throws, naming the file, when
   * `rgba` is not `width × height × 4` long; checking the decoded dimensions
   * is the host's job.
   */
  add(layer: RgbaLayer): LayerInput | null;
  /** The set's measurement, over every layer `add` recorded. The set must be
   *  one `parseLayerRoles` accepted; otherwise this may throw, or measure a
   *  partial set the generator then refuses. */
  finish(): LayerSetMeasurement;
}

export interface LayerSetMeasurement {
  /** Every recorded layer's `LayerInput`, in `add` order. */
  layers: LayerInput[];
  /** The head's half-width at the eye row, canvas px: half the opaque
   *  (alpha ≥ ALPHA_OPAQUE) union's span over ±HEAD_BAND rows about the row
   *  of the iris centres, or of the eye centres without irises. Absent when
   *  the union has no span there — a layer set painted translucent below that
   *  threshold. */
  headHalfWidth?: number;
  /** Whether `headHalfWidth` is wider than the face plate, and so applied;
   *  the face plate stands in for it otherwise, as the generator's own
   *  fallback. */
  headHalfWidthApplied: boolean;
  /**
   * Ready to go into `generateIkiFromLayerSet`'s options, each key present
   * only when measured: `turnTargets.headHalfWidth` when it is applied (merge
   * the caller's own targets under it), `headEdges` — every layer's own
   * opaque extent in the same eye-row band, per side, in model x — with it,
   * and `strandEdges` whenever the set has `hair_front`, `iris_L` and `iris_R`
   * and a side measures one (`IrisStrand`).
   */
  turnOptions: {
    turnTargets?: { headHalfWidth: number };
    headEdges?: {
      left: { role: string; x: number }[];
      right: { role: string; x: number }[];
    };
    strandEdges?: { left?: IrisStrand; right?: IrisStrand };
  };
}

/**
 * The row the head's width is measured at: the mean of the iris centres, or of
 * the eye centres when the layer set has no irises. `@ikijs/mcp`'s
 * `measure_turn_reference` picks the same row off a render — it finds the
 * irises themselves — so the head it spans there is the head spanned here. Not
 * the generator's own eye row (`HeadFrame.eyeY` in `auto-rig/head.ts`, the eye
 * landmarks' mean model y, unrounded): this
 * is the canvas row of the crop centres, rounded, and one in place of the other
 * would move the measured head.
 */
function eyeBandRowOf(layers: LayerInput[]): number {
  const centreY = (role: string): number | undefined => {
    const layer = layers.find((l) => l.role === role);
    return layer && layer.bbox.y + layer.bbox.h / 2;
  };
  const pairRow = (left: string, right: string): number | undefined => {
    const a = centreY(left);
    const b = centreY(right);
    return a === undefined || b === undefined ? undefined : (a + b) / 2;
  };
  const row = pairRow("iris_L", "iris_R") ?? pairRow("eye_L", "eye_R");
  if (row === undefined) {
    // eye_L/eye_R are required roles: a set without them is one
    // parseLayerRoles refuses, which `finish` requires the host to have run.
    throw new Error("auto-rig: no eye pair to measure the head width at");
  }
  return Math.round(row);
}

/**
 * `foregroundSpan`, but over one layer's own already-reduced per-row
 * left/right (see `rowSpansByRole` in `createLayerSetMeasurer`) instead of a
 * pixel mask — the same row-band reduction, without re-scanning pixels.
 */
function foregroundSpanOfRows(
  rowLeft: Int32Array,
  rowRight: Int32Array,
  rowLo: number,
  rowHi: number,
): { left: number; right: number } {
  let left = Infinity;
  let right = -Infinity;
  for (
    let y = Math.max(0, rowLo);
    y <= Math.min(rowLeft.length - 1, rowHi);
    y++
  ) {
    if (rowLeft[y] < left) left = rowLeft[y];
    if (rowRight[y] > right) right = rowRight[y];
  }
  return { left, right };
}

/** The face plate's half-width, derived the way generateIkiFromLayerSet derives
 *  it — off the `face` layer's cropped width — so the two agree on which head
 *  is the wider one. */
function facePlateHalfOf(layers: LayerInput[]): number {
  const face = layers.find((l) => l.role === "face");
  if (face === undefined) {
    // `face` is a required role: a set without it is one parseLayerRoles
    // refuses, which `finish` requires the host to have run.
    throw new Error("auto-rig: no face layer to measure the plate against");
  }
  return face.cropW / 2;
}

/**
 * The narrowest `hair_front` run, as a fraction of an iris's painted width on
 * its centre row, that the strand scan takes as a strand. A run narrower than
 * this (strictly `<`; one exactly this wide is a strand) is hair detail and
 * counts as clear: the far iris may cross it on the turn, as intended. The
 * hero's row shows why: 5 px inside its 67 px side strand lies an 8 px wisp
 * the iris is painted 2 px under, and bounding the iris against that wisp cut
 * the −30 eye shift from ≈ 0.18 to 0.14.
 */
const STRAND_MIN_RUN_FRACTION = 0.5;

/**
 * Start measuring a layer set on a `canvas`-sized canvas: the pass a host runs
 * between decoding its layers and `generateIkiFromLayerSet`. `add` each
 * decoded layer, then `finish`.
 *
 * Throws before allocating anything when `canvas.width` or `canvas.height` is
 * not a positive safe integer, or `width × height × 4` is not a safe integer.
 * How large a canvas to accept at all is each host's own limit.
 */
export function createLayerSetMeasurer(canvas: {
  width: number;
  height: number;
}): LayerSetMeasurer {
  for (const field of ["width", "height"] as const) {
    const value = canvas[field];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        `auto-rig: createLayerSetMeasurer: canvas.${field} must be a positive safe integer, got ${value}`,
      );
    }
  }
  const { width: canvasW, height: canvasH } = canvas;
  const rgbaLength = canvasW * canvasH * 4;
  if (!Number.isSafeInteger(rgbaLength)) {
    throw new Error(
      `auto-rig: createLayerSetMeasurer: canvas ${canvasW}x${canvasH} is too large: width × height × 4 = ${rgbaLength} is not a safe integer`,
    );
  }

  // Union of EVERY layer's opaque pixels — the silhouette the head half-width
  // is measured off in `finish`. Every layer folds in, so a body or an
  // accessory crossing the eye band widens the span; that is deliberate,
  // because a rest render of the finished rig shows the same union and
  // measures the same.
  const opaque = new Uint8Array(canvasW * canvasH);
  const layerInputs: LayerInput[] = [];
  // Per layer, per row: its OWN leftmost/rightmost opaque column (canvasW /
  // -1 where it has none that row) — recorded in the SAME pass as the union
  // fold, while the layer's decoded pixels are still live, rather than a
  // second decode pass. Read in `finish` once the eye row is known: each
  // layer's own extent in the eye-row band (`headEdges`), which the generator
  // lands through that layer's own deformation, and each iris's on its centre
  // row (`strandEdges`).
  const rowSpansByRole: {
    role: string;
    rowLeft: Int32Array;
    rowRight: Int32Array;
  }[] = [];

  function add({ role, fileName, rgba }: RgbaLayer): LayerInput | null {
    if (rgba.length !== rgbaLength) {
      throw new Error(
        `auto-rig: layer "${fileName}": rgba length ${rgba.length} is not ${canvasW}x${canvasH}x4 = ${rgbaLength}`,
      );
    }
    const bbox = detectAlphaBbox(rgba, canvasW, canvasH);
    if (bbox === null) return null;
    // Fold this layer into the silhouette AND record its own per-row extent
    // while its pixels are still here — one pass over the same pixels.
    const rowLeft = new Int32Array(canvasH).fill(canvasW);
    const rowRight = new Int32Array(canvasH).fill(-1);
    const rowRuns: number[][] | undefined =
      role === "face" || role === "hair_front" || role === "hair_back"
        ? []
        : undefined;
    for (let y = 0; y < canvasH; y++) {
      // Every opaque pixel lies inside the crop, so only its rows hold runs.
      let runs: number[] | undefined;
      if (rowRuns !== undefined && y >= bbox.y && y < bbox.y + bbox.h) {
        runs = [];
        rowRuns.push(runs);
      }
      let inRun = false;
      for (let x = 0; x < canvasW; x++) {
        const p = y * canvasW + x;
        const on = rgba[p * 4 + 3] >= ALPHA_OPAQUE;
        if (runs !== undefined && on !== inRun) {
          runs.push(x);
          inRun = on;
        }
        if (!on) continue;
        opaque[p] = 1;
        if (x < rowLeft[y]) rowLeft[y] = x;
        if (x > rowRight[y]) rowRight[y] = x;
      }
      if (runs !== undefined && inRun) runs.push(canvasW);
    }
    rowSpansByRole.push({ role, rowLeft, rowRight });
    const layer: LayerInput = {
      role,
      fileName,
      canvasW,
      canvasH,
      bbox,
      cropW: bbox.w,
      cropH: bbox.h,
    };
    if (rowRuns !== undefined) layer.rowRuns = rowRuns;
    if (role === "face") {
      // The plate's painted half-width on each of its crop rows — the same
      // alpha rule and halving as the head's own span, row by row (0 for a
      // row with no opaque pixel; a single opaque pixel IS a half-px row
      // here, where the head-span reads below treat a one-column band as
      // no span) — which give the plate's outline, the neck's plateau and
      // the ears' steps. The bbox admits alpha down to 8 while the span counts
      // alpha >= 128 only, so a row's span sits inside the crop and its
      // half never exceeds cropW / 2, the generator's bound.
      const rowHalfWidths: number[] = [];
      for (let y = bbox.y; y < bbox.y + bbox.h; y++) {
        rowHalfWidths.push(
          rowRight[y] >= rowLeft[y]
            ? headHalfOf({ left: rowLeft[y], right: rowRight[y] })
            : 0,
        );
      }
      layer.rowHalfWidths = rowHalfWidths;
      const jawRows = jawRowsOf(rgba, canvasW, bbox, rowLeft, rowRight);
      if (jawRows !== undefined) layer.jawRows = jawRows;
    } else if (role === "nose") {
      // The drawing inside a soft nose's feather, canvas px like `bbox` —
      // `rgba` is this layer's full-canvas buffer, so the core comes out in
      // the same coordinates as `bbox` and every other measurement here.
      // `null` (wholly translucent) or a speck of the crop (a lone nostril
      // mark, which `@ikijs/mcp`'s measure_layers flags on this same layer)
      // leaves `denseCore` unset, the generator falling back to the crop.
      const core = denseCoreOf(rgba, canvasW, canvasH);
      if (core !== null && !isSpeckCore(core, bbox)) layer.denseCore = core;
    }
    layerInputs.push(layer);
    return layer;
  }

  function finish(): LayerSetMeasurement {
    // The head's own half-width at the eye row, in canvas px, taken off the
    // layers' opaque union the way measure_turn_reference takes it off a render
    // (alpha rule, same row band, same halving) — so a rest render of this rig
    // measures the same span back. It is what the turn's shift targets are
    // fractions of; the generator's own fallback is the face plate, which is
    // narrower than the head the hair draws, and every shift then lands short.
    const eyeRow = eyeBandRowOf(layerInputs);
    const span = foregroundSpan(
      opaque,
      canvasW,
      canvasH,
      eyeRow - HEAD_BAND,
      eyeRow + HEAD_BAND,
    );
    // A layer set painted below the ALPHA_OPAQUE threshold (translucent art —
    // still above detectAlphaBbox's own, much lower, floor) has no confident
    // span here. That is not the same as having no head: fall back to the face
    // plate, same as a span that measures narrower than it below, rather than
    // refuse the whole rig over a union that is merely non-opaque.
    const headHalfWidth = span.right > span.left ? headHalfOf(span) : undefined;
    // ...but only when it IS wider than the plate. A hairless set, one whose
    // face plate is what the eye row is widest at, or one with no confident
    // span at all, measures a head the generator refuses (the silhouette
    // hold's zone would sit inside the plate) — and the right answer there is
    // the plate it falls back to, not no rig at all.
    const headHalfWidthApplied =
      headHalfWidth !== undefined &&
      headHalfWidth > facePlateHalfOf(layerInputs);

    // Every layer's own opaque extent in the same band — a companion to
    // headHalfWidth, only meaningful once it is actually applied (the
    // fallback path has no measured edge to report at all). The generator
    // lands each candidate through its OWN deformation and takes the
    // outermost LANDING, not just the outermost REST pixel, since which part
    // ends up furthest out after the turn can differ from which one drew
    // furthest out at rest. Model x (canvas x minus half the canvas width),
    // matching the generator's own placement of a layer (`boxOfLayer`).
    let headEdges:
      | {
          left: { role: string; x: number }[];
          right: { role: string; x: number }[];
        }
      | undefined;
    if (headHalfWidthApplied) {
      const bandLo = eyeRow - HEAD_BAND;
      const bandHi = eyeRow + HEAD_BAND;
      const left: { role: string; x: number }[] = [];
      const right: { role: string; x: number }[] = [];
      for (const { role, rowLeft, rowRight } of rowSpansByRole) {
        const own = foregroundSpanOfRows(rowLeft, rowRight, bandLo, bandHi);
        if (own.right <= own.left) continue; // no opaque pixel here at all
        left.push({ role, x: own.left - canvasW / 2 });
        right.push({ role, x: own.right - canvasW / 2 });
      }
      headEdges = { left, right };
    }

    // Each iris against the bangs' run it would slide under on the turn, on
    // ONE row — the one holding the iris's centre — under ONE rule (alpha >=
    // ALPHA_OPAQUE), a bangs run narrower than STRAND_MIN_RUN_FRACTION of that
    // iris's row width counting as clear. The iris's alpha-bbox (alpha >= 8, grown by a pixel) only
    // gives that row and where to start scanning, never an edge: every number
    // is the pixel boundary facing the neighbouring clear pixel, less half the
    // canvas, so each is the painted edge the way the generator's crop edges
    // (`boxOfLayer`) are. The scan decides with the very crop centres the
    // generator validates these edges against, so what it measures is always
    // accepted, on either side. A side's iris is whichever sits on that side,
    // the two paired by x rather than by role name. Measured whether or not
    // headHalfWidth is applied: the bound it feeds is the far iris against its
    // own strand, not the head's width.
    let strandEdges: { left?: IrisStrand; right?: IrisStrand } | undefined;
    const irisLayers = layerInputs
      .filter((l) => l.role === "iris_L" || l.role === "iris_R")
      .sort((a, b) => a.bbox.x + a.bbox.w / 2 - (b.bbox.x + b.bbox.w / 2));
    const hairFront = layerInputs.find((l) => l.role === "hair_front");
    const hairRuns = hairFront?.rowRuns;
    if (
      hairFront !== undefined &&
      hairRuns !== undefined &&
      irisLayers.length === 2
    ) {
      const hairTop = hairFront.bbox.y;
      const half = canvasW / 2;
      const strandOn = (
        iris: LayerInput,
        other: LayerInput,
        side: -1 | 1,
      ): IrisStrand | undefined => {
        const r = Math.floor(iris.bbox.y + iris.bbox.h / 2);
        // The iris's crop centre, canvas x (a pixel boundary for an even
        // width, a pixel's middle for an odd one), and the other's in model
        // x — the generator's placement of each (`boxOfLayer`).
        const centre = iris.bbox.x + iris.bbox.w / 2;
        const otherX = other.bbox.x + other.bbox.w / 2 - half;
        // The pixel just on THIS side of that centre: a run covering it
        // reaches outward past the centre, so its outer end is strictly
        // outward of it on either side, which a pixel chosen by one rounding
        // for both sides would not give.
        const c = side < 0 ? Math.ceil(centre) - 1 : Math.floor(centre);
        const span = rowSpansByRole.find((s) => s.role === iris.role)!;
        // An iris with no opaque pixel on its own centre row has no edge.
        if (span.rowRight[r] < span.rowLeft[r]) return undefined;
        // The row's strand pixels: hair_front's opaque runs on it, less every
        // run narrower than STRAND_MIN_RUN_FRACTION of this iris's painted
        // width there, which the whole scan below reads as clear. Runs are
        // judged whole, so the result is the same from either side.
        const minRun =
          STRAND_MIN_RUN_FRACTION * (span.rowRight[r] + 1 - span.rowLeft[r]);
        const strand = new Uint8Array(canvasW);
        // A row outside the bangs' crop has no opaque pixel of theirs.
        const runs =
          r >= hairTop && r < hairTop + hairRuns.length
            ? hairRuns[r - hairTop]
            : [];
        for (let k = 0; k < runs.length; k += 2) {
          if (runs[k + 1] - runs[k] >= minRun) {
            strand.fill(1, runs[k], runs[k + 1]);
          }
        }
        const strandAt = (x: number) =>
          x >= 0 && x < canvasW && strand[x] === 1;
        // The boundary between pixel x and its neighbour one step outward.
        const outerBoundary = (x: number) => (side < 0 ? x : x + 1) - half;
        let x = c;
        let runFace: number | null;
        if (!strandAt(c)) {
          // A clear centre (or one under a thin run only): the first strand
          // pixel outward starts the run, and its face-side boundary is
          // runFace.
          while (x >= 0 && x < canvasW && !strandAt(x)) x += side;
          if (x < 0 || x >= canvasW) return undefined; // no run outward
          runFace = outerBoundary(x - side);
        } else {
          // A covered centre: the run's face-side end is where it clears on
          // the face side — when that is strictly on this side of the other
          // iris's centre. A run still opaque there is a fringe spanning the
          // face, which has no face-side end on this side.
          let f = c - side;
          while (strandAt(f)) f -= side;
          const face = outerBoundary(f);
          runFace = side * (face - otherX) > 0 ? face : null;
        }
        // Outward to the run's outer end: its last opaque pixel's boundary
        // with the first clear one after it, or with the crop's edge.
        while (strandAt(x)) x += side;
        return {
          y: canvasH / 2 - (r + 0.5),
          irisOuter: (side < 0 ? span.rowLeft[r] : span.rowRight[r] + 1) - half,
          irisInner: (side < 0 ? span.rowRight[r] + 1 : span.rowLeft[r]) - half,
          runOuter: outerBoundary(x - side),
          runFace,
        };
      };
      const [low, high] = irisLayers;
      const left = strandOn(low, high, -1);
      const right = strandOn(high, low, 1);
      if (left !== undefined || right !== undefined) {
        strandEdges = {
          ...(left === undefined ? {} : { left }),
          ...(right === undefined ? {} : { right }),
        };
      }
    }

    return {
      layers: layerInputs,
      ...(headHalfWidth === undefined ? {} : { headHalfWidth }),
      headHalfWidthApplied,
      turnOptions: {
        ...(headHalfWidthApplied ? { turnTargets: { headHalfWidth } } : {}),
        ...(headEdges === undefined ? {} : { headEdges }),
        ...(strandEdges === undefined ? {} : { strandEdges }),
      },
    };
  }

  return { add, finish };
}
