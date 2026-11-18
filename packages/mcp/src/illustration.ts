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
  /** The same picture upright at its own size, straight-alpha RGBA bytes:
   *  what a flat backdrop is keyed on, before the resize spreads its edges. */
  source: CanvasSize & { rgba: Buffer };
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
 * CANVAS wide (Lanczos), its height by the picture's aspect, keeping the
 * upright picture at its own size beside it. Refuses a missing file, another
 * format, a picture over MAX_INPUT_PIXELS and one whose canvas would be over
 * MAX_CANVAS_DIM tall.
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
  let source: CanvasPicture["source"];
  try {
    const { data, info } = await sharp(file, {
      limitInputPixels: MAX_INPUT_PIXELS,
    })
      .rotate()
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    source = { width: info.width, height: info.height, rgba: data };
  } catch (e) {
    throw new AutoRigInputError(
      `failed to decode picture ${file}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const rgba = await toCanvas(source, height);
  return { width: CANVAS, height, rgba, source };
}

/** Straight-alpha RGBA bytes scaled to CANVAS x `height` (Lanczos3, which
 *  sharp runs on premultiplied colour, so clear pixels lend none). */
async function toCanvas(
  { width, height: h, rgba }: CanvasPicture["source"],
  height: number,
): Promise<Buffer> {
  return sharp(rgba, { raw: { width, height: h, channels: 4 } })
    .resize(CANVAS, height, { fit: "fill", kernel: "lanczos3" })
    .raw()
    .toBuffer();
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
/** Euclidean RGB distance from the backdrop under which backdrop beside
 *  paint that mixes with no one paint is no paint at all: the noise floor,
 *  keyed to alpha 0. Without it a JPEG's noise beside the figure would key
 *  as faint specks of paint. */
const KEY_T0 = 14;
/** Euclidean RGB distance a pixel may sit off the line from the backdrop to
 *  a paint beside it and still be a mix of the two, at its share `t` of that
 *  paint: ROUNDING + MIX_TOLERANCE * t. Over the pixel's own rounding and a
 *  flat paint's grain at its share; under what a sliver of a second paint
 *  moves it: looser, an outline's inner px (a tenth pale beside the ink)
 *  reads as ink with the backdrop showing through, and a thin line on a
 *  mid-tone ground comes out partly clear. */
const MIX_TOLERANCE = 4;
/** A PNG's rounding of a pixel, under one level per channel: tighter, the
 *  faint outer px of an antialiased edge (whose share is too small for
 *  MIX_TOLERANCE to cover it) mixes with nothing. */
const ROUNDING = 1;
/** The key floods the backdrop only through pixels under this distance, and
 *  paint at or past it is what a soft edge is measured against. Worked on
 *  the picture the in-place cut was first tried on; flooding further runs
 *  into pale paint with no outline (a peach disc on white) and keys all of
 *  it partly clear. */
const KEY_FLOOD = 32;
/** Picture px a soft edge may take to climb from the backdrop to its paint:
 *  an antialiased edge takes one, a soft-shaded lineless edge about six. A
 *  wider ramp keys partly as paint (its outer px measured against its
 *  middle), and backdrop further than this from paint is clear however far
 *  its colour drifts (a gradient, a soft shadow). */
const RAMP = 6;
/** How much further toward its paint (Euclidean RGB, along the line from
 *  the backdrop) a pixel beside a step of a ramp, and no nearer the
 *  backdrop, must lie for the ramp to go on climbing: over a PNG's
 *  rounding, under one step of a soft edge. A pixel with no such neighbour
 *  is the paint the ramp ends on, opaque. Without it the rim of a flat
 *  region beside a darker paint of its own hue (black hair beside its
 *  shadow) reads as a step toward that paint and comes out partly clear. */
const CLIMB = 3;
/** Below this alpha a pixel takes the colour the resize carried from the
 *  keyed picture rather than its own with the backdrop taken out: dividing
 *  by a near zero alpha amplifies noise into colours the paint never had. */
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

/** The median of `values` (the upper one of an even count). */
export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/**
 * Load a picture onto the canvas with its background matted out. A picture
 * with real transparency keeps its own alpha. An opaque one must stand on one
 * flat colour, measured on the canvas's border ring (a ring that is not is
 * refused, naming what it measured), and is keyed at its own size, before
 * the resize: there an edge is at most a few px of mix between the backdrop
 * and one paint, and the resize then spreads the keyed alpha exactly as it
 * spread the drawn edge, its overshoot past the edge clipped to clear (see
 * {@link keySource}). The backdrop is what a flood from the border (and from
 * each of `backgroundSeeds`) reaches through pixels near its colour, so paint
 * of the backdrop's colour inside the figure (white eyes on a white ground)
 * stays. The backdrop is taken back out of each soft pixel's colour
 * (`F = (C - (1 - a) B) / a`), so the keyed picture over its backdrop gives
 * the picture back.
 */
export async function loadIllustration(
  imagePath: string,
  options: LoadIllustrationOptions = {},
): Promise<Illustration> {
  return matteIllustration(await readPictureOnCanvas(imagePath), options);
}

/** {@link loadIllustration} on a picture already on the canvas. */
export async function matteIllustration(
  pic: CanvasPicture,
  options: LoadIllustrationOptions = {},
): Promise<Illustration> {
  const { width, height, rgba, source } = pic;
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
  const flatShare =
    opaqueRing.filter((i) => offBackdrop(rgba, i, backdrop) <= FLAT_TOLERANCE)
      .length / ring.length;
  if (flatShare < MIN_BACKDROP_SHARE) {
    throw new AutoRigInputError(
      `picture's backdrop is not one flat colour: ${Math.round(flatShare * 100)}% of its ${RING} px border ring is within ${FLAT_TOLERANCE} of its median colour rgb(${backdrop.map(Math.round).join(", ")}), and at least ${MIN_BACKDROP_SHARE * 100}% must be; give the picture on one flat colour or with a transparent background`,
    );
  }

  // Each seed starts the flood at the picture pixel under its canvas pixel.
  const seeds = (options.backgroundSeeds ?? []).map(([sx, sy], k) => {
    const x = Math.round(sx);
    const y = Math.round(sy);
    if (!(x >= 0 && y >= 0 && x < width && y < height)) {
      throw new AutoRigInputError(
        `backgroundSeeds[${k}] (${sx}, ${sy}) is off the ${width}x${height} canvas`,
      );
    }
    const { i, dist, ok } = backdropSeed(pic, backdrop, x, y);
    if (!ok) {
      throw new AutoRigInputError(
        `backgroundSeeds[${k}] (${sx}, ${sy}) is on paint, not backdrop: its colour is ${Math.round(dist)} from the backdrop rgb(${backdrop.map(Math.round).join(", ")}), and a seed must be under ${KEY_FLOOD}`,
      );
    }
    return i;
  });

  const keyed = await toCanvas(
    { ...source, rgba: keySource(source, backdrop, seeds) },
    height,
  );
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = keyed[i * 4 + 3] / 255;
    alpha[i] = a;
    // Clear (the backdrop) keeps its own colour; opaque is the picture's.
    if (a === 0 || a === 1) continue;
    for (let c = 0; c < 3; c++) {
      rgb[i * 3 + c] =
        a > DECONTAM_MIN_ALPHA
          ? Math.max(
              0,
              Math.min(255, (rgb[i * 3 + c] - (1 - a) * backdrop[c]) / a),
            )
          : keyed[i * 4 + c];
    }
  }
  return { width, height, rgb, alpha, background: "flat", backdrop };
}

/**
 * The rule a `backgroundSeeds` point is held to, at canvas pixel (x, y),
 * integers on the canvas: the picture pixel under it at the picture's own
 * size (`i`, where it starts the key's flood) must be under KEY_FLOOD from
 * the backdrop (`dist`), or under half alpha.
 */
export function backdropSeed(
  { width, height, source }: CanvasPicture,
  backdrop: readonly number[],
  x: number,
  y: number,
): { i: number; dist: number; ok: boolean } {
  const px = Math.min(
    source.width - 1,
    Math.floor(((x + 0.5) * source.width) / width),
  );
  const py = Math.min(
    source.height - 1,
    Math.floor(((y + 0.5) * source.height) / height),
  );
  const i = py * source.width + px;
  const dist = offBackdrop(source.rgba, i, backdrop);
  return { i, dist, ok: dist < KEY_FLOOD || source.rgba[i * 4 + 3] < 128 };
}

/** Fill `out` with the in-picture 8-neighbours of pixel `i`; how many. */
function neighbours8(
  { width, height }: CanvasSize,
  i: number,
  out: Int32Array,
): number {
  const x = i % width;
  const y = (i - x) / width;
  let k = 0;
  for (let dy = -1; dy <= 1; dy++) {
    if (y + dy < 0 || y + dy >= height) continue;
    for (let dx = -1; dx <= 1; dx++) {
      if ((dx || dy) && x + dx >= 0 && x + dx < width) {
        out[k++] = i + dy * width + dx;
      }
    }
  }
  return k;
}

/** Euclidean RGB distance of RGBA pixel `i` from `backdrop`. */
function offBackdrop(
  rgba: Uint8Array,
  i: number,
  backdrop: readonly number[],
): number {
  return Math.hypot(
    rgba[i * 4] - backdrop[0],
    rgba[i * 4 + 1] - backdrop[1],
    rgba[i * 4 + 2] - backdrop[2],
  );
}

/**
 * Key `backdrop` out of the picture at its own size: straight-alpha RGBA
 * bytes, the paint's colour with the backdrop taken out.
 *
 * Keyed here, before the resize, an edge is a step from the backdrop to one
 * paint over at most a few px, and nothing rings past it; the resize then
 * spreads the keyed alpha as it spread the edge, and clips its overshoot
 * past the edge to clear. (Keyed after the resize, that overshoot lies on
 * the far side of the backdrop from the paint, and a rule that keeps a dark
 * line beside pale paint on a mid-tone ground opaque cannot also key it
 * clear: the line lies on that far side too.)
 *
 * The rule: the flood's backdrop is clear and the rest is opaque paint,
 * except a pixel that is a step of a ramp from the backdrop to a paint
 * further in, which takes its share of the way. A pixel is a mix with the
 * share `t` of paint Q (a pixel within RAMP px) when it lies on the line from
 * the backdrop to Q, at `t` along it (see MIX_TOLERANCE); of the paints it
 * mixes with, the one furthest out gives its share (on a soft-shaded edge
 * that is the flat paint the ramp ends on, not the next step of the ramp).
 * On the paint side it must also be a step: a neighbour nearer the backdrop
 * is backdrop or a lesser step toward the same paint (so paint behind an
 * opaque line, or across the inner edge of a thin one, is not measured
 * against it), and one no nearer climbs on toward that paint (so the rim of
 * a flat region is not, see CLIMB). Backdrop off its colour beside paint
 * that mixes with no one paint (two paints and the backdrop in one px) takes
 * the least alpha that keeps its paint inside 0..255, so it still stacks
 * back.
 */
function keySource(
  src: CanvasPicture["source"],
  backdrop: readonly number[],
  seeds: number[],
): Buffer {
  const { width: w, height: h, rgba } = src;
  const n = w * h;
  const d = new Float32Array(n * 3);
  const dist = new Float32Array(n);
  const soft = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) d[i * 3 + c] = rgba[i * 4 + c] - backdrop[c];
    dist[i] = offBackdrop(rgba, i, backdrop);
    soft[i] = dist[i] < KEY_FLOOD || rgba[i * 4 + 3] < 128 ? 1 : 0;
  }
  const reached = floodFromIndices(src, soft, [...borderRing(src), ...seeds]);

  // Steps from the backdrop into the paint, 8-connected (a diagonal edge's
  // ramp is as many steps deep as a straight one's), out to RAMP + 1; the
  // queue holds every pixel it numbered, nearest the backdrop first.
  const FAR = 255;
  const nb = new Int32Array(8);
  const depth = new Uint8Array(n).fill(FAR);
  const queue = new Int32Array(n);
  let tail = 0;
  for (let i = 0; i < n; i++) {
    if (reached[i]) {
      depth[i] = 0;
      queue[tail++] = i;
    }
  }
  for (let head = 0; head < tail; head++) {
    const i = queue[head];
    if (depth[i] > RAMP) continue;
    for (let k = neighbours8(src, i, nb) - 1; k >= 0; k--) {
      const j = nb[k];
      if (depth[j] === FAR) {
        depth[j] = depth[i] + 1;
        queue[tail++] = j;
      }
    }
  }

  /** Pixel `i`'s share of the way from the backdrop to the colour of
   *  pixel `p`, when it is a mix of the two: taking the backdrop back out
   *  at that share leaves it within ROUNDING + MIX_TOLERANCE * share of the
   *  line to `p`. NaN when it is not, or the share is not above 0. */
  const shareOf = (i: number, p: number): number => {
    const d0 = d[i * 3];
    const d1 = d[i * 3 + 1];
    const d2 = d[i * 3 + 2];
    const q0 = d[p * 3];
    const q1 = d[p * 3 + 1];
    const q2 = d[p * 3 + 2];
    const t = (d0 * q0 + d1 * q1 + d2 * q2) / (dist[p] * dist[p]);
    if (!(t > 0)) return NaN;
    const r = (d0 - t * q0) ** 2 + (d1 - t * q1) ** 2 + (d2 - t * q2) ** 2;
    return r <= (ROUNDING + MIX_TOLERANCE * t) ** 2 ? t : NaN;
  };
  /** The paint pixel the last `mixShare` found. */
  let mixPaint = -1;
  /** The least share pixel `i` is a mix at with paint within RAMP px (the
   *  paint furthest out it mixes with), under `upTo`; `upTo` if none. */
  const mixShare = (i: number, upTo: number): number => {
    const x = i % w;
    const y = (i - x) / w;
    let best = upTo;
    for (
      let yy = Math.max(0, y - RAMP);
      yy <= Math.min(h - 1, y + RAMP);
      yy++
    ) {
      for (
        let xx = Math.max(0, x - RAMP);
        xx <= Math.min(w - 1, x + RAMP);
        xx++
      ) {
        const p = yy * w + xx;
        if (reached[p] || dist[p] < KEY_FLOOD) continue;
        const t = shareOf(i, p);
        if (t < best) {
          best = t;
          mixPaint = p;
        }
      }
    }
    return best;
  };

  const alpha = new Float32Array(n);
  const paintNear = dilate(src, invert(reached), RAMP);
  for (let i = 0; i < n; i++) {
    if (!reached[i]) {
      alpha[i] = 1;
    } else if (paintNear[i]) {
      // Backdrop beside paint: the paint's soft edge where it mixes with it,
      // however faint (the outer step of a pale ramp is under the noise
      // floor); past the noise floor and mixing with no one paint, the
      // least alpha that holds it.
      let a = mixShare(i, Infinity);
      if (a === Infinity) {
        a = 0;
        if (dist[i] < KEY_T0) continue;
        for (let c = 0; c < 3; c++) {
          const dc = d[i * 3 + c];
          const room = dc > 0 ? 255 - backdrop[c] : backdrop[c];
          a = Math.max(a, Math.abs(dc) / Math.max(room, 1));
        }
      }
      alpha[i] = a;
    }
  }
  for (let k = 0; k < tail; k++) {
    const i = queue[k];
    const step = depth[i];
    if (step === 0 || step > RAMP) continue;
    const around = neighbours8(src, i, nb);
    // Only beside backdrop or a step of a ramp: cheap, before the search.
    let nearer = false;
    for (let m = 0; m < around; m++) {
      if (depth[nb[m]] < step && alpha[nb[m]] < 1) nearer = true;
    }
    if (!nearer) continue;
    const a = mixShare(i, 1);
    if (!(a < 1)) continue;
    const p = mixPaint;
    // The pixel nearer the backdrop is backdrop, or a lesser step toward
    // the same paint; one further in climbs further toward it.
    let chained = false;
    let climbs = false;
    for (let m = 0; m < around; m++) {
      const j = nb[m];
      if (depth[j] < step) {
        chained ||= depth[j] === 0 || (alpha[j] < 1 && shareOf(j, p) < a);
      } else {
        const climb =
          ((d[j * 3] - d[i * 3]) * d[p * 3] +
            (d[j * 3 + 1] - d[i * 3 + 1]) * d[p * 3 + 1] +
            (d[j * 3 + 2] - d[i * 3 + 2]) * d[p * 3 + 2]) /
          dist[p];
        climbs ||= climb > CLIMB;
      }
    }
    if (chained && climbs) alpha[i] = a;
  }

  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const a = alpha[i];
    for (let c = 0; c < 3; c++) {
      out[i * 4 + c] =
        a > 0 && a < 1
          ? Math.max(
              0,
              Math.min(255, Math.round(backdrop[c] + d[i * 3 + c] / a)),
            )
          : rgba[i * 4 + c];
    }
    out[i * 4 + 3] = Math.round(a * rgba[i * 4 + 3]);
  }
  return out;
}

/**
 * Opaque paint a flood from the border would have keyed had it reached it:
 * within KEY_FLOOD of a `flat` picture's backdrop colour. Backdrop the
 * figure encloses (a gap between strands closed by a collar) reads so, and
 * so does paint of the backdrop's colour inside a line (white eyes on a
 * white ground); empty on a `transparent` picture.
 */
export function backdropColoured(pic: Illustration): Mask {
  const m = new Uint8Array(pic.width * pic.height);
  const b = pic.backdrop;
  if (!b) return m;
  for (let i = 0; i < m.length; i++) {
    if (pic.alpha[i] < 1) continue;
    const d = Math.hypot(
      pic.rgb[i * 3] - b[0],
      pic.rgb[i * 3 + 1] - b[1],
      pic.rgb[i * 3 + 2] - b[2],
    );
    if (d < KEY_FLOOD) m[i] = 1;
  }
  return m;
}

// ---- raster helpers ----

/** Slack for a crossing that lands on a pixel's centre but comes out a hair
 *  off it in floating point. */
const ON_CENTRE = 1e-9;

/**
 * The pixels inside a polygon whose vertices name pixels, like every other
 * landmark: the outline runs through pixel centres, as the grid viewer draws
 * it, and a pixel is in when its centre is inside (even-odd rule) or on the
 * outline. The square from `[0, 0]` to `[4, 4]` covers columns 0..4 and rows
 * 0..4.
 */
export function polygonMask(size: CanvasSize, points: readonly Point[]): Mask {
  const { width, height } = size;
  const m = new Uint8Array(width * height);
  const set = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < width && y < height) m[y * width + x] = 1;
  };
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const [, y] of points) {
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  const top = Math.max(0, Math.floor(y0));
  const bottom = Math.min(height - 1, Math.ceil(y1));
  for (let y = top; y <= bottom; y++) {
    const xs: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const [ax, ay] = points[i];
      const [bx, by] = points[(i + 1) % points.length];
      if ((ay <= y && by > y) || (by <= y && ay > y)) {
        xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil(xs[k] - ON_CENTRE));
      const to = Math.min(width - 1, Math.floor(xs[k + 1] + ON_CENTRE));
      for (let x = from; x <= to; x++) m[y * width + x] = 1;
    }
  }
  // The crossing rule above is half-open in y, so the outline's own pixels
  // are drawn too: a bottom edge, a lower vertex, a sliver thinner than a row.
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[(i + 1) % points.length];
    const n = Math.max(
      1,
      Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay))),
    );
    for (let k = 0; k <= n; k++) {
      set(
        Math.round(ax + ((bx - ax) * k) / n),
        Math.round(ay + ((by - ay) * k) / n),
      );
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

export const and = (a: Mask, b: Mask): Mask =>
  a.map((v, i) => (v && b[i] ? 1 : 0));
export const or = (a: Mask, b: Mask): Mask =>
  a.map((v, i) => (v || b[i] ? 1 : 0));
export const andNot = (a: Mask, b: Mask): Mask =>
  a.map((v, i) => (v && !b[i] ? 1 : 0));

/** The number of on pixels. */
export function count(m: ArrayLike<number>): number {
  let n = 0;
  for (let i = 0; i < m.length; i++) if (m[i]) n++;
  return n;
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

/** The index of the pixel a point names: rounded, then held on the canvas
 *  (a coordinate just under the width rounds to it). */
export function pixelIndex(
  { width, height }: CanvasSize,
  [x, y]: Point,
): number {
  const px = Math.max(0, Math.min(width - 1, Math.round(x)));
  const py = Math.max(0, Math.min(height - 1, Math.round(y)));
  return py * width + px;
}

/** 4-connected flood over `pass` from seed points, each at the pixel it
 *  names; a seed off `pass` starts nothing. */
export function flood(
  size: CanvasSize,
  pass: Mask,
  seeds: readonly Point[],
): Mask {
  return floodFromIndices(
    size,
    pass,
    seeds.map((p) => pixelIndex(size, p)),
  );
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
