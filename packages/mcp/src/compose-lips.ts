/**
 * The pixel work that turns a green-keyed open mouth plus a drawn interior
 * into the lip set the rig folds (`mouth_inner`, `lip_lower`, `lip_upper`),
 * with the interior's light paint as `mouth_tongue` and `mouth_teeth`.
 * Buffers in, buffers out: no file is read here, the composer hands over what
 * it decoded and gets PNGs back.
 *
 * The key (`keyGreen`) runs at SOURCE resolution. A model's "flat #00FF00" is
 * never that (bob's came back as (9, 245, 3)) and its line has less green than
 * red, so no formula of a pixel's own colour gives a half-mixed pixel half its
 * alpha. The fill's colour is therefore read off the art (the median of the
 * clearly green pixels), and each pixel near the fill is read against the far
 * end of ITS OWN ramp: the farthest pixel in reach that lies on the line from
 * the fill's colour through the pixel. The antialiasing becomes alpha, which
 * the premultiplied resize that follows carries cleanly.
 *
 * The split (`splitLipSet`) runs at the COMPOSED size. Every boundary it cuts
 * on is then an integer row of the pixels the rig reads, and its assertion
 * reads them through the rig's own `mouthOpening`, so what the composer checks
 * is what the rig will see. The interior is grown sideways only under ink and
 * never above its own column's hole top, which is what keeps the rig's
 * per-column contract (`Tu <= T <= lineTop`, `Bl >= Bb`) true by construction
 * rather than by luck of the art.
 *
 * The interior is split by lightness on the hole: a pixel at or over
 * CAVITY_LUMA (a tooth, the tongue) goes to `mouth_teeth` above its column's
 * hole middle and to `mouth_tongue` below it, and `mouth_inner` takes the
 * cavity's fill there, so the cavity is a dark fill with its own shading that
 * the rig clips the two to, the teeth riding the line and the tongue the
 * opening's bottom. Its edge is soft: a frame pixel beside the hole whose ink
 * is partial (alpha 128..254) was ink mixed with green, and the cavity takes
 * its share of it, `255 - alpha`, under ALPHA_OPAQUE, so no read of the
 * contract changes.
 *
 * The two columns beside the hole are grown into under the outline's side
 * wall. When the frame has ink above the first grown row the wall is the
 * line's own end, and it folds with the interior (its grown rows join
 * `mouth_inner`, not `lip_upper`), so the rig reads the line's bottom at the
 * interior's top there too and the closed line's ends are the drawn ends,
 * tapered. A column with no ink above its first grown row (an under-the-line
 * end) keeps every pixel in `lip_upper`; the rig still accepts it, its wall
 * past the opening thinned and, shut, shaped like a drawn flick.
 *
 * The preview (`closedLips`) shows the set as the rig draws it at rest: the
 * lips resampled through the lip meshes' own landed rows (`mouthRestShift`,
 * measured as the rig measures the final canvas layers), so the thinned line
 * and its tapered ends are in it, the interior left out (shut, it has zero
 * height).
 */

import sharp from "sharp";
import {
  ALPHA_OPAQUE,
  columnRuns,
  createLayerSetMeasurer,
  mouthOpening,
  mouthRestShift,
  type LayerInput,
  type Opening,
} from "@ikijs/editor";
import { AutoRigInputError } from "./limits";
import { cropToBuffer } from "./node-images";
import { TRIM_THRESHOLD, boxWithoutStraySpecks, luma } from "./trim";

export const KEYED_SRC = "mouth_keyed.png";
export const INTERIOR_SRC = "mouth_interior.png";

/** Green excess `(g - max(r, b)) / 255` at which a visible pixel is a fill
 *  candidate; the fill is never full excess (bob's is 0.925). */
const KEY_CANDIDATE = 0.5;
/** Levels (Euclidean) from the fill's median colour within which a pixel is
 *  the fill. A ramp's last pixels past it are cut with the fill. */
const KEY_FILL_DIST = 20;
/** Px (Chebyshev) from the fill within which a pixel may be a mix with it, and
 *  within which the plateau of its ramp is sought. */
const KEY_REACH = 8;
/** Levels a reference may sit off the segment from its colour to the fill's. */
const KEY_COLLINEAR = 12;
/** A share of green under this is a stroke's own shading, not a mix: read as
 *  zero, a true mix this small left opaque is 13 levels off at most. */
const KEY_MIN_SHARE = 0.05;
/** Green outside the opening's region, as a share of the opening's, over
 *  which the key is refused. */
const STRAY_KEY_FRACTION = 0.02;
/** The opening's width, as a share of the frame's, under which it is too
 *  small to fold. */
export const MIN_OPENING_WIDTH = 0.3;
/** A second hole as a share of the largest, from which the opening is not
 *  one region. */
const SECOND_HOLE_FRACTION = 0.05;
/** A dark pixel (luma under this) under the opening belongs to its lower
 *  outline band; skin is lighter. */
const BAND_LUMA = 150;
/** The band's cap, in strokes: more is not an outline. */
const BAND_CAP = 3;
/** Luma under which an interior's pixel is cavity rather than tooth or tongue:
 *  the cavity's fill is read under it, and the hole's pixels at or over it are
 *  cut into `mouth_teeth` / `mouth_tongue`. */
export const CAVITY_LUMA = 100;
/** The lip rim's skin rule, the spike's: a pixel is skin at red, green and
 *  blue over these floors, which a peach lip clears and a cavity's dark red or
 *  a tongue's pink does not; but not a tooth, whose green and blue are over
 *  these ceilings (near-white). */
const SKIN_MIN_R = 225;
const SKIN_MIN_G = 160;
const SKIN_MIN_B = 135;
const TEETH_MIN_G = 215;
const TEETH_MIN_B = 205;
const isSkin = (r: number, g: number, b: number): boolean =>
  r > SKIN_MIN_R &&
  g > SKIN_MIN_G &&
  b > SKIN_MIN_B &&
  !(g > TEETH_MIN_G && b > TEETH_MIN_B);

interface Components {
  /** Per pixel: its set's index, or -1 off the mask. */
  label: Int32Array;
  sizes: number[];
  /** Inclusive pixel boxes. */
  boxes: { x0: number; y0: number; x1: number; y1: number }[];
}

/** The sets of a mask, 4-connected, flood-filled on a stack that never
 *  outgrows the image: a pixel is marked as it is pushed. */
function components(mask: Uint8Array, W: number, H: number): Components {
  const n = W * H;
  const label = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const sizes: number[] = [];
  const boxes: Components["boxes"] = [];
  for (let start = 0; start < n; start++) {
    if (!mask[start] || label[start] >= 0) continue;
    const id = sizes.length;
    const box = { x0: W, y0: H, x1: -1, y1: -1 };
    let size = 0;
    let depth = 0;
    label[start] = id;
    stack[depth++] = start;
    while (depth > 0) {
      const p = stack[--depth];
      size++;
      const px = p % W;
      const py = (p - px) / W;
      box.x0 = Math.min(box.x0, px);
      box.x1 = Math.max(box.x1, px);
      box.y0 = Math.min(box.y0, py);
      box.y1 = Math.max(box.y1, py);
      for (let y = Math.max(0, py - 1); y <= Math.min(H - 1, py + 1); y++) {
        for (let x = Math.max(0, px - 1); x <= Math.min(W - 1, px + 1); x++) {
          if (x !== px && y !== py) continue;
          const q = y * W + x;
          if (mask[q] && label[q] < 0) {
            label[q] = id;
            stack[depth++] = q;
          }
        }
      }
    }
    sizes.push(size);
    boxes.push(box);
  }
  return { label, sizes, boxes };
}

/** The largest set's index, or -1 for none. */
const largest = (sizes: number[]): number =>
  sizes.reduce((best, s, i) => (best < 0 || s > sizes[best] ? i : best), -1);

/**
 * Chebyshev dilation of `mask` by `reach`: done along the rows and then down
 * the columns, which is the same box as one pass over the square.
 */
function dilate(mask: Uint8Array, W: number, H: number, reach: number) {
  const rows = new Uint8Array(W * H);
  const prefix = new Int32Array(Math.max(W, H) + 1);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) prefix[x + 1] = prefix[x] + mask[y * W + x];
    for (let x = 0; x < W; x++) {
      rows[y * W + x] =
        prefix[Math.min(W, x + reach + 1)] - prefix[Math.max(0, x - reach)] > 0
          ? 1
          : 0;
    }
  }
  const out = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) prefix[y + 1] = prefix[y] + rows[y * W + x];
    for (let y = 0; y < H; y++) {
      out[y * W + x] =
        prefix[Math.min(H, y + reach + 1)] - prefix[Math.max(0, y - reach)] > 0
          ? 1
          : 0;
    }
  }
  return out;
}

/**
 * The share of green in the pixel at byte offset `i`, read against the
 * foreground at `j`: where it lies on the segment from `j`'s colour to `g`,
 * clamped to 0..1. `j`'s colour must not be `g`'s.
 */
function shareOf(rgba: Buffer, i: number, j: number, g: number[]): number {
  const dr = g[0] - rgba[j];
  const dg = g[1] - rgba[j + 1];
  const db = g[2] - rgba[j + 2];
  const t =
    ((rgba[i] - rgba[j]) * dr +
      (rgba[i + 1] - rgba[j + 1]) * dg +
      (rgba[i + 2] - rgba[j + 2]) * db) /
    (dr * dr + dg * dg + db * db);
  return Math.min(1, Math.max(0, t));
}

/**
 * Key the green out of a straight-alpha RGBA mouth, estimating each mixed
 * pixel's real alpha. See the header: the fill is the art's own green, a pixel
 * near it is read against the farthest pixel in reach on its own colour ramp,
 * and a share under KEY_MIN_SHARE is shading, not green. A pixel under alpha
 * 128 is a candidate for nothing and a reference for nobody (a PNG keeps RGB
 * under zero alpha, so invisible green must neither open a hole nor spoil the
 * region check), but green left faintly visible is cleared with the fill: it
 * would come out of the resize as a green fringe on the lip.
 */
export function keyGreen(rgba: Buffer, W: number, H: number): Buffer {
  const n = W * H;
  const noGreen = new AutoRigInputError(
    `${KEYED_SRC}: no green opening (#00FF00) to key — regenerate it with the inside of the open mouth painted ONE flat pure green`,
  );

  const hist = [
    new Uint32Array(256),
    new Uint32Array(256),
    new Uint32Array(256),
  ];
  let candidates = 0;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (rgba[i + 3] < ALPHA_OPAQUE) continue;
    const excess = (rgba[i + 1] - Math.max(rgba[i], rgba[i + 2])) / 255;
    if (excess < KEY_CANDIDATE) continue;
    candidates++;
    for (let c = 0; c < 3; c++) hist[c][rgba[i + c]]++;
  }
  if (candidates === 0) throw noGreen;
  const median = (h: Uint32Array): number => {
    let seen = 0;
    for (let v = 0; v < 256; v++) {
      seen += h[v];
      if (seen * 2 >= candidates) return v;
    }
    return 255;
  };
  const G = [median(hist[0]), median(hist[1]), median(hist[2])];

  // The fill: visible pixels the art's key colour owns. `ref` is every visible
  // pixel that is not (the only ones a mixed pixel may read itself against).
  const out = Buffer.from(rgba);
  const fill = new Uint8Array(n);
  const ref = new Uint8Array(n);
  let fillCount = 0;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (rgba[i + 3] === 0) continue;
    const dr = rgba[i] - G[0];
    const dg = rgba[i + 1] - G[1];
    const db = rgba[i + 2] - G[2];
    const green = dr * dr + dg * dg + db * db <= KEY_FILL_DIST * KEY_FILL_DIST;
    if (rgba[i + 3] < ALPHA_OPAQUE) {
      if (green) out[i + 3] = 0;
    } else if (green) {
      fill[p] = 1;
      fillCount++;
    } else {
      ref[p] = 1;
    }
  }
  if (fillCount === 0) throw noGreen;

  const reach = dilate(fill, W, H, KEY_REACH);
  const collinear = KEY_COLLINEAR * KEY_COLLINEAR;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (!reach[p] || fill[p] || out[p * 4 + 3] === 0) continue;
      const i = p * 4;
      // The pixel itself always qualifies, so there is no fallback.
      let best = i;
      let bestD2 =
        (rgba[i] - G[0]) ** 2 +
        (rgba[i + 1] - G[1]) ** 2 +
        (rgba[i + 2] - G[2]) ** 2;
      const y1 = Math.min(H - 1, y + KEY_REACH);
      const x1 = Math.min(W - 1, x + KEY_REACH);
      for (let qy = Math.max(0, y - KEY_REACH); qy <= y1; qy++) {
        for (let qx = Math.max(0, x - KEY_REACH); qx <= x1; qx++) {
          const q = qy * W + qx;
          if (q === p || !ref[q]) continue;
          const j = q * 4;
          const d2 =
            (rgba[j] - G[0]) ** 2 +
            (rgba[j + 1] - G[1]) ** 2 +
            (rgba[j + 2] - G[2]) ** 2;
          if (d2 <= bestD2) continue;
          const t = shareOf(rgba, i, j, G);
          const er = rgba[i] - rgba[j] - t * (G[0] - rgba[j]);
          const eg = rgba[i + 1] - rgba[j + 1] - t * (G[1] - rgba[j + 1]);
          const eb = rgba[i + 2] - rgba[j + 2] - t * (G[2] - rgba[j + 2]);
          if (er * er + eg * eg + eb * eb > collinear) continue;
          bestD2 = d2;
          best = j;
        }
      }
      const k = shareOf(rgba, i, best, G);
      if (k < KEY_MIN_SHARE) continue;
      rgba.copy(out, i, best, best + 3);
      out[i + 3] = Math.round(rgba[i + 3] * (1 - k));
    }
  }
  for (let p = 0; p < n; p++) if (fill[p]) out[p * 4 + 3] = 0;

  const { sizes } = components(fill, W, H);
  const main = largest(sizes);
  const strays = sizes.filter((_, i) => i !== main);
  const strayPx = strays.reduce((a, b) => a + b, 0);
  if (strayPx > STRAY_KEY_FRACTION * sizes[main]) {
    throw new AutoRigInputError(
      `${KEYED_SRC}: green outside the opening (${strayPx} px in ${strays.length} regions beside the opening's) — the key must be one flat region inside the outline; regenerate with no green elsewhere`,
    );
  }
  return out;
}

/** Levels (per channel) from the ground's median colour within which a pixel
 *  is the ground. Near-white teeth (250, 248, 245) sit 5..10 off a pure white
 *  ground, so a floor like the legacy parts' 238 would key them out. */
const GROUND_TOLERANCE = 4;
/** A border whose median is light in every channel (over this) is a ground,
 *  not the drawing: a darker or more saturated one means the drawing itself
 *  reaches the edges. A mid-grey ground under it therefore passes through, read
 *  as the drawing reaching the edges. */
const GROUND_LIGHT = 200;
/** The floor of a light ground the interior is keyed against: a light ground
 *  under it in some channel (cream, grey) is not white. */
const GROUND_MIN = 238;
/** The share of the border a white ground must own: under it the ground has
 *  heavy noise, a gradient or a checkerboard "fake transparency" along the
 *  border itself (a checkerboard owns about half), and the key would leave a
 *  rind of it round the drawing. A drawing may touch about a third of the
 *  border and still pass. */
const GROUND_BORDER_SHARE = 0.65;

/**
 * Key the white ground out of an interior that came without alpha: the pixels
 * 4-connected to the border within GROUND_TOLERANCE of the border's median
 * colour. The legacy parts' rule (every near-white pixel) would take the teeth
 * with it, and the teeth are what this part is for. A light ground that is
 * not white (cream, grey), or a white one with heavy noise or a gradient along
 * the border that leaves it owning under half of it, cannot be keyed cleanly
 * and is refused: stretched into the opening it would show as a box. A border
 * that is not light is the drawing itself reaching the edges ("filling the
 * image"): only the white connected to the border is keyed, the corners an oval
 * leaves.
 */
export function keyBorderWhite(rgba: Buffer, W: number, H: number): Buffer {
  const border: number[][] = [[], [], []];
  const edge = (p: number) => {
    for (let c = 0; c < 3; c++) border[c].push(rgba[p * 4 + c]);
  };
  for (let x = 0; x < W; x++) {
    edge(x);
    edge((H - 1) * W + x);
  }
  for (let y = 1; y < H - 1; y++) {
    edge(y * W);
    edge(y * W + W - 1);
  }
  const ground = border.map((v) => v.sort((a, b) => a - b)[v.length >> 1]);
  const light = ground.every((v) => v >= GROUND_LIGHT);
  if (light && ground.some((v) => v < GROUND_MIN)) {
    throw new AutoRigInputError(
      `${INTERIOR_SRC} came back opaque on a non-white ground — regenerate it with a transparent background. Billed.`,
    );
  }
  if (!light) ground.fill(255);

  const out = Buffer.from(rgba);
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  let depth = 0;
  const seed = (p: number) => {
    if (seen[p]) return;
    for (let c = 0; c < 3; c++) {
      if (Math.abs(rgba[p * 4 + c] - ground[c]) > GROUND_TOLERANCE) return;
    }
    seen[p] = 1;
    stack[depth++] = p;
  };
  for (let x = 0; x < W; x++) {
    seed(x);
    seed((H - 1) * W + x);
  }
  for (let y = 0; y < H; y++) {
    seed(y * W);
    seed(y * W + W - 1);
  }
  if (light && depth < GROUND_BORDER_SHARE * border[0].length) {
    throw new AutoRigInputError(
      `${INTERIOR_SRC} came back opaque on a white ground too noisy or shaded to key cleanly — regenerate it with a transparent background. Billed.`,
    );
  }
  while (depth > 0) {
    const p = stack[--depth];
    out[p * 4 + 3] = 0;
    const x = p % W;
    if (x > 0) seed(p - 1);
    if (x < W - 1) seed(p + 1);
    if (p >= W) seed(p - W);
    if (p < W * H - W) seed(p + W);
  }
  return out;
}

/** The box of the part's drawing: the composer's trim (stray specks aside),
 *  or every pixel the trim keeps when no speck lies outside the drawing.
 *  null when nothing is kept. */
function drawingBox(rgba: Buffer, W: number, H: number) {
  const speckless = boxWithoutStraySpecks(rgba, W, H);
  if (speckless !== null) {
    return {
      x: speckless.left,
      y: speckless.top,
      w: speckless.width,
      h: speckless.height,
    };
  }
  let x0 = W;
  let y0 = H;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (rgba[(y * W + x) * 4 + 3] <= TRIM_THRESHOLD) continue;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * The drawn interior, ready to fit into the opening: trimmed, with the lip rim
 * a generator draws round the cavity removed (the skin-coloured sets touching
 * the trimmed border: the spike's interior prompt drew a peach lower lip
 * twice), and the cavity's colour read off what is left, for the flat fill the
 * split lays under it. The caller has keyed a white ground out of an interior
 * that came without alpha.
 */
export async function prepInterior(
  rgba: Buffer,
  W: number,
  H: number,
): Promise<{ png: Buffer; cavity: [number, number, number] }> {
  const empty = new AutoRigInputError(
    `${INTERIOR_SRC}: nothing but lips/skin after trimming — regenerate it with the cavity, the teeth and the tongue only, NO lips`,
  );
  const first = drawingBox(rgba, W, H);
  if (first === null) throw empty;
  const cw = first.w;
  const ch = first.h;
  const crop = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    const from = ((first.y + y) * W + first.x) * 4;
    rgba.copy(crop, y * cw * 4, from, from + cw * 4);
  }

  const skin = new Uint8Array(cw * ch);
  for (let p = 0; p < cw * ch; p++) {
    const i = p * 4;
    if (
      crop[i + 3] > TRIM_THRESHOLD &&
      isSkin(crop[i], crop[i + 1], crop[i + 2])
    )
      skin[p] = 1;
  }
  const { label, boxes } = components(skin, cw, ch);
  const rim = boxes.map(
    (b) => b.x0 === 0 || b.y0 === 0 || b.x1 === cw - 1 || b.y1 === ch - 1,
  );
  for (let p = 0; p < cw * ch; p++) {
    if (label[p] >= 0 && rim[label[p]]) crop[p * 4 + 3] = 0;
  }

  const box = drawingBox(crop, cw, ch);
  if (box === null) throw empty;

  // The cavity: the dark pixels' mean, or everything's when none is dark.
  const sum = [0, 0, 0];
  const all = [0, 0, 0];
  let dark = 0;
  let count = 0;
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      const i = (y * cw + x) * 4;
      if (crop[i + 3] < ALPHA_OPAQUE) continue;
      count++;
      for (let c = 0; c < 3; c++) all[c] += crop[i + c];
      if (luma(crop, i) < CAVITY_LUMA) {
        dark++;
        for (let c = 0; c < 3; c++) sum[c] += crop[i + c];
      }
    }
  }
  if (count === 0) throw empty;
  const [from, over] = dark > 0 ? [sum, dark] : [all, count];
  const cavity = from.map((v) => Math.round(v / over)) as [
    number,
    number,
    number,
  ];
  return { png: await cropToBuffer(crop, cw, ch, box), cavity };
}

const rawOf = async (png: Buffer) =>
  sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

const encode = (rgba: Buffer, w: number, h: number) =>
  sharp(rgba, { raw: { width: w, height: h, channels: 4 } })
    .png()
    .toBuffer();

/**
 * The opening of a keyed frame: its transparent pixels the outside cannot
 * reach through transparent pixels (so its boundary is at or above
 * ALPHA_OPAQUE), as the largest set of them. Refuses a frame with no such hole,
 * one too narrow to fold, and one with a second hole of
 * SECOND_HOLE_FRACTION of the largest or more.
 */
function enclosedHole(frame: Buffer, w: number, h: number) {
  const n = w * h;
  const alpha = (p: number) => frame[p * 4 + 3];
  const outside = new Uint8Array(n);
  const stack = new Int32Array(n);
  let depth = 0;
  const seed = (p: number) => {
    if (!outside[p] && alpha(p) < ALPHA_OPAQUE) {
      outside[p] = 1;
      stack[depth++] = p;
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (depth > 0) {
    const p = stack[--depth];
    const x = p % w;
    if (x > 0) seed(p - 1);
    if (x < w - 1) seed(p + 1);
    if (p >= w) seed(p - w);
    if (p < n - w) seed(p + w);
  }
  const mask = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    if (alpha(p) < ALPHA_OPAQUE && !outside[p]) mask[p] = 1;
  }
  const { label, sizes, boxes } = components(mask, w, h);
  const main = largest(sizes);
  if (main < 0) {
    throw new AutoRigInputError(
      `${KEYED_SRC}: the outline is not closed round the opening (the key reached the outside, or the line is broken or too thin at this size) — regenerate with ONE closed, bolder outline`,
    );
  }
  const box = boxes[main];
  const holeW = box.x1 - box.x0 + 1;
  if (holeW < MIN_OPENING_WIDTH * w) {
    throw new AutoRigInputError(
      `${KEYED_SRC}: the opening is only ${holeW} px wide of the mouth's ${w} — too small to fold; regenerate with the mouth open wider, or, if its outline is broken (only a small pocket of the opening was enclosed), with ONE closed, bolder outline`,
    );
  }
  const others = sizes.filter(
    (s, i) => i !== main && s >= SECOND_HOLE_FRACTION * sizes[main],
  );
  if (others.length > 0) {
    throw new AutoRigInputError(
      `${KEYED_SRC}: the opening is not one connected region (${others.length + 1} holes: teeth or tongue drawn into the green?) — regenerate with nothing drawn inside the green`,
    );
  }
  return { label, main, box };
}

type LipRgba = { mouth_inner: Buffer; lip_lower: Buffer; lip_upper: Buffer };

/** The three layers, raw RGBA on a `w` x `h` canvas, as the rig measures
 *  them; null for a layer with no opaque pixel. */
function measureLips(
  layers: LipRgba,
  w: number,
  h: number,
): Map<string, LayerInput | null> {
  const measurer = createLayerSetMeasurer({ width: w, height: h });
  return new Map(
    Object.entries(layers).map(([role, rgba]) => [
      role,
      measurer.add({ role, fileName: `${role}.png`, rgba }),
    ]),
  );
}

/**
 * Read the three layers back through the rig's own `mouthOpening` and assert
 * the fold's contract on every column of the opening it reads. A violation is
 * an invariant of the split, not input, so it throws a plain Error naming the
 * column.
 */
function assertFoldContract(layers: LipRgba, w: number, h: number): Opening {
  const byRole = new Map<string, LayerInput>();
  for (const [role, layer] of measureLips(layers, w, h)) {
    // The outline above the opening and the interior in it always exist; the
    // skin under it is the art's.
    if (layer === null && role === "lip_lower") {
      throw new AutoRigInputError(
        `${KEYED_SRC}: no lip_lower after the split — there is no skin under the opening; draw the lower lip under the outline`,
      );
    }
    byRole.set(role, layer!);
  }
  const opening = mouthOpening(byRole);
  const runs = columnRuns(byRole.get("mouth_inner")!);
  for (let col = opening.x0; col <= opening.x1; col++) {
    const c = opening.at(col);
    const why = !runs.has(col)
      ? "has no interior run"
      : c.Tu > c.T
        ? `has a gap between the line and the interior (Tu ${c.Tu} > T ${c.T})`
        : c.T > c.lineTop || c.lineH <= 0
          ? `has no line above the interior (T ${c.T}, line top ${c.lineTop})`
          : c.Bl < c.Bb
            ? `has a gap between the interior and the skin (Bl ${c.Bl} < Bb ${c.Bb})`
            : null;
    if (why !== null) throw new Error(`splitLipSet: column ${col} ${why}`);
  }
  return opening;
}

/**
 * Split a keyed, trimmed and composed-size mouth frame into the lip set. Per
 * opening column (a column of the enclosed hole) `top` / `bot` are the hole's
 * first row and last row + 1:
 *   lip_upper  every pixel above `top`, every pixel of a column outside the
 *              opening (the corner hooks) except a side wall's grown rows, the
 *              hole's faint upper half;
 *   mouth_inner the band (the ink from `bot` down while dark, at most
 *              BAND_CAP strokes) over the interior over a flat cavity fill, on
 *              the hole, the band and the first skin row `R`, grown once
 *              sideways under ink and never above its own column's `top`
 *              (the grown rows of a side column with ink above them are
 *              `lip_upper`'s no longer: the wall folds with the interior);
 *   lip_lower  every row from `R` down (row `R` is in both: a one-row overlap,
 *              not a gap);
 *   mouth_teeth / mouth_tongue  the hole's pixels whose colour in `mouth_inner`
 *              is at or over CAVITY_LUMA, above / below the column's hole
 *              middle, opaque; `mouth_inner` takes the cavity's fill there;
 *   the rim    a frame pixel outside `mouth_inner` beside the hole with alpha
 *              128..254: the cavity's fill at `255 - alpha` in `mouth_inner`.
 * A side column (beside the hole) whose frame has no ink above its first grown
 * row keeps those rows in `lip_upper` and out of `mouth_inner`'s fold.
 * The result is read back through the rig's own `mouthOpening` and the
 * contract asserted (`assertFoldContract`).
 */
export async function splitLipSet(
  keyedPng: Buffer,
  w: number,
  h: number,
  interior: { png: Buffer; cavity: [number, number, number] },
): Promise<{
  inner: Buffer;
  lower: Buffer;
  upper: Buffer;
  tongue: Buffer;
  teeth: Buffer;
  opening: Opening;
}> {
  const { data: frame, info } = await rawOf(keyedPng);
  if (info.width !== w || info.height !== h) {
    throw new Error(
      `splitLipSet: the frame is ${info.width}x${info.height}, not ${w}x${h}`,
    );
  }
  const n = w * h;
  const alpha = (p: number) => frame[p * 4 + 3];
  const { label, main, box: hb } = enclosedHole(frame, w, h);
  const holeW = hb.x1 - hb.x0 + 1;

  const top = new Int32Array(w).fill(-1);
  const bot = new Int32Array(w).fill(-1);
  for (let y = 0; y < h; y++) {
    for (let x = hb.x0; x <= hb.x1; x++) {
      if (label[y * w + x] !== main) continue;
      if (top[x] < 0) top[x] = y;
      bot[x] = y + 1;
    }
  }
  // The stroke: the opaque rows directly above the hole at its centre column.
  const centre = Math.round((hb.x0 + hb.x1) / 2);
  let stroke = 0;
  while (
    top[centre] - 1 - stroke >= 0 &&
    alpha((top[centre] - 1 - stroke) * w + centre) >= ALPHA_OPAQUE
  )
    stroke++;
  const bandCap = BAND_CAP * Math.max(1, stroke);

  // Per opening column: the band's end and the first skin row R (-1: none).
  const skinRow = new Int32Array(w).fill(-1);
  const inM = new Uint8Array(n);
  for (let x = hb.x0; x <= hb.x1; x++) {
    let y = bot[x];
    while (
      y < h &&
      y - bot[x] < bandCap &&
      alpha(y * w + x) >= ALPHA_OPAQUE &&
      luma(frame, (y * w + x) * 4) < BAND_LUMA
    )
      y++;
    for (let k = top[x]; k < y; k++) inM[k * w + x] = 1;
    let r = y;
    while (r < h && alpha(r * w + x) < ALPHA_OPAQUE) r++;
    if (r < h) {
      skinRow[x] = r;
      inM[r * w + x] = 1;
    }
  }

  // Grown once, from M as it was: sideways, under ink only, and in an opening
  // column never above its own hole top.
  const grown = Uint8Array.from(inM);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (inM[p] || alpha(p) < ALPHA_OPAQUE) continue;
      if (top[x] >= 0 && y < top[x]) continue;
      if ((x > 0 && inM[p - 1]) || (x < w - 1 && inM[p + 1])) grown[p] = 1;
    }
  }

  // The columns beside the hole whose grown rows are the outline's side wall:
  // the frame is opaque on the row above the first one. Those rows fold with
  // the interior; a column with no ink above them keeps its pixels in the
  // line (an under-the-line end the rig still accepts, its wall thinned and,
  // shut, shaped like a drawn flick).
  const wall = new Uint8Array(w);
  for (const x of [hb.x0 - 1, hb.x1 + 1]) {
    if (x < 0 || x >= w) continue;
    let first = 0;
    while (first < h && !(grown[first * w + x] && !inM[first * w + x])) first++;
    if (first > 0 && first < h && alpha((first - 1) * w + x) >= ALPHA_OPAQUE)
      wall[x] = 1;
  }

  // The interior fitted to the hole's box grown one pixel each side.
  const gx = hb.x0 - 1;
  const gy = hb.y0 - 1;
  const gw = holeW + 2;
  const gh = hb.y1 - hb.y0 + 3;
  const { data: fitted } = await sharp(interior.png)
    .resize(gw, gh, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const hole = (q: number) => label[q] === main;
  // Above its column's hole middle: the line's half of the opening, for the
  // faint pixels and for the light paint alike.
  const upperHalf = (x: number, y: number) => 2 * y < top[x] + bot[x];
  // The hole's faint pixels in its upper half are the line's antialiasing, the
  // lower half's the band's.
  const faintUpper = (p: number, x: number, y: number) =>
    y < bot[x] && hole(p) && upperHalf(x, y);
  const besideHole = (p: number, x: number, y: number) =>
    (x > 0 && hole(p - 1)) ||
    (x < w - 1 && hole(p + 1)) ||
    (y > 0 && hole(p - w)) ||
    (y < h - 1 && hole(p + w));

  const upper = Buffer.alloc(n * 4);
  const lower = Buffer.alloc(n * 4);
  const inner = Buffer.alloc(n * 4);
  const tongue = Buffer.alloc(n * 4);
  const teeth = Buffer.alloc(n * 4);
  const copy = (to: Buffer, p: number) =>
    frame.copy(to, p * 4, p * 4, p * 4 + 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const inOpening = top[x] >= 0;
      if (
        (!inOpening || y < top[x] || faintUpper(p, x, y)) &&
        !(wall[x] && grown[p])
      )
        copy(upper, p);
      if (inOpening && skinRow[x] >= 0 && y >= skinRow[x]) copy(lower, p);

      if (!grown[p]) {
        // The rim: the ink's partial alpha is its coverage, the rest the
        // opening's, which the cavity fills.
        const a = alpha(p);
        if (a >= ALPHA_OPAQUE && a < 255 && besideHole(p, x, y)) {
          inner.set(interior.cavity, p * 4);
          inner[p * 4 + 3] = 255 - a;
        }
        continue;
      }
      const out = [...interior.cavity];
      const ix = x - gx;
      const iy = y - gy;
      if (ix >= 0 && ix < gw && iy >= 0 && iy < gh) {
        const i = (iy * gw + ix) * 4;
        const a = fitted[i + 3] / 255;
        for (let c = 0; c < 3; c++) out[c] += (fitted[i + c] - out[c]) * a;
      }
      // The frame's own ink goes over it on the hole's rows (but not the faint
      // upper half, which is the line's), on the band and the skin row, and on
      // a side wall's rows.
      if ((inM[p] || wall[x]) && !faintUpper(p, x, y)) {
        const a = alpha(p) / 255;
        for (let c = 0; c < 3; c++) out[c] += (frame[p * 4 + c] - out[c]) * a;
      }
      inner[p * 4] = Math.round(out[0]);
      inner[p * 4 + 1] = Math.round(out[1]);
      inner[p * 4 + 2] = Math.round(out[2]);
      inner[p * 4 + 3] = 255;
      // The hole's light paint is a layer of its own, and the cavity is
      // repainted its fill under it.
      if (hole(p) && luma(inner, p * 4) >= CAVITY_LUMA) {
        const to = upperHalf(x, y) ? teeth : tongue;
        inner.copy(to, p * 4, p * 4, p * 4 + 4);
        inner.set(interior.cavity, p * 4);
      }
    }
  }

  const opening = assertFoldContract(
    { mouth_inner: inner, lip_lower: lower, lip_upper: upper },
    w,
    h,
  );
  const [innerPng, lowerPng, upperPng, tonguePng, teethPng] = await Promise.all(
    [inner, lower, upper, tongue, teeth].map((b) => encode(b, w, h)),
  );
  return {
    inner: innerPng,
    lower: lowerPng,
    upper: upperPng,
    tongue: tonguePng,
    teeth: teethPng,
    opening,
  };
}

/**
 * The rig's rest shift of the lips for the three canvas-sized layers: the
 * lip meshes' own field at MouthOpen 0 (`mouthRestShift`). Measured on the
 * canvas, not on the mouth-sized frame: `detectAlphaBbox` grows a box a pixel
 * each side and clamps it to the image, so a frame clamps where the canvas
 * does not, and the knot grid, which starts at the union's edge, lands
 * elsewhere. The measurement is the rig's own, of the same bytes.
 */
export async function restShiftOf(
  layers: { mouth_inner: Buffer; lip_lower: Buffer; lip_upper: Buffer },
  width: number,
  height: number,
): Promise<ReturnType<typeof mouthRestShift>> {
  const [mouth_inner, lip_lower, lip_upper] = await Promise.all(
    [layers.mouth_inner, layers.lip_lower, layers.lip_upper].map(
      async (png) => (await rawOf(png)).data,
    ),
  );
  const byRole = new Map<string, LayerInput>();
  for (const [role, layer] of measureLips(
    { mouth_inner, lip_lower, lip_upper },
    width,
    height,
  )) {
    if (layer === null) {
      throw new AutoRigInputError(
        `layout.mouth_inner places the lip set so that ${role} falls off the canvas (nothing of it is left) — move it back on the canvas`,
      );
    }
    byRole.set(role, layer);
  }
  return mouthRestShift(byRole);
}

/**
 * The lips as the rig draws them at rest (MouthOpen 0), each column resampled
 * through the lip mesh's own landed rows: a source row lands at its centre
 * moved by the field there (`mouthRestShift`, the same knots, triangles and
 * stored offsets the rig has, so the preview is what the mesh draws; a
 * per-column fold is a pixel or more off on the lower lip, whose fold carries
 * integer-row reads). Only the rows whose centres the field answers land:
 * those inside the part's box, the layer's alpha box, so every row outside it
 * is transparent and contributes nothing, but for the one beyond each end,
 * landed a step past the edge row for the edge to blend into. The thin and
 * the squashes are positive scales, so the landed rows keep their order; each
 * destination row is blended linearly from the two consecutive landed rows
 * bracketing its centre, the way the GPU samples the mesh (rounding per row
 * would turn the smooth arc into a staircase the rig never draws),
 * premultiplied so an edge neither darkens nor lightens, and is transparent
 * when no pair brackets it. A constant field is a plain sub-pixel shift. The
 * flick's sideways pull is not previewed: the field is a column's dy alone.
 * `left` and `top` are the
 * frame's column and row on the canvas; +y is up and rows go down the image,
 * so a row lands at -dy. The interior is left out: shut, it has no height.
 */
export async function closedLips(
  upper: Buffer,
  lower: Buffer,
  shift: ReturnType<typeof mouthRestShift>,
  left: number,
  top: number,
): Promise<{ upper: Buffer; lower: Buffer }> {
  const shut = async (png: Buffer, role: "lip_upper" | "lip_lower") => {
    const { data, info } = await rawOf(png);
    const { width: w, height: h } = info;
    const out = Buffer.alloc(w * h * 4);
    for (let x = 0; x < w; x++) {
      const px = (row: number, c: number) =>
        row < 0 || row >= h ? 0 : data[(row * w + x) * 4 + c];
      // [source row, its landed centre], in row order.
      const landed: [number, number][] = [];
      for (let row = 0; row < h; row++) {
        const dy = shift(role, left + x, top + row);
        if (dy !== undefined) landed.push([row, row + 0.5 - dy]);
      }
      // The rows just past the box (transparent), a landed step beyond its
      // edge rows: the edge rows blend into nothing over their outer half,
      // as a drawn edge does, rather than ending at their centres.
      if (landed.length > 1) {
        const [a, b] = landed;
        const [y, z] = landed.slice(-2);
        landed.unshift([a[0] - 1, 2 * a[1] - b[1]]);
        landed.push([z[0] + 1, 2 * z[1] - y[1]]);
      }
      let i = 0;
      for (let to = 0; to < h; to++) {
        const centre = to + 0.5;
        while (i + 1 < landed.length && landed[i + 1][1] < centre) i++;
        if (i + 1 >= landed.length || landed[i][1] > centre) continue;
        const [r0, y0] = landed[i];
        const [r1, y1] = landed[i + 1];
        const t = (centre - y0) / (y1 - y0);
        const a0 = px(r0, 3);
        const a1 = px(r1, 3);
        const a = (1 - t) * a0 + t * a1;
        if (a === 0) continue;
        const o = (to * w + x) * 4;
        for (let c = 0; c < 3; c++)
          out[o + c] = Math.round(
            ((1 - t) * a0 * px(r0, c) + t * a1 * px(r1, c)) / a,
          );
        out[o + 3] = Math.round(a);
      }
    }
    return encode(out, w, h);
  };
  const [u, l] = await Promise.all([
    shut(upper, "lip_upper"),
    shut(lower, "lip_lower"),
  ]);
  return { upper: u, lower: l };
}
