/**
 * Hair, skin or neither, by colour, from the samples an agent placed on the
 * picture rather than from a threshold chosen for one picture.
 *
 * Colours are compared in OKLab: distances there track how different two
 * colours look about evenly across hues and lightness, so "nearer" means the
 * same for orange hair on warm skin as for pink hair on peach. Each sample
 * reads the median of a small patch, so one stray pixel under it does not
 * move a whole class.
 *
 * A set is its samples joined to the median of its `base` samples: a pixel's
 * distance to the set is its distance to the nearest of those segments, so a
 * tone between the base and a sampled shadow or highlight is as near as the
 * samples themselves. A pixel takes the nearer set when it lies within that
 * set's reach, or is at most RATIO as far from it as from the other set; it
 * is `neither` otherwise: ink, ribbons, clothes, eye paint, which lie about
 * as far from either. The reach scales with how far apart the two sets are
 * and with the set's own spread and noise, never with an absolute colour
 * level, so two close sets get a tight reach and a painterly picture a wider
 * one; the ratio carries a set's unsampled shades on its far side from the
 * other set however close the two sets come.
 */

import { pixelIndex, type Illustration, type Point } from "./illustration";
import type { IllustrationSamples } from "./illustration-landmarks";

export type Lab = [number, number, number];

/** A pixel's colour class. */
export const NEITHER = 0;
export const HAIR = 1;
export const SKIN = 2;
export type ColourClass = typeof NEITHER | typeof HAIR | typeof SKIN;

const toLinear = (v: number): number => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** sRGB, 0..255 per channel, to OKLab (L 0..1). */
export function srgbToOklab(r: number, g: number, b: number): Lab {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(
    0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb,
  );
  const m = Math.cbrt(
    0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb,
  );
  const s = Math.cbrt(
    0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb,
  );
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

const dist = (a: Lab, b: Lab): number =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Distance from `p` to the segment `a`-`b`. */
function segmentDistance(p: Lab, a: Lab, b: Lab): number {
  let len2 = 0;
  let along = 0;
  for (let c = 0; c < 3; c++) {
    const d = b[c] - a[c];
    len2 += d * d;
    along += (p[c] - a[c]) * d;
  }
  const t = len2 > 0 ? Math.max(0, Math.min(1, along / len2)) : 0;
  return Math.hypot(
    p[0] - a[0] - t * (b[0] - a[0]),
    p[1] - a[1] - t * (b[1] - a[1]),
    p[2] - a[2] - t * (b[2] - a[2]),
  );
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/** Half-size of the square patch a sample reads: 5 x 5 px. */
const PATCH_RADIUS = 2;
/** Alpha at which a pixel counts as paint for a sample's patch and for the
 *  "is this sample on paint" test. */
const PAINT_ALPHA = 0.5;

/** One sample point as read off the picture. */
export interface SampleRead {
  /** Its landmark path, for the report: `landmarks.samples.hair.base[0]`. */
  path: string;
  point: Point;
  /** The pixel under the point is paint, not backdrop. */
  onPaint: boolean;
  /** The patch's median colour; null when the patch holds no paint. */
  lab: Lab | null;
  /** The same median in sRGB, 0..255 per channel. */
  rgb: [number, number, number] | null;
  /** The patch's median distance from that colour: the paint's own
   *  texture and noise there. */
  noise: number;
}

/** Read one sample: the median colour of the paint in its patch. */
export function readSample(
  pic: Illustration,
  point: Point,
  path: string,
): SampleRead {
  const { width, height, rgb, alpha } = pic;
  const centre = pixelIndex(pic, point);
  const px = centre % width;
  const py = (centre - px) / width;
  const labs: Lab[] = [];
  const rgbs: number[][] = [];
  for (let y = py - PATCH_RADIUS; y <= py + PATCH_RADIUS; y++) {
    for (let x = px - PATCH_RADIUS; x <= px + PATCH_RADIUS; x++) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const i = y * width + x;
      if (alpha[i] < PAINT_ALPHA) continue;
      rgbs.push([rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]]);
    }
  }
  const onPaint = alpha[centre] >= PAINT_ALPHA;
  if (rgbs.length === 0) {
    return { path, point, onPaint, lab: null, rgb: null, noise: 0 };
  }
  // The median per sRGB channel, one patch colour both spaces agree on.
  const mid = [0, 1, 2].map((c) => median(rgbs.map((v) => v[c]))) as [
    number,
    number,
    number,
  ];
  const lab = srgbToOklab(...mid);
  for (const v of rgbs) labs.push(srgbToOklab(v[0], v[1], v[2]));
  return {
    path,
    point,
    onPaint,
    lab,
    rgb: mid,
    noise: median(labs.map((v) => dist(v, lab))),
  };
}

export interface SampleReads {
  hair: SampleRead[];
  skin: SampleRead[];
  /** How many of `hair`, from its start, are `base` samples. */
  hairBase: number;
  /** How many of `skin`, from its start, are `base` samples. */
  skinBase: number;
}

/** Every sample of the landmarks, read, each set's `base` first. */
export function readSamples(
  pic: Illustration,
  samples: IllustrationSamples,
): SampleReads {
  const at = "landmarks.samples";
  const read = (set: string, tone: string, pts: Point[] | undefined) =>
    (pts ?? []).map((p, k) => readSample(pic, p, `${at}.${set}.${tone}[${k}]`));
  const hair = [
    ...read("hair", "base", samples.hair.base),
    ...read("hair", "shadow", samples.hair.shadow),
    ...read("hair", "highlight", samples.hair.highlight),
  ];
  const skin = [
    ...read("skin", "base", samples.skin.base),
    ...read("skin", "shadow", samples.skin.shadow),
  ];
  return {
    hair,
    skin,
    hairBase: samples.hair.base.length,
    skinBase: samples.skin.base.length,
  };
}

/** A set's reach is at least this share of the gap between the two sets:
 *  under half, so the bisector between them is never past either reach and
 *  paint far off both (ink, cloth) stays `neither`. */
const SEP_SHARE = 0.35;
/** ... and at least this many times its samples' patch noise (the lower
 *  median over the set, so one sample on a busy patch does not widen it),
 *  so a textured paint's own grain stays in its class. */
const NOISE_SCALE = 3;
/** ... and at least this share of its own spread (its base to its farthest
 *  sample): a set sampled over a wide range of tones has unsampled tones
 *  beside them. */
const SPREAD_SHARE = 0.25;
/** A colour at most this share as far from one set as from the other is
 *  that set's, past its reach: clearly on its side. A set's own unsampled
 *  shades measure about a quarter; ink, cloth, a ribbon or grey, about as
 *  far from both sets, half or more. Without it, two close sets (pale hair
 *  on pale skin) leave every unsampled shade `neither`, and a body flood
 *  takes shaded locks. */
const RATIO = 1 / 3;
/** Merge samples closer than this share of the gap between the sets: a long
 *  sample list of one tone costs one segment, not hundreds. */
const MERGE_SHARE = 0.05;

/** One colour set: segments from its base's median to each sample. */
interface ColourSet {
  anchor: Lab;
  members: Lab[];
}

function setDistance(p: Lab, set: ColourSet): number {
  let best = Infinity;
  for (const m of set.members) {
    best = Math.min(best, segmentDistance(p, set.anchor, m));
  }
  return best;
}

function buildSet(reads: SampleRead[], baseCount: number): ColourSet | null {
  const labs = reads.filter((r) => r.lab !== null).map((r) => r.lab!);
  const base = reads
    .slice(0, baseCount)
    .filter((r) => r.lab !== null)
    .map((r) => r.lab!);
  const from = base.length > 0 ? base : labs;
  if (from.length === 0) return null;
  const anchor = [0, 1, 2].map((c) => median(from.map((v) => v[c]))) as Lab;
  return { anchor, members: labs };
}

function merge(set: ColourSet, tolerance: number): ColourSet {
  const kept: Lab[] = [];
  for (const m of set.members) {
    if (!kept.some((k) => dist(k, m) <= tolerance)) kept.push(m);
  }
  return { anchor: set.anchor, members: kept };
}

export interface ColourClassifier {
  /** The class of an sRGB colour, 0..255 per channel. */
  classify(r: number, g: number, b: number): ColourClass;
  /** How far apart the two sets are (OKLab). */
  separation: number;
  /** How far past each set a colour still belongs to it (OKLab). */
  reach: { hair: number; skin: number };
}

/** 6 bits per channel: a 4-level quantisation, far under any gap between
 *  two classes, that lets a picture's few thousand distinct colours be
 *  classified once each. */
const LUT_BITS = 6;
const LUT_SHIFT = 8 - LUT_BITS;

/**
 * The classifier for one picture's samples; null when either set has no
 * sample on paint, so there is nothing to tell hair from skin by.
 */
export function buildClassifier(reads: SampleReads): ColourClassifier | null {
  const hair0 = buildSet(reads.hair, reads.hairBase);
  const skin0 = buildSet(reads.skin, reads.skinBase);
  if (hair0 === null || skin0 === null) return null;
  let separation = Infinity;
  for (const m of hair0.members) {
    separation = Math.min(separation, setDistance(m, skin0));
  }
  for (const m of skin0.members) {
    separation = Math.min(separation, setDistance(m, hair0));
  }
  const hair = merge(hair0, MERGE_SHARE * separation);
  const skin = merge(skin0, MERGE_SHARE * separation);

  const reachOf = (set: ColourSet, own: SampleRead[]): number => {
    // The lower median: of two samples, one straddling a line, the other.
    const noises = own
      .filter((r) => r.lab !== null)
      .map((r) => r.noise)
      .sort((x, y) => x - y);
    const noise = noises[(noises.length - 1) >> 1];
    const spread = Math.max(0, ...set.members.map((m) => dist(m, set.anchor)));
    return Math.max(
      SEP_SHARE * separation,
      NOISE_SCALE * noise,
      SPREAD_SHARE * spread,
    );
  };
  const reach = {
    hair: reachOf(hair, reads.hair),
    skin: reachOf(skin, reads.skin),
  };

  const lut = new Int8Array(1 << (3 * LUT_BITS)).fill(-1);
  const classify = (r: number, g: number, b: number): ColourClass => {
    const q = (v: number) =>
      Math.max(0, Math.min(255, Math.round(v))) >> LUT_SHIFT;
    const key = (q(r) << (2 * LUT_BITS)) | (q(g) << LUT_BITS) | q(b);
    const hit = lut[key];
    if (hit >= 0) return hit as ColourClass;
    // The quantisation cell's centre stands for the cell.
    const centre = (k: number) => (k << LUT_SHIFT) + (1 << LUT_SHIFT) / 2 - 0.5;
    const lab = srgbToOklab(
      centre(key >> (2 * LUT_BITS)),
      centre((key >> LUT_BITS) & ((1 << LUT_BITS) - 1)),
      centre(key & ((1 << LUT_BITS) - 1)),
    );
    const dh = setDistance(lab, hair);
    const ds = setDistance(lab, skin);
    // A colour as near both sets (two sets sampled on the same paint) goes
    // to hair: a tie has to fall somewhere, and the regions and the floods
    // then decide.
    const cls: ColourClass =
      dh <= ds
        ? dh <= reach.hair || dh <= RATIO * ds
          ? HAIR
          : NEITHER
        : ds <= reach.skin || ds <= RATIO * dh
          ? SKIN
          : NEITHER;
    lut[key] = cls;
    return cls;
  };
  return { classify, separation, reach };
}

/** Every pixel's class by its colour (the paint's own, the backdrop taken
 *  out of a soft edge); 0 where alpha is under `minAlpha`, so a caller reads
 *  NEITHER there only together with alpha. */
export function classifyPicture(
  pic: Illustration,
  classifier: ColourClassifier,
  minAlpha: number,
): Uint8Array {
  const n = pic.width * pic.height;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (pic.alpha[i] < minAlpha) continue;
    out[i] = classifier.classify(
      pic.rgb[i * 3],
      pic.rgb[i * 3 + 1],
      pic.rgb[i * 3 + 2],
    );
  }
  return out;
}

/** `reads` without the sample at `path`: the classifier a sample is judged
 *  by, so a sample on the wrong paint cannot vouch for itself. */
export function withoutSample(reads: SampleReads, path: string): SampleReads {
  const drop = (list: SampleRead[], base: number) => {
    const k = list.findIndex((r) => r.path === path);
    return k < 0
      ? { list, base }
      : {
          list: list.filter((_, j) => j !== k),
          base: k < base ? base - 1 : base,
        };
  };
  const hair = drop(reads.hair, reads.hairBase);
  const skin = drop(reads.skin, reads.skinBase);
  return {
    hair: hair.list,
    skin: skin.list,
    hairBase: hair.base,
    skinBase: skin.base,
  };
}
