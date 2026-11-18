/**
 * The label map of an in-place cut: every painted pixel of the picture to
 * one of face, hair or body, then the hair split into the front hair, the
 * back hair and each custom part.
 *
 * Colour decides first (`illustration-colour.ts`); where colour cannot tell
 * (lash ink the colour of near-black hair, a dark jacket under it) the
 * landmark regions do: nothing inside an eye box, a brow band, the nose or
 * mouth box or a `bodyOnly` polygon is hair. Floods from the agent's seeds
 * then take the face and the body, and whatever paint is still unlabelled
 * takes its nearest label.
 */

import {
  and,
  andNot,
  boxMask,
  dilate,
  erode,
  fillHoles,
  flood,
  majority,
  or,
  polygonMask,
  type Box,
  type CanvasSize,
  type Illustration,
  type Mask,
} from "./illustration";
import { HAIR, NEITHER, SKIN } from "./illustration-colour";
import type {
  IllustrationBrow,
  IllustrationCustomCut,
  IllustrationLandmarks,
} from "./illustration-landmarks";

/** A label-map value. Feature layers get codes of their own past these. */
export const LABEL_NONE = 0;
export const LABEL_FACE = 1;
export const LABEL_HAIR = 2;
export const LABEL_BODY = 3;

/** Alpha past which paint is solid enough to flood through or to read as a
 *  fill's source. */
export const SOLID_ALPHA = 0.5;
/** Alpha past which paint counts as hair; under it a strand's soft edge,
 *  whose decontaminated colour is unreliable, goes by its nearest label.
 *  Too high drops thin strands from the hair; too low lets edge noise in. */
const HAIR_ALPHA = 0.3;
/** Alpha past which a pixel is painted at all. */
export const PAINT_ALPHA = 0.02;
/** Hair pieces under this many px are specks if paint rings them (a button,
 *  a blush speck); too small keeps hair-coloured specks on the face and the
 *  clothes, too big gives real locks to whatever surrounds them. */
const SPECK_PX = 400;
/** A speck whose 2 px ring is more than this share paint that is not hair
 *  belongs to that paint; lower takes strand tips over clothes away from
 *  the hair. */
const SPECK_RING_SHARE = 0.6;
/** Speckle between hair and skin is smoothed with a (2r+1)² majority. */
const SMOOTH_RADIUS = 2;
/** The face's outline: paint up to this many px past its skin flood (a
 *  drawn line's width at the canvas size). Narrower leaves the outer half
 *  of the line to the hair or the body; wider takes paint beside it. */
const OUTLINE_PX = 3;
/** Hair-coloured paint thinner than 2r+1 px is a line, not a lock, where it
 *  runs along the face's or the neck's skin. */
const THIN_RADIUS = 2;
/** How far through paint from that skin such a line may lie: its whole
 *  width (under 2r+1 px) and the soft edge between it and the skin. A wisp
 *  with backdrop between it and the skin is not reached. */
const THIN_BESIDE_SKIN = 2 * THIN_RADIUS + 2;
/** Paint that is neither hair nor skin this close to hair is the hair's own
 *  outline (on thick paint, a collar or a ribbon, a thin rim). Smaller lets
 *  a body flood run along the hair's outline. */
const INK_REACH = 3;
/** Neither-paint thinner than 2r+1 px is a drawn line rather than cloth. */
const LINE_RADIUS = 3;
/** A line joined to the hair is the hair's along this many px of itself:
 *  past a line's far edge, which the soft edge between hair and line can
 *  push beyond INK_REACH, and no further along a line that leaves the
 *  hair (a collar's outline). */
const LINE_REACH = 8;

/** The smallest box holding every on pixel; null for an empty mask. */
export function maskBox(size: CanvasSize, m: ArrayLike<number>): Box | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let y = 0; y < size.height; y++) {
    for (let x = 0; x < size.width; x++) {
      if (!m[y * size.width + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  return x1 < 0 ? null : [x0, y0, x1, y1];
}

/**
 * A brow's band: the pixels within the half-width of its centreline. The
 * half-width runs from `tailHalfWidth` at the tail up to `halfWidth` a third
 * of the way along, where the brow reaches its full thickness.
 */
export function browBand(size: CanvasSize, brow: IllustrationBrow): Mask {
  const { width, height } = size;
  const m = new Uint8Array(width * height);
  const { line, halfWidth, tailHalfWidth } = brow;
  const lengths = [0];
  for (let k = 1; k < line.length; k++) {
    lengths.push(
      lengths[k - 1] +
        Math.hypot(line[k][0] - line[k - 1][0], line[k][1] - line[k - 1][1]),
    );
  }
  const total = lengths.at(-1)!;
  const halfAt = (s: number) =>
    total > 0
      ? tailHalfWidth +
        (halfWidth - tailHalfWidth) * Math.min(1, (3 * s) / total)
      : halfWidth;
  for (let k = 0; k + 1 < line.length; k++) {
    const [ax, ay] = line[k];
    const [bx, by] = line[k + 1];
    const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
    const reach = Math.max(halfAt(lengths[k]), halfAt(lengths[k + 1]));
    const xa = Math.max(0, Math.floor(Math.min(ax, bx) - reach));
    const xb = Math.min(width - 1, Math.ceil(Math.max(ax, bx) + reach));
    const ya = Math.max(0, Math.floor(Math.min(ay, by) - reach));
    const yb = Math.min(height - 1, Math.ceil(Math.max(ay, by) + reach));
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        const t =
          len2 > 0
            ? Math.max(
                0,
                Math.min(
                  1,
                  ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / len2,
                ),
              )
            : 0;
        const d = Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay));
        const s = lengths[k] + t * (lengths[k + 1] - lengths[k]);
        if (d <= halfAt(s)) m[y * width + x] = 1;
      }
    }
  }
  return m;
}

/** 4-connected pieces of a mask: each pixel's piece id (-1 off the mask)
 *  and each piece's size. */
function pieces(
  size: CanvasSize,
  m: Mask,
): { id: Int32Array; sizes: number[] } {
  const { width, height } = size;
  const id = new Int32Array(width * height).fill(-1);
  const sizes: number[] = [];
  const queue = new Int32Array(width * height);
  for (let s = 0; s < m.length; s++) {
    if (!m[s] || id[s] >= 0) continue;
    const k = sizes.length;
    let head = 0;
    let tail = 0;
    id[s] = k;
    queue[tail++] = s;
    while (head < tail) {
      const i = queue[head++];
      const x = i % width;
      const visit = (j: number) => {
        if (m[j] && id[j] < 0) {
          id[j] = k;
          queue[tail++] = j;
        }
      };
      if (x > 0) visit(i - 1);
      if (x < width - 1) visit(i + 1);
      if (i >= width) visit(i - width);
      if (i < (height - 1) * width) visit(i + width);
    }
    sizes.push(tail);
  }
  return { id, sizes };
}

/** Hair pieces smaller than SPECK_PX ringed mostly by paint that is not hair
 *  (a hair-coloured button, a blush speck) leave the hair; hair beside one
 *  counts in its ring but not as that paint. */
export function dropSpecks(size: CanvasSize, hair: Mask, solid: Mask): Mask {
  const { id, sizes } = pieces(size, hair);
  const small = new Uint8Array(hair.length);
  for (let i = 0; i < hair.length; i++) {
    if (id[i] >= 0 && sizes[id[i]] < SPECK_PX) small[i] = 1;
  }
  const ringOf = andNot(dilate(size, small, 2), small);
  // Each ring pixel counts once toward every small piece within 2 px of it.
  const paint = new Float64Array(sizes.length);
  const total = new Float64Array(sizes.length);
  const { width, height } = size;
  const seen = new Int32Array(25);
  for (let i = 0; i < hair.length; i++) {
    if (!ringOf[i]) continue;
    const x = i % width;
    const y = (i / width) | 0;
    let nSeen = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        const k = id[j];
        if (k < 0 || !small[j]) continue;
        let dup = false;
        for (let q = 0; q < nSeen && !dup; q++) dup = seen[q] === k;
        if (dup) continue;
        seen[nSeen++] = k;
        total[k]++;
        if (solid[i] && !hair[i]) paint[k]++;
      }
    }
  }
  const out = new Uint8Array(hair);
  for (let i = 0; i < hair.length; i++) {
    const k = id[i];
    if (k >= 0 && small[i] && paint[k] > SPECK_RING_SHARE * total[k]) {
      out[i] = 0;
    }
  }
  return out;
}

/** Hair pieces of at least SPECK_PX: the hair a fill may run on from. */
function bigPieces(size: CanvasSize, hair: Mask): Mask {
  const { id, sizes } = pieces(size, hair);
  return hair.map((v, i) => (v && sizes[id[i]] >= SPECK_PX ? 1 : 0));
}

/**
 * Unlabelled painted pixels take the label of the nearest labelled one:
 * first along paint, so ink joined to the hair goes with the hair rather
 * than across the backdrop to the body; then across anything, for paint no
 * labelled paint touches. Hair never spreads into `noHair`. Ties go to the
 * label reached first in row-major order.
 */
export function spreadLabels(
  size: CanvasSize,
  label: Uint8Array,
  fg: Mask,
  noHair: Mask,
): void {
  const { width, height } = size;
  const grow = (through: (j: number) => boolean, mark: Uint8Array) => {
    const queue = new Int32Array(width * height);
    let head = 0;
    let tail = 0;
    for (let i = 0; i < label.length; i++) if (mark[i]) queue[tail++] = i;
    while (head < tail) {
      const i = queue[head++];
      const x = i % width;
      const hair = mark[i] === LABEL_HAIR;
      const visit = (j: number) => {
        if (!mark[j] && through(j) && !(hair && noHair[j])) {
          mark[j] = mark[i];
          queue[tail++] = j;
        }
      };
      if (x > 0) visit(i - 1);
      if (x < width - 1) visit(i + 1);
      if (i >= width) visit(i - width);
      if (i < (height - 1) * width) visit(i + width);
    }
  };
  grow((j) => fg[j] === 1, label);
  let left = false;
  for (let i = 0; i < label.length && !left; i++) {
    left = fg[i] === 1 && label[i] === LABEL_NONE;
  }
  if (!left) return;
  const near = new Uint8Array(label);
  grow(() => true, near);
  for (let i = 0; i < label.length; i++) {
    if (fg[i] && !label[i]) label[i] = near[i];
  }
}

/** The pixels of `through` a 4-connected path inside `through` joins to
 *  `from` within `steps` px. */
export function reachThrough(
  size: CanvasSize,
  from: Mask,
  through: Mask,
  steps: number,
): Mask {
  const { width, height } = size;
  const out = new Uint8Array(width * height);
  let front: number[] = [];
  for (let i = 0; i < from.length; i++) if (from[i]) front.push(i);
  for (let s = 0; s < steps && front.length > 0; s++) {
    const next: number[] = [];
    const visit = (j: number) => {
      if (through[j] && !out[j] && !from[j]) {
        out[j] = 1;
        next.push(j);
      }
    };
    for (const i of front) {
      const x = i % width;
      if (x > 0) visit(i - 1);
      if (x < width - 1) visit(i + 1);
      if (i >= width) visit(i - width);
      if (i < (height - 1) * width) visit(i + width);
    }
    front = next;
  }
  return out;
}

/** Where a side cut's boundary lies on row y: along its line, straight up
 *  from the first point above it, and at `below` under its last. */
function sideLineX(
  cut: Extract<IllustrationCustomCut, { side: string }>,
  y: number,
): number {
  const ln = cut.line;
  if (y <= ln[0][1]) return ln[0][0];
  for (let k = 0; k + 1 < ln.length; k++) {
    const [ax, ay] = ln[k];
    const [bx, by] = ln[k + 1];
    if (y <= by) return ax + ((y - ay) / (by - ay)) * (bx - ax);
  }
  return cut.below;
}

/** One custom part's pixels, taken from `hairBack`. */
function cutPart(
  size: CanvasSize,
  cut: IllustrationCustomCut,
  hairBack: Mask,
  classes: Uint8Array,
): Mask {
  if ("polygon" in cut) return and(polygonMask(size, cut.polygon), hairBack);
  const { width, height } = size;
  const m = new Uint8Array(width * height);
  const ribbon = cut.ribbonBox ? boxMask(size, cut.ribbonBox) : undefined;
  const left = cut.side === "left";
  for (let y = 0; y < height; y++) {
    const lx = sideLineX(cut, y);
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!hairBack[i]) continue;
      if (left ? x < lx : x > lx) m[i] = 1;
      else if (ribbon?.[i] && classes[i] === NEITHER) m[i] = 1;
    }
  }
  return m;
}

export interface CutPart {
  cut: IllustrationCustomCut;
  mask: Mask;
}

export interface IllustrationLabels {
  /** Per pixel: LABEL_FACE, LABEL_HAIR, LABEL_BODY, LABEL_NONE off paint. */
  label: Uint8Array;
  /** The colour classes the labels started from. */
  classes: Uint8Array;
  fg: Mask;
  solid: Mask;
  /** The skin the face's flood reached from `skinSeeds`. */
  skin: Mask;
  face: Mask;
  body: Mask;
  /** All of the hair; the three below split it. */
  hair: Mask;
  hairFront: Mask;
  /** The head's hair behind the face, every custom part taken out. */
  hairBack: Mask;
  parts: CutPart[];
  /** Hair in pieces big enough to run on under the body's edge. */
  bigHair: Mask;
  /** Where nothing is hair whatever its colour. */
  noHair: Mask;
  frontHairArea: Mask;
  skullArea: Mask;
  bodyOnlyArea: Mask;
}

/** Where nothing is hair whatever its colour: the eye boxes, the brow
 *  bands, the nose and mouth boxes and the `bodyOnly` polygons. */
function noHairRegions(
  size: CanvasSize,
  lm: IllustrationLandmarks,
): { noHair: Mask; bodyOnlyArea: Mask } {
  const bodyOnlyArea = new Uint8Array(size.width * size.height);
  for (const poly of lm.bodyOnly) {
    const m = polygonMask(size, poly);
    for (let i = 0; i < m.length; i++) if (m[i]) bodyOnlyArea[i] = 1;
  }
  const regions: Mask[] = [
    boxMask(size, lm.eyes.L.box),
    boxMask(size, lm.eyes.R.box),
    boxMask(size, lm.mouth.box),
    bodyOnlyArea,
  ];
  if (lm.nose) regions.push(boxMask(size, lm.nose.box));
  for (const brow of [lm.brows?.L, lm.brows?.R]) {
    if (brow) regions.push(browBand(size, brow));
  }
  return { noHair: regions.reduce(or), bodyOnlyArea };
}

/** Hair by colour, off the never-hair regions; speckle smoothed only where
 *  hair lies over skin (a thin strand against the backdrop keeps its raw
 *  mask), then the specks other paint rings dropped. */
function colourHair(
  pic: Illustration,
  lm: IllustrationLandmarks,
  classes: Uint8Array,
  noHair: Mask,
  solid: Mask,
  skullArea: Mask,
): Mask {
  const size: CanvasSize = pic;
  const { alpha } = pic;
  const hair: Mask = classes.map((c, i) =>
    c === HAIR && alpha[i] > HAIR_ALPHA && !noHair[i] ? 1 : 0,
  );
  const head = boxMask(size, headBox(size, lm, skullArea));
  const sm = majority(size, hair, SMOOTH_RADIUS);
  for (let i = 0; i < hair.length; i++) {
    if (head[i]) hair[i] = sm[i] && !noHair[i] && alpha[i] > HAIR_ALPHA ? 1 : 0;
  }
  return dropSpecks(size, hair, solid);
}

/**
 * Near-black hair takes the lines drawn in the same ink. Thin hair (under
 * 2 THIN_RADIUS + 1 px) that a path through paint joins to the face's or
 * the neck's skin within THIN_BESIDE_SKIN px, outside the front hair, is
 * such a line and leaves the hair; anywhere else thin hair stays hair.
 */
export function releaseLines(
  size: CanvasSize,
  hair: Mask,
  skin: Mask,
  solid: Mask,
  frontHairArea: Mask,
): Mask {
  const core = dilate(size, erode(size, hair, THIN_RADIUS), THIN_RADIUS);
  const band = reachThrough(size, skin, solid, THIN_BESIDE_SKIN);
  return hair.map((v, i) =>
    v && !core[i] && band[i] && !frontHairArea[i] ? 0 : v,
  );
}

/** The face: its skin flood, its outline (OUTLINE_PX into paint that is not
 *  hair) and everything they enclose. */
function faceOf(size: CanvasSize, skin: Mask, hair: Mask, fg: Mask): Mask {
  const outline = and(dilate(size, skin, OUTLINE_PX), andNot(fg, hair));
  return and(fillHoles(size, or(skin, outline)), fg);
}

/**
 * With a `neither` class the hair's own outline is unlabelled, and a body
 * flood would run along it: ink within INK_REACH of the hair, and a drawn
 * line joined to it along LINE_REACH px of the line, is the hair's.
 */
export function joinInk(size: CanvasSize, hair: Mask, ink: Mask): Mask {
  const line = andNot(
    ink,
    dilate(size, erode(size, ink, LINE_RADIUS), LINE_RADIUS),
  );
  const nearHair = dilate(size, hair, INK_REACH);
  const alongLine = reachThrough(size, hair, line, LINE_REACH);
  return hair.map((v, i) =>
    v || (ink[i] && (nearHair[i] || alongLine[i])) ? 1 : 0,
  );
}

/**
 * Label every painted pixel of `pic`. `classes` comes from
 * `classifyPicture` over the same picture.
 */
export function labelIllustration(
  pic: Illustration,
  lm: IllustrationLandmarks,
  classes: Uint8Array,
): IllustrationLabels {
  const size: CanvasSize = pic;
  const n = pic.width * pic.height;
  const fg = Uint8Array.from(pic.alpha, (a) => (a > PAINT_ALPHA ? 1 : 0));
  const solid = Uint8Array.from(pic.alpha, (a) => (a > SOLID_ALPHA ? 1 : 0));
  const { noHair, bodyOnlyArea } = noHairRegions(size, lm);
  const skullArea = polygonMask(size, lm.skull);
  const frontHairArea = polygonMask(size, lm.frontHair);

  let hair = colourHair(pic, lm, classes, noHair, solid, skullArea);
  const skinPass = classes.map((c, i) =>
    solid[i] && c === SKIN && !hair[i] ? 1 : 0,
  );
  const skin = flood(size, skinPass, lm.skinSeeds);
  const neck = flood(size, skinPass, lm.bodySeeds);
  hair = releaseLines(size, hair, or(skin, neck), solid, frontHairArea);
  const face = faceOf(size, skin, hair, fg);
  hair = joinInk(
    size,
    hair,
    classes.map((c, i) =>
      solid[i] && c === NEITHER && !face[i] && !noHair[i] ? 1 : 0,
    ),
  );
  const bodyPass = classes.map((c, i) =>
    solid[i] && !hair[i] && !face[i] && (c !== HAIR || bodyOnlyArea[i]) ? 1 : 0,
  );
  const body = flood(size, bodyPass, lm.bodySeeds);

  const label = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    label[i] = face[i]
      ? LABEL_FACE
      : hair[i]
        ? LABEL_HAIR
        : body[i] || (bodyOnlyArea[i] && fg[i])
          ? LABEL_BODY
          : LABEL_NONE;
  }
  spreadLabels(size, label, fg, noHair);
  // Hair the face and the front hair close in (an ear's inner shading
  // between the ear's line and a strand) is the face's: it is no part of
  // the back hair's mass.
  const headCover = label.map((l, i) =>
    l === LABEL_FACE || (l === LABEL_HAIR && frontHairArea[i]) ? 1 : 0,
  );
  const enclosed = fillHoles(size, headCover);
  for (let i = 0; i < n; i++) {
    if (enclosed[i] && !headCover[i] && label[i] === LABEL_HAIR) {
      label[i] = LABEL_FACE;
    }
  }

  const is = (v: number) => label.map((l) => (l === v ? 1 : 0));
  const hairL = is(LABEL_HAIR);
  const hairFront = and(hairL, frontHairArea);
  let hairBack = andNot(hairL, frontHairArea);
  const parts: CutPart[] = [];
  for (const cut of lm.customParts) {
    const mask = cutPart(size, cut, hairBack, classes);
    hairBack = andNot(hairBack, mask);
    parts.push({ cut, mask });
  }

  return {
    label,
    classes,
    fg,
    solid,
    skin,
    face: is(LABEL_FACE),
    body: is(LABEL_BODY),
    hair: hairL,
    hairFront,
    hairBack,
    parts,
    bigHair: bigPieces(size, hairL),
    noHair,
    frontHairArea,
    skullArea,
    bodyOnlyArea,
  };
}

/** Where hair lies over skin: the skull's box, the eyes' and the mouth's,
 *  down to the mouth. */
function headBox(
  size: CanvasSize,
  lm: IllustrationLandmarks,
  skullArea: Mask,
): Box {
  const boxes: Box[] = [lm.eyes.L.box, lm.eyes.R.box, lm.mouth.box];
  const skull = maskBox(size, skullArea);
  if (skull) boxes.push(skull);
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ];
}
