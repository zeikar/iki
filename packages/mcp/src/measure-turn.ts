/**
 * Measure the head-turn cues in a PAIR of images of the same character — one
 * facing front, one turned — and report them as three ratios. It is how a
 * rigged turn gets compared to a reference turn without either image being
 * registered to the other: every number below is a front→turned CHANGE, divided
 * by something measured in the same image, so the character's size, crop and
 * framing cancel. Not fully scale-free, though: the head span is sampled over a
 * FIXED ±HEAD_BAND row band, so two images of very different resolution sample
 * different fractions of the head — compare renders at like sizes.
 *
 *   farEyeRatio     how much the far eye narrows, over what it already was at
 *                   rest (a resting asymmetry in the art is divided out)
 *   eyeShift        how far the eye pair slides across the head, in units of
 *                   the FRONT head half-width (hh); negative = toward the
 *                   image's left
 *   silhouetteRatio how much the head narrows, turned over front
 *
 * Read-only over two files; it edits nothing. Ported from the measurement
 * script this repo's turn work ran by hand, so the numbers a rig is tuned
 * against come out of the server every agent already has.
 *
 * `sharp` must stay confined to @ikijs/mcp; the decode and the debug-overlay
 * encode both go through ./node-images, this package's single image boundary.
 */

import path from "node:path";
import { decodePng, encodeOverlayPng } from "./node-images";
import {
  AutoRigInputError,
  resolveInputPath,
  resolveOutputDir,
  writeFileAtomic,
} from "./limits";

/**
 * Hue/saturation window that selects the iris. Anime irises are a saturated
 * colour on a face that is not, which is what makes them findable at all; the
 * default window is violet-to-blue because that is what the characters this was
 * tuned on have. A character with, say, amber eyes passes its own window.
 */
export interface IrisColor {
  /** Inclusive hue bounds in degrees (0..360). */
  hueMin: number;
  hueMax: number;
  /** Minimum HSV saturation (0..1) — separates the iris from the skin. */
  satMin: number;
}

const DEFAULT_IRIS: IrisColor = { hueMin: 230, hueMax: 300, satMin: 0.22 };

// Value window, NOT a parameter: it excludes the specular highlight (near
// white) and the pupil/lash ink (near black) whatever the iris hue is, so the
// blob that survives is the coloured ring itself.
const IRIS_V_MIN = 0.18;
const IRIS_V_MAX = 0.95;
// A blob whose surviving pixels average darker than this is lash ink or a
// shadow that crept through the hue window, not an iris.
const IRIS_MEAN_V_MIN = 0.32;
// The pupil and the specular highlight split the coloured ring into pieces; a
// morphological CLOSE (dilate, then erode by the same radius) welds them back
// into one component WITHOUT moving the blob's edges. A bare dilate would do
// the welding too, but it adds its radius to every width, and that bias does
// not cancel in far/near — it pushes the ratio toward 1 by an amount that
// depends on how many pixels wide the iris happens to be.
const CLOSE_RADIUS = 3;
// ...at the size it was tuned on; a smaller image gets a proportionally smaller
// radius (at least 1 px), the way the area floor below is scaled.
const CLOSE_RADIUS_REFERENCE_PX = 1254;
// An iris is small. Anything wider or taller than this fraction of the image is
// hair, a collar, or the face itself leaking through the hue window.
const BLOB_MAX_FRAC = 0.12;
// Area floor, scaled from the 300 px it was tuned at on a 1254² reference so
// the same physical blob survives on a smaller render.
const MIN_AREA_REFERENCE_PIXELS = 1254 * 1254;
const MIN_AREA = 300;
// Two irises sit apart but level. Below the dx floor is one iris found twice
// (highlight vs ring), above the ceiling is an iris paired with a hair clip.
const PAIR_DX_MIN_FRAC = 0.08;
const PAIR_DX_MAX_FRAC = 0.35;
const PAIR_DY_MAX_FRAC = 0.05;
/** Blobs kept as pair candidates, largest first — the pair search is O(n²). */
const MAX_CANDIDATES = 12;
/** Half-height of the row band the head span is taken over, in px. Fixed at
 *  ±10 rows rather than scaled to the image, and that is the convention: any
 *  other measurement of head width meant to be compared with these — one taken
 *  off layer alpha, a hand script — has to span the same band. */
const HEAD_BAND = 10;

// --- Foreground (silhouette) rule -----------------------------------------
// Two modes, chosen per image, because the two kinds of image this compares
// carry their background differently and neither rule works on both.
//
//   "alpha"  an ENGINE RENDER: transparent backdrop. Foreground is alpha alone
//            — and nothing else. Its character pixels include near-black hair
//            ink and pale lavender highlights, both of which the keyed rule
//            below would eat, and the head would come back narrower than it is.
//            It is also the rule to follow when measuring the same silhouette
//            from the layer PNGs' own alpha, so the two are comparable.
//   "keyed"  a fully opaque REFERENCE: no alpha to read, so the flat
//            lavender-grey backdrop is keyed out by colour instead, along with
//            a near-black frame/letterbox border.
const ALPHA_OPAQUE = 128;
const BG_HUE_MIN = 220;
const BG_HUE_MAX = 260;
const BG_SAT_MAX = 0.2;
const BG_V_MIN = 0.55;
const BG_V_BLACK = 0.03;

/** Connected blob of iris-coloured pixels, in image px. */
export interface IrisBlob {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  w: number;
  h: number;
  area: number;
  cx: number;
  cy: number;
}

/** One image's measurement. `irisL`/`irisR` are ordered by x in the IMAGE. */
export interface TurnImageMeasure {
  file: string;
  width: number;
  height: number;
  maskMode: "alpha" | "keyed";
  irisL: IrisBlob;
  irisR: IrisBlob;
  /** Mean row of the two iris centres. */
  eyeRow: number;
  /** Head silhouette span at the eye row. */
  head: { left: number; right: number; cx: number; half: number };
  /** Mean column of the two iris centres. */
  pairCx: number;
  eyeGap: number;
}

export interface TurnMeasurement {
  front: TurnImageMeasure;
  turned: TurnImageMeasure;
  /** Turned far/near iris width over the same ratio at rest. */
  farEyeRatio: number;
  /** Front→turned slide of the eye pair across the head, in FRONT hh units. */
  eyeShift: number;
  /** Head half-width, turned over front. */
  silhouetteRatio: number;
  /** -1 = the head turned toward the image's left, +1 = toward its right. */
  turnSign: -1 | 1;
  /** Debug overlays written, when `debugDir` was given. */
  debug?: string[];
}

export type MeasureTurnResult =
  | ({ ok: true } & TurnMeasurement)
  | { ok: false; error: string };

export interface MeasureTurnInput {
  /** Front-facing image (relative paths resolve against cwd). */
  front: string;
  /** The same character turned. */
  turned: string;
  /** Iris colour window override, merged over the violet default. */
  iris?: Partial<IrisColor>;
  /** Existing directory to write `<name>.debug.png` overlays into. */
  debugDir?: string;
}

/** HSV of an 8-bit RGB triple: hue in degrees, saturation and value in 0..1. */
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

/** Grow `mask` by `r` px in every direction (square kernel). */
function dilate(
  mask: Uint8Array,
  width: number,
  height: number,
  r: number,
): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy >= 0 && yy < height && xx >= 0 && xx < width)
            out[yy * width + xx] = 1;
        }
      }
    }
  }
  return out;
}

/** Shrink `mask` by `r` px in every direction; outside the image counts as
 *  background. Erosion only ever clears pixels, so set ones are all it visits. */
function erode(
  mask: Uint8Array,
  width: number,
  height: number,
  r: number,
): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      let keep = true;
      for (let dy = -r; dy <= r && keep; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (
            yy < 0 ||
            yy >= height ||
            xx < 0 ||
            xx >= width ||
            !mask[yy * width + xx]
          ) {
            keep = false;
            break;
          }
        }
      }
      if (keep) out[y * width + x] = 1;
    }
  }
  return out;
}

/** Morphological close: weld pieces up to 2r apart, leaving the outer edges
 *  where they were (a closed set never spills past the original's bbox). */
function closeMask(
  mask: Uint8Array,
  width: number,
  height: number,
  r: number,
): Uint8Array {
  return erode(dilate(mask, width, height, r), width, height, r);
}

/** 4-connected components of `mask` with at least `minArea` px, largest first. */
function components(
  mask: Uint8Array,
  width: number,
  height: number,
  minArea: number,
): IrisBlob[] {
  const seen = new Uint8Array(width * height);
  const out: IrisBlob[] = [];
  for (let i = 0; i < width * height; i++) {
    if (!mask[i] || seen[i]) continue;
    const stack = [i];
    seen[i] = 1;
    let x0 = width;
    let x1 = 0;
    let y0 = height;
    let y1 = 0;
    let n = 0;
    let sx = 0;
    let sy = 0;
    while (stack.length) {
      const p = stack.pop() as number;
      const x = p % width;
      const y = (p / width) | 0;
      n++;
      sx += x;
      sy += y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      const neighbours: number[] = [];
      if (x > 0) neighbours.push(p - 1);
      if (x < width - 1) neighbours.push(p + 1);
      if (y > 0) neighbours.push(p - width);
      if (y < height - 1) neighbours.push(p + width);
      for (const q of neighbours) {
        if (seen[q] || !mask[q]) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
    if (n >= minArea) {
      out.push({
        x0,
        x1,
        y0,
        y1,
        w: x1 - x0 + 1,
        h: y1 - y0 + 1,
        area: n,
        cx: sx / n,
        cy: sy / n,
      });
    }
  }
  return out.sort((a, b) => b.area - a.area);
}

/**
 * Outermost set pixels of `mask` across the row band `rowLo..rowHi` (clamped
 * to the image) — the silhouette span at that height. An empty band returns
 * `left > right`; every caller here treats that as an error.
 *
 * Exported for the head measured off the layer PNGs' alpha union, which has to
 * span the head the same way this does or the two cannot be compared.
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

/** Merge a caller's partial iris window over the default, rejecting nonsense. */
function resolveIris(override: Partial<IrisColor> | undefined): IrisColor {
  const iris = { ...DEFAULT_IRIS, ...override };
  if (iris.hueMin < 0 || iris.hueMax > 360 || iris.hueMin >= iris.hueMax) {
    throw new AutoRigInputError(
      `iris hue window must be 0 <= hueMin < hueMax <= 360, got ${iris.hueMin}..${iris.hueMax}`,
    );
  }
  if (iris.satMin < 0 || iris.satMin > 1) {
    throw new AutoRigInputError(
      `iris satMin must be within 0..1, got ${iris.satMin}`,
    );
  }
  return iris;
}

/**
 * Find the iris pair and the head silhouette in one image.
 *
 * Throws a path-qualified AutoRigInputError when no pair survives the filters
 * (the candidate count says whether the hue window found nothing at all or
 * found too much) or when the eye-row band holds no foreground.
 */
async function measureTurnImage(
  filePath: string,
  iris: IrisColor,
): Promise<TurnImageMeasure> {
  const { width, height, rgba, hasAlpha } = await decodePng(filePath);
  const n = width * height;

  // An RGBA file whose alpha is entirely opaque is a reference that merely
  // carries a channel, not a render with a cut-out backdrop — key it by colour.
  let transparent = false;
  if (hasAlpha) {
    for (let i = 0; i < n; i++) {
      if (rgba[i * 4 + 3] < ALPHA_OPAQUE) {
        transparent = true;
        break;
      }
    }
  }
  const maskMode: "alpha" | "keyed" =
    hasAlpha && transparent ? "alpha" : "keyed";

  const irisMask = new Uint8Array(n);
  const fg = new Uint8Array(n);
  const value = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (rgba[i * 4 + 3] < ALPHA_OPAQUE) continue; // transparent = background
    const [hue, s, v] = rgbToHsv(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    if (maskMode === "alpha") {
      fg[i] = 1;
    } else {
      const isBg =
        (hue >= BG_HUE_MIN &&
          hue <= BG_HUE_MAX &&
          s < BG_SAT_MAX &&
          v > BG_V_MIN) ||
        v < BG_V_BLACK;
      if (!isBg) fg[i] = 1;
    }
    if (
      hue >= iris.hueMin &&
      hue <= iris.hueMax &&
      s > iris.satMin &&
      v > IRIS_V_MIN &&
      v < IRIS_V_MAX
    ) {
      irisMask[i] = 1;
      value[i] = v;
    }
  }

  const minArea = Math.max(
    1,
    Math.round((MIN_AREA * n) / MIN_AREA_REFERENCE_PIXELS),
  );
  const closeRadius = Math.max(
    1,
    Math.round(
      (CLOSE_RADIUS * Math.max(width, height)) / CLOSE_RADIUS_REFERENCE_PX,
    ),
  );
  const meanValue = (b: IrisBlob): number => {
    let count = 0;
    let total = 0;
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = b.x0; x <= b.x1; x++) {
        const i = y * width + x;
        if (!irisMask[i]) continue;
        count++;
        total += value[i];
      }
    }
    return count ? total / count : 0;
  };
  const candidates = components(
    closeMask(irisMask, width, height, closeRadius),
    width,
    height,
    minArea,
  )
    .filter((b) => b.w < width * BLOB_MAX_FRAC && b.h < height * BLOB_MAX_FRAC)
    .filter((b) => meanValue(b) > IRIS_MEAN_V_MIN)
    .slice(0, MAX_CANDIDATES);

  let best: { score: number; pair: [IrisBlob, IrisBlob] } | null = null;
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];
      const dx = Math.abs(a.cx - b.cx);
      const dy = Math.abs(a.cy - b.cy);
      if (dx < width * PAIR_DX_MIN_FRAC || dx > width * PAIR_DX_MAX_FRAC)
        continue;
      if (dy > height * PAIR_DY_MAX_FRAC) continue;
      const score = a.area + b.area;
      if (best === null || score > best.score) {
        const pair: [IrisBlob, IrisBlob] = a.cx <= b.cx ? [a, b] : [b, a];
        best = { score, pair };
      }
    }
  }
  if (best === null) {
    throw new AutoRigInputError(
      `no iris pair found in ${filePath} among ${candidates.length} candidate blobs ` +
        `(iris hue ${iris.hueMin}..${iris.hueMax}, sat > ${iris.satMin})`,
    );
  }

  const [irisL, irisR] = best.pair;
  const eyeRow = Math.round((irisL.cy + irisR.cy) / 2);
  const { left, right } = foregroundSpan(
    fg,
    width,
    height,
    eyeRow - HEAD_BAND,
    eyeRow + HEAD_BAND,
  );
  // Every ratio divides by this half-width, so a band that keyed down to
  // nothing (or to a single column) must fail rather than report Infinity.
  if (right <= left) {
    throw new AutoRigInputError(
      `no head span at the eye row (y=${eyeRow}) in ${filePath}: the ${maskMode} foreground mask is empty there`,
    );
  }

  return {
    file: filePath,
    width,
    height,
    maskMode,
    irisL,
    irisR,
    eyeRow,
    head: {
      left,
      right,
      cx: (left + right) / 2,
      half: (right - left) / 2,
    },
    pairCx: (irisL.cx + irisR.cx) / 2,
    eyeGap: irisR.cx - irisL.cx,
  };
}

/**
 * Iris widths split into far and near. FAR = the eye on the side the pair moved
 * TOWARD, which is the one rotating away from the viewer; `turnSign` says which
 * side that is. The measurement and the report must split them the same way, so
 * they share this.
 */
function farNearWidths(
  m: TurnImageMeasure,
  turnSign: -1 | 1,
): { far: number; near: number } {
  return turnSign < 0
    ? { far: m.irisL.w, near: m.irisR.w }
    : { far: m.irisR.w, near: m.irisL.w };
}

/** The overlay: iris boxes, head edges, head centre, pair centre. */
function overlaySvg(m: TurnImageMeasure): string {
  const box = (b: IrisBlob, stroke: string) =>
    `<rect x="${b.x0}" y="${b.y0}" width="${b.w}" height="${b.h}" fill="none" stroke="${stroke}" stroke-width="3"/>`;
  const tick = (x: number, half: number, stroke: string) =>
    `<line x1="${x}" y1="${m.eyeRow - half}" x2="${x}" y2="${m.eyeRow + half}" stroke="${stroke}" stroke-width="3"/>`;
  return (
    `<svg width="${m.width}" height="${m.height}">` +
    box(m.irisL, "#ff0000") +
    box(m.irisR, "#00c000") +
    tick(m.head.left, 40, "#0000ff") +
    tick(m.head.right, 40, "#0000ff") +
    tick(m.head.cx, 60, "#ff8800") +
    tick(m.pairCx, 60, "#ff00ff") +
    "</svg>"
  );
}

/** `label` prefixes the file name: the two inputs often share a basename
 *  (`renders/head.png` + `ref/head.png`), and one would overwrite the other. */
async function writeOverlay(
  debugDir: string,
  label: "front" | "turned",
  m: TurnImageMeasure,
): Promise<string> {
  const outPath = path.join(
    debugDir,
    `${label}-${path.basename(m.file, ".png")}.debug.png`,
  );
  writeFileAtomic(outPath, await encodeOverlayPng(m.file, overlaySvg(m)));
  return outPath;
}

/**
 * Measure a front/turned image pair and report the three turn ratios plus both
 * raw per-image measurements.
 *
 * Error boundary: ONLY AutoRigInputError (caller input / filesystem) →
 * `{ ok:false }`, matching measureLayers; any other throw propagates.
 */
export async function measureTurnReference(
  input: MeasureTurnInput,
): Promise<MeasureTurnResult> {
  try {
    const iris = resolveIris(input.iris);
    const frontPath = resolveInputPath(input.front);
    const turnedPath = resolveInputPath(input.turned);
    // Resolve the debug dir before measuring (fail-fast): a missing or escaping
    // target should not cost two full decodes first.
    const debugDir =
      input.debugDir === undefined ? null : resolveOutputDir(input.debugDir);

    const front = await measureTurnImage(frontPath, iris);
    const turned = await measureTurnImage(turnedPath, iris);

    // Where the eye pair sits on the head, per image; the CHANGE is the turn.
    const frontShift = front.pairCx - front.head.cx;
    const turnedShift = turned.pairCx - turned.head.cx;
    const shift = turnedShift - frontShift;
    // A pair that did not move has no far side, so there is no third value the
    // far/near rule below could use: treat a zero shift as a right turn, where
    // the ratio reads ~1 from either assignment anyway.
    const turnSign: -1 | 1 = shift < 0 ? -1 : 1;
    // Dividing the turned far/near by the same ratio at rest cancels a resting
    // asymmetry in the art, so what is left is the turn alone.
    const f = farNearWidths(front, turnSign);
    const t = farNearWidths(turned, turnSign);

    const debug =
      debugDir === null
        ? undefined
        : [
            await writeOverlay(debugDir, "front", front),
            await writeOverlay(debugDir, "turned", turned),
          ];

    return {
      ok: true,
      front,
      turned,
      farEyeRatio: t.far / t.near / (f.far / f.near),
      eyeShift: shift / front.head.half,
      silhouetteRatio: turned.head.half / front.head.half,
      turnSign,
      ...(debug === undefined ? {} : { debug }),
    };
  } catch (err) {
    if (err instanceof AutoRigInputError)
      return { ok: false, error: err.message };
    throw err;
  }
}

const n1 = (v: number) => v.toFixed(1);
const n3 = (v: number) => v.toFixed(3);

/** One image's raw block: what the ratios above were computed from. */
function imageBlock(label: string, m: TurnImageMeasure): string[] {
  return [
    `# ${label}  ${m.file}  ${m.width}x${m.height}  mask: ${m.maskMode}`,
    `iris widths ${m.irisL.w} / ${m.irisR.w} px   centres ${n1(m.irisL.cx)} / ${n1(m.irisR.cx)}   ` +
      `eye row ${m.eyeRow}   gap ${n1(m.eyeGap)}`,
    `head ${m.head.left}..${m.head.right}   centre ${n1(m.head.cx)}   half ${n1(m.head.half)}   ` +
      `pair centre ${n1(m.pairCx)}`,
  ];
}

/** Render a measurement as plain text: the three ratios with the raw numbers
 *  behind each, then one block per image. */
export function formatTurnReport(result: TurnMeasurement): string {
  const { front, turned } = result;
  const f = farNearWidths(front, result.turnSign);
  const t = farNearWidths(turned, result.turnSign);
  const lines = [
    `farEyeRatio      ${n3(result.farEyeRatio)}   far/near iris width ${t.far}/${t.near} turned ` +
      `over ${f.far}/${f.near} front`,
    `eyeShift         ${n3(result.eyeShift)}   pair-vs-head centre ${n1(turned.pairCx - turned.head.cx)} px turned, ` +
      `${n1(front.pairCx - front.head.cx)} px front, over front head half ${n1(front.head.half)} px (hh)`,
    `silhouetteRatio  ${n3(result.silhouetteRatio)}   head half ${n1(turned.head.half)} px turned over ` +
      `${n1(front.head.half)} px front`,
    `turnSign         ${result.turnSign}   (the head turned toward the image's ${
      result.turnSign < 0 ? "left" : "right"
    })`,
    "",
    ...imageBlock("front", front),
    "",
    ...imageBlock("turned", turned),
  ];
  if (result.debug !== undefined) {
    lines.push("", ...result.debug.map((p) => `debug overlay ${p}`));
  }
  return lines.join("\n");
}
