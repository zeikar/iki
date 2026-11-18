/**
 * One finished character picture on the layer canvas, and the raster helpers
 * an in-place cut of it is built from.
 *
 * Frame: canvas px, origin top-left, x right, y down, CANVAS wide and as tall
 * as the picture's aspect gives — the frame of the layer PNGs the cut writes,
 * so a landmark read off `view_illustration_grid` lands on the same pixel here.
 *
 * Masks are one byte per canvas pixel, row-major, 1 on and 0 off. A point
 * `[x, y]` names the pixel at column x, row y.
 */

import sharp from "sharp";
import { CANVAS } from "./compose";
import {
  AutoRigInputError,
  MAX_CANVAS_DIM,
  MAX_INPUT_PIXELS,
  resolveInputPath,
} from "./limits";

export type Point = [number, number];
/** `[x0, y0, x1, y1]`, both corners inside: columns x0..x1, rows y0..y1. */
export type Box = [number, number, number, number];
export type Mask = Uint8Array;

/** What every helper needs to index a canvas-sized buffer. */
export interface CanvasSize {
  width: number;
  height: number;
}

export interface Illustration extends CanvasSize {
  /** The paint's own colour, 3 floats per pixel in 0..255: a soft edge's
   *  colour with the backdrop taken back out of it. */
  rgb: Float32Array;
  /** Coverage, 0..1 per pixel. */
  alpha: Float32Array;
  /** `transparent`: the file's own alpha. `flat`: an opaque picture whose
   *  backdrop colour was keyed out. */
  background: "transparent" | "flat";
  /** The keyed backdrop colour, on a `flat` picture. */
  backdrop?: [number, number, number];
}

/** The picture scaled onto the canvas, straight-alpha RGBA bytes. */
export interface CanvasPicture extends CanvasSize {
  rgba: Buffer;
  /** Canvas px per source px: how far the scale spread a soft edge. */
  scale: number;
}

export interface LoadIllustrationOptions {
  /** Points on backdrop the figure encloses (a gap between an arm and the
   *  body), each keyed like the backdrop around the figure. Used on a picture
   *  with a flat backdrop only. */
  backgroundSeeds?: Point[];
}

/** Formats a finished picture comes in; anything else sharp could open
 *  (an SVG that might pull in other files, a PDF) is refused. */
const PICTURE_FORMATS = new Set(["png", "jpeg", "webp"]);

/**
 * Decode `imagePath`, turn it upright by its EXIF orientation and scale it to
 * CANVAS wide (Lanczos), its height by the picture's aspect. Refuses a missing
 * file, another format, a picture over MAX_INPUT_PIXELS and one whose canvas
 * would be over MAX_CANVAS_DIM tall.
 */
export async function readPictureOnCanvas(
  imagePath: string,
): Promise<CanvasPicture> {
  const file = resolveInputPath(imagePath, "picture");
  let meta: sharp.Metadata;
  try {
    meta = await sharp(file).metadata();
  } catch (e) {
    throw new AutoRigInputError(
      `failed to read picture ${file}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!PICTURE_FORMATS.has(meta.format ?? "")) {
    throw new AutoRigInputError(
      `picture must be a PNG, JPEG or WebP, not ${meta.format ?? "unknown"}: ${file}`,
    );
  }
  // EXIF orientations 5 to 8 turn the picture a quarter: its upright width is
  // the stored height.
  const quarter = (meta.orientation ?? 1) >= 5;
  const w = (quarter ? meta.height : meta.width) ?? 0;
  const h = (quarter ? meta.width : meta.height) ?? 0;
  if (w * h > MAX_INPUT_PIXELS) {
    throw new AutoRigInputError(
      `picture is ${w}x${h} = ${w * h} px, over the ${MAX_INPUT_PIXELS} px limit: ${file}`,
    );
  }
  const height = Math.max(1, Math.round((h * CANVAS) / w));
  if (height > MAX_CANVAS_DIM) {
    throw new AutoRigInputError(
      `picture is ${w}x${h}; at ${CANVAS} px wide its canvas would be ${height} px tall, over ${MAX_CANVAS_DIM}: ${file}`,
    );
  }
  try {
    const { data } = await sharp(file, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize(CANVAS, height, { fit: "fill", kernel: "lanczos3" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { width: CANVAS, height, rgba: data, scale: CANVAS / w };
  } catch (e) {
    throw new AutoRigInputError(
      `failed to decode picture ${file}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** A picture with at least this share of its pixels under half alpha has
 *  real transparency and keeps it; below it (a stray clear speck on an opaque
 *  picture) the backdrop is keyed. */
const TRANSPARENT_SHARE = 0.005;
/** How deep into the picture the border ring reaches, px. */
const RING = 4;
/** Euclidean RGB distance a ring pixel may sit from the backdrop's colour and
 *  still be the backdrop: a JPEG's noise of a few levels per channel. */
const FLAT_TOLERANCE = 12;
/** Share of the border ring that must be the backdrop. The figure may cross
 *  the frame (a bust's chest, long hair), but a two-colour or gradient
 *  background leaves no one colour on most of the ring. */
const MIN_BACKDROP_SHARE = 0.6;
/** Euclidean RGB distance from the backdrop under which a pixel is no paint
 *  at all: the noise floor, keyed to alpha 0. */
const KEY_T0 = 14;
/** Euclidean RGB distance from the backdrop under which a pixel may still be
 *  backdrop: the key floods the backdrop through pixels under it, and paint
 *  at or past it is the solid core whose colour the soft edge is measured
 *  against. Worked on the picture the in-place cut was first tried on. */
const KEY_T1 = 50;
/** Below this alpha a pixel takes the paint colour beside it rather than its
 *  own with the backdrop taken out: dividing by a near zero alpha amplifies
 *  noise into colours the paint never had. */
const DECONTAM_MIN_ALPHA = 0.05;

/** The pixel indices of the ring RING px in from every edge. */
function borderRing({ width, height }: CanvasSize): number[] {
  const out: number[] = [];
  for (let y = 0; y < height; y++) {
    const edgeRow = y < RING || y >= height - RING;
    for (let x = 0; x < width; x++) {
      if (edgeRow || x < RING || x >= width - RING) out.push(y * width + x);
    }
  }
  return out;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/**
 * Load a picture onto the canvas with its background matted out. A picture
 * with real transparency keeps its own alpha. An opaque one must stand on one
 * flat colour, measured on its border ring (a ring that is not is refused,
 * naming what it measured). The backdrop is what a flood from the border (and
 * from each of `backgroundSeeds`) reaches through pixels near its colour, so
 * paint of the backdrop's colour inside the figure (white eyes on a white
 * ground) stays. On the backdrop and the few px of paint beside it, alpha is
 * how far a pixel lies from the backdrop toward the paint beside it, and the
 * backdrop is taken back out of it (`F = (C - (1 - a) B) / a`).
 */
export async function loadIllustration(
  imagePath: string,
  options: LoadIllustrationOptions = {},
): Promise<Illustration> {
  const pic = await readPictureOnCanvas(imagePath);
  const { width, height, rgba } = pic;
  const n = width * height;
  const rgb = new Float32Array(n * 3);
  const srcAlpha = new Float32Array(n);
  let clear = 0;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) rgb[i * 3 + c] = rgba[i * 4 + c];
    srcAlpha[i] = rgba[i * 4 + 3] / 255;
    if (srcAlpha[i] < 0.5) clear++;
  }
  if (clear / n >= TRANSPARENT_SHARE) {
    return { width, height, rgb, alpha: srcAlpha, background: "transparent" };
  }

  const ring = borderRing(pic);
  const opaqueRing = ring.filter((i) => srcAlpha[i] >= 0.5);
  const backdrop = [0, 1, 2].map((c) =>
    median(opaqueRing.map((i) => rgb[i * 3 + c])),
  ) as [number, number, number];
  const dist = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    dist[i] = Math.hypot(
      rgb[i * 3] - backdrop[0],
      rgb[i * 3 + 1] - backdrop[1],
      rgb[i * 3 + 2] - backdrop[2],
    );
  }
  const flatShare =
    opaqueRing.filter((i) => dist[i] <= FLAT_TOLERANCE).length / ring.length;
  if (flatShare < MIN_BACKDROP_SHARE) {
    throw new AutoRigInputError(
      `picture's backdrop is not one flat colour: ${Math.round(flatShare * 100)}% of its ${RING} px border ring is within ${FLAT_TOLERANCE} of its median colour rgb(${backdrop.map(Math.round).join(", ")}), and at least ${MIN_BACKDROP_SHARE * 100}% must be; give the picture on one flat colour or with a transparent background`,
    );
  }

  const soft = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    soft[i] = dist[i] < KEY_T1 || srcAlpha[i] < 0.5 ? 1 : 0;
  }
  const seeds = [...ring];
  (options.backgroundSeeds ?? []).forEach(([sx, sy], k) => {
    const x = Math.round(sx);
    const y = Math.round(sy);
    if (!(x >= 0 && y >= 0 && x < width && y < height)) {
      throw new AutoRigInputError(
        `backgroundSeeds[${k}] (${sx}, ${sy}) is off the ${width}x${height} canvas`,
      );
    }
    const i = y * width + x;
    if (!soft[i]) {
      throw new AutoRigInputError(
        `backgroundSeeds[${k}] (${sx}, ${sy}) is on paint, not backdrop: its colour is ${Math.round(dist[i])} from the backdrop rgb(${backdrop.map(Math.round).join(", ")}), and a seed must be under ${KEY_T1}`,
      );
    }
    seeds.push(i);
  });
  const reached = floodFromIndices(pic, soft, seeds);

  // A soft edge spreads over about a source pixel, so the paint beside the
  // backdrop is read past that many canvas px of it.
  const edgeReach = Math.ceil(Math.max(1, pic.scale)) + 1;
  const near = dilate(pic, reached, edgeReach);
  const core = new Uint8Array(n);
  for (let i = 0; i < n; i++) core[i] = !near[i] && dist[i] >= KEY_T1 ? 1 : 0;
  const paint = pushPull(pic, rgb, core);

  const alpha = new Float32Array(srcAlpha);
  for (let i = 0; i < n; i++) {
    // The backdrop and the paint's edge beside it; pale paint the flood did
    // not reach stays as drawn even there (behind a thin line).
    if (!near[i] || (!reached[i] && dist[i] < KEY_T1)) continue;
    if (dist[i] < KEY_T0) {
      alpha[i] = 0;
      continue;
    }
    // The pixel's share of the way from the backdrop to the paint beside it,
    // projected on that line so a resampling ring on the backdrop's far side
    // reads as backdrop. Paint about as pale as the backdrop is measured
    // against KEY_T1 instead, where the line has no length to divide by.
    let along = 0;
    let span2 = 0;
    for (let c = 0; c < 3; c++) {
      const d = paint[i * 3 + c] - backdrop[c];
      along += (rgb[i * 3 + c] - backdrop[c]) * d;
      span2 += d * d;
    }
    const span = Math.sqrt(span2);
    const a = Math.max(0, Math.min(1, along / (span * Math.max(span, KEY_T1))));
    for (let c = 0; c < 3; c++) {
      rgb[i * 3 + c] =
        a > DECONTAM_MIN_ALPHA
          ? Math.max(
              0,
              Math.min(255, (rgb[i * 3 + c] - (1 - a) * backdrop[c]) / a),
            )
          : paint[i * 3 + c];
    }
    alpha[i] = a * srcAlpha[i];
  }
  return { width, height, rgb, alpha, background: "flat", backdrop };
}

// ---- raster helpers ----

/**
 * The pixels inside a polygon: a pixel is in when its centre
 * `(x + 0.5, y + 0.5)` is, by the even-odd rule, a centre on a left or top
 * edge in and one on a right or bottom edge out. The square from `[0, 0]` to
 * `[4, 4]` covers columns 0..3 and rows 0..3.
 */
export function polygonMask(size: CanvasSize, points: readonly Point[]): Mask {
  const { width, height } = size;
  const m = new Uint8Array(width * height);
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const [, y] of points) {
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  const top = Math.max(0, Math.floor(y0));
  const bottom = Math.min(height - 1, Math.ceil(y1));
  for (let y = top; y <= bottom; y++) {
    const yc = y + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const [ax, ay] = points[i];
      const [bx, by] = points[(i + 1) % points.length];
      if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) {
        xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      // Centres x + 0.5 in [xs[k], xs[k + 1]).
      const from = Math.max(0, Math.ceil(xs[k] - 0.5));
      const to = Math.min(width - 1, Math.ceil(xs[k + 1] - 0.5) - 1);
      for (let x = from; x <= to; x++) m[y * width + x] = 1;
    }
  }
  return m;
}

/** The pixels of a box, both corners included, clipped to the canvas. */
export function boxMask(size: CanvasSize, [x0, y0, x1, y1]: Box): Mask {
  const { width, height } = size;
  const m = new Uint8Array(width * height);
  const left = Math.max(0, Math.ceil(x0));
  const right = Math.min(width - 1, Math.floor(x1));
  const bottom = Math.min(height - 1, Math.floor(y1));
  for (let y = Math.max(0, Math.ceil(y0)); y <= bottom; y++) {
    for (let x = left; x <= right; x++) m[y * width + x] = 1;
  }
  return m;
}

/** Grow a mask by a Chebyshev radius `r` (a square), in two separable passes. */
export function dilate(size: CanvasSize, m: Mask, r: number): Mask {
  const { width, height } = size;
  const t = new Uint8Array(width * height);
  const o = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let run = -Infinity;
    for (let x = 0; x < width; x++) {
      if (m[row + x]) run = x;
      if (x - run <= r) t[row + x] = 1;
    }
    run = Infinity;
    for (let x = width - 1; x >= 0; x--) {
      if (m[row + x]) run = x;
      if (run - x <= r) t[row + x] = 1;
    }
  }
  for (let x = 0; x < width; x++) {
    let run = -Infinity;
    for (let y = 0; y < height; y++) {
      if (t[y * width + x]) run = y;
      if (y - run <= r) o[y * width + x] = 1;
    }
    run = Infinity;
    for (let y = height - 1; y >= 0; y--) {
      if (t[y * width + x]) run = y;
      if (run - y <= r) o[y * width + x] = 1;
    }
  }
  return o;
}

function invert(m: Mask): Mask {
  return m.map((v) => (v ? 0 : 1));
}

/** Shrink a mask by a Chebyshev radius `r`; off-canvas counts as on, so a
 *  mask touching the edge does not shrink away from it. */
export function erode(size: CanvasSize, m: Mask, r: number): Mask {
  return invert(dilate(size, invert(m), r));
}

/** 4-connected flood over `pass` from pixel indices. */
function floodFromIndices(
  { width, height }: CanvasSize,
  pass: Mask,
  seeds: Iterable<number>,
): Mask {
  const out = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  for (const i of seeds) {
    if (pass[i] && !out[i]) {
      out[i] = 1;
      queue[tail++] = i;
    }
  }
  const visit = (j: number) => {
    if (pass[j] && !out[j]) {
      out[j] = 1;
      queue[tail++] = j;
    }
  };
  while (head < tail) {
    const i = queue[head++];
    const x = i % width;
    if (x > 0) visit(i - 1);
    if (x < width - 1) visit(i + 1);
    if (i >= width) visit(i - width);
    if (i < (height - 1) * width) visit(i + width);
  }
  return out;
}

/** 4-connected flood over `pass` from seed points; a seed off the canvas or
 *  off `pass` starts nothing. */
export function flood(
  size: CanvasSize,
  pass: Mask,
  seeds: readonly Point[],
): Mask {
  const idx: number[] = [];
  for (const [sx, sy] of seeds) {
    const x = Math.round(sx);
    const y = Math.round(sy);
    if (x >= 0 && y >= 0 && x < size.width && y < size.height) {
      idx.push(y * size.width + x);
    }
  }
  return floodFromIndices(size, pass, idx);
}

/** The mask with every hole closed: off pixels no 4-connected path of off
 *  pixels joins to the canvas's edge. */
export function fillHoles(size: CanvasSize, m: Mask): Mask {
  const { width, height } = size;
  const edge: number[] = [];
  for (let x = 0; x < width; x++) edge.push(x, (height - 1) * width + x);
  for (let y = 0; y < height; y++) edge.push(y * width, y * width + width - 1);
  return invert(floodFromIndices(size, invert(m), edge));
}

/**
 * Each pixel takes the value most of its (2r+1)² window has, the window cut
 * at the canvas's edge (a tie is off). Removes speckle between two labels.
 */
export function majority(size: CanvasSize, m: Mask, r: number): Mask {
  const { width, height } = size;
  const w1 = width + 1;
  // Summed-area table: any window's count in four reads, whatever r is.
  const sum = new Int32Array(w1 * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += m[y * width + x];
      sum[(y + 1) * w1 + x + 1] = sum[y * w1 + x + 1] + row;
    }
  }
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const ya = Math.max(0, y - r);
    const yb = Math.min(height, y + r + 1);
    for (let x = 0; x < width; x++) {
      const xa = Math.max(0, x - r);
      const xb = Math.min(width, x + r + 1);
      const on =
        sum[yb * w1 + xb] -
        sum[ya * w1 + xb] -
        sum[yb * w1 + xa] +
        sum[ya * w1 + xa];
      out[y * width + x] = on * 2 > (yb - ya) * (xb - xa) ? 1 : 0;
    }
  }
  return out;
}

/**
 * Push-pull fill. Where `known` is above 0 a colour stays as it is (`known`
 * weighs it into the coarser levels); the rest is read, bilinearly, off a
 * half-size level made of the known colours, recursively, so a hole takes
 * the colours around it, smoothly, however wide it is. With no known pixel
 * at all there is nothing to fill from, and `rgb` comes back unchanged.
 */
export function pushPull(
  size: CanvasSize,
  rgb: Float32Array,
  known: ArrayLike<number>,
): Float32Array {
  const { width: w, height: h } = size;
  let any = false;
  for (let i = 0; i < w * h && !any; i++) any = known[i] > 0;
  if (!any) return new Float32Array(rgb);
  if (w <= 2 || h <= 2) return fillFromMean(rgb, known, w * h);
  const w2 = (w + 1) >> 1;
  const h2 = (h + 1) >> 1;
  const c2 = new Float32Array(w2 * h2 * 3);
  const k2 = new Float32Array(w2 * h2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = known[y * w + x];
      if (!(k > 0)) continue;
      const j = (y >> 1) * w2 + (x >> 1);
      k2[j] += k;
      for (let c = 0; c < 3; c++) c2[j * 3 + c] += rgb[(y * w + x) * 3 + c] * k;
    }
  }
  for (let j = 0; j < w2 * h2; j++) {
    if (k2[j] > 0) {
      for (let c = 0; c < 3; c++) c2[j * 3 + c] /= k2[j];
      k2[j] = 1;
    }
  }
  const f2 = pushPull({ width: w2, height: h2 }, c2, k2);
  const out = new Float32Array(rgb);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (known[y * w + x] > 0) continue;
      const fx = Math.min(w2 - 1, Math.max(0, (x - 0.5) / 2));
      const fy = Math.min(h2 - 1, Math.max(0, (y - 0.5) / 2));
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(w2 - 1, x0 + 1);
      const y1 = Math.min(h2 - 1, y0 + 1);
      const tx = fx - x0;
      const ty = fy - y0;
      for (let c = 0; c < 3; c++) {
        const top =
          f2[(y0 * w2 + x0) * 3 + c] * (1 - tx) +
          f2[(y0 * w2 + x1) * 3 + c] * tx;
        const bottom =
          f2[(y1 * w2 + x0) * 3 + c] * (1 - tx) +
          f2[(y1 * w2 + x1) * 3 + c] * tx;
        out[(y * w + x) * 3 + c] = top * (1 - ty) + bottom * ty;
      }
    }
  }
  return out;
}

/** The coarsest level: an unknown pixel takes the known pixels' mean (there
 *  is one), so a level with no source nearby still reads a picture colour. */
function fillFromMean(
  rgb: Float32Array,
  known: ArrayLike<number>,
  n: number,
): Float32Array {
  const mean = [0, 0, 0];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const k = known[i];
    if (!(k > 0)) continue;
    total += k;
    for (let c = 0; c < 3; c++) mean[c] += rgb[i * 3 + c] * k;
  }
  const out = new Float32Array(rgb);
  for (let i = 0; i < n; i++) {
    if (known[i] > 0) continue;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = mean[c] / total;
  }
  return out;
}
