/**
 * The features of an in-place cut: each eye split into the layers the rig's
 * eye roles expect (the sclera, the iris, the upper lash and the lower lid,
 * as the composer splits one drawn eye), the brows, the nose and the drawn
 * closed mouth; and the checks on the landmarks they were cut by.
 *
 * Every colour judgement here is relative: to the hair and skin samples, to
 * the paint just around a feature, or to the eye's own paint (its ink
 * against its white). Two pixels count as one paint only within the skin's
 * own noise (`samePaint`).
 */

import { LASH_KEEP_FRACTION } from "./compose";
import {
  and,
  andNot,
  boxMask,
  count,
  dilate,
  erode,
  fillHoles,
  median,
  or,
  type Box,
  type Illustration,
  type Mask,
} from "./illustration";
import {
  dist,
  HAIR,
  segmentDistance,
  SKIN,
  srgbToOklab,
  type Lab,
} from "./illustration-colour";
import {
  fillFrom,
  paintOf,
  skinSources,
  SOURCE_INSET,
  type CutCheck,
  type CutContext,
  type LayerPaint,
} from "./illustration-context";
import {
  browGeometry,
  LABEL_HAIR,
  maskBox,
  pieces,
  reachThrough,
} from "./illustration-labels";
import type { IllustrationBrow } from "./illustration-landmarks";

/** A skin sample's patch noise times this is still that skin: the
 *  classifier counts a set's reach the same way. */
const NOISE_SCALE = 3;
/** Levels per 8-bit channel under which two pixels are one paint on a flat
 *  picture: the resize's ringing beside a line and a PNG's rounding. Lower
 *  takes that ringing into a feature (a pixel-wide halo of skin round it);
 *  higher leaves a faint stroke's edge on the face. */
const SAME_PAINT_LEVELS = 4;
/** The darkest, and the lightest, this share of an eye's paint outside its
 *  iris ellipse: its lash ink, and its white. Larger reaches the white's
 *  shading and the lash's soft edge. */
const EYE_EXTREME_SHARE = 0.1;
/** The iris's own colour is read on the ellipse's lower ring between these
 *  shares of its radii: off the pupil in its middle, off the outline at its
 *  rim, under the lid. */
const IRIS_RING_IN = 0.5;
const IRIS_RING_OUT = 0.9;
/** A piece detached above the lash under this share of the eye's main
 *  piece is the lid's crease, left on the face. Larger takes a detached
 *  lash flick to the face; smaller keeps a long crease in the eye, where
 *  the blink fold carries it into the iris. */
const CREASE_SHARE = 0.25;
/** Radius of the closing that takes a highlight on the iris's edge back
 *  into it, px. Under a highlight's half-width leaves a notch in the iris;
 *  over it bridges into the white beside the disc. */
const IRIS_CLOSE = 3;
/** The iris takes this many px of its soft edge against the white: the
 *  resize's blend, about two px on a picture under the canvas's size. */
const IRIS_RIM = 2;
/** An eye covering under this share of its box: the box is loose and takes
 *  the lines and shading round the eye into it. */
const LOOSE_SHARE = 0.2;
/** The ellipse overlapping the disc found by under this (intersection over
 *  union) is off it: the iris layer then holds white or loses its edge.
 *  Measured: a well-placed ellipse 0.84 on the test's 13 x 17 px disc and
 *  0.80 on a painted eye (the disc's soft edge is not counted in it); 3 px
 *  off the test's disc 0.68, 10 px off 0.38. */
const IRIS_IOU = 0.7;
/** Radius of the closing that joins the disc's colour over its pupil and
 *  highlight for the iris check, px. */
const DISC_CLOSE = 2;
/** Iris-coloured paint this far past the ellipse (a share of its radius
 *  along each axis) and joined to the iris is the iris's: a disc drawn
 *  squarer than an ellipse puts its corners there. Farther takes another
 *  feature's colour; nearer leaves the corners on the lids. */
const IRIS_MARGIN = 0.25;
/** Columns either side of the iris ellipse the lash's thickness is read on,
 *  to carry the lid across an iris shaded as dark as the lash, and a lower
 *  lid's line is looked for on. */
const LID_SIDE = 4;
/** Rows of paint lighter than the lash's ink, though nearer it than the
 *  white, that a run of the lash's ink carries on through: a streak drawn
 *  along the lash. Larger carries the run from the lash on into a pupil set
 *  close under it; smaller ends the lash at the streak, and its lower rows
 *  go to the iris. */
const LID_STREAK = 6;
/** The eye takes this many px of rim past its paint, where it differs from
 *  the skin around: its soft edge. */
const EYE_EDGE = 2;
/** Px the `opening` hint leaves between the eye's paint, rim included,
 *  and the box it suggests: the least of the 2 to 4 px to spare the skill
 *  asks for (the rim adds up to EYE_EDGE more). */
const OPENING_SPARE = 2;
/** Paint outside an eye box that runs on past it farther than this share
 *  of the box's smaller side is a strand or a line passing the eye, not
 *  the eye: a lash wing a box clips runs on a few px. */
const STROKE_PAST_SHARE = 0.5;
/** Pieces of an eye's paint this close to such a stroke, px, are the
 *  stroke's: an antialiased thin stroke breaks into pieces this far apart. */
const STROKE_GAP = 2;
/** Paint this close to hair crossing an eye box is the hair's soft edge, not
 *  the eye's; the hair labels' own reach for ink beside hair. */
const HAIR_EDGE = 3;
/** A band pixel at least this share of the way from the paint around it,
 *  from the skin samples and (near hair) from the hair samples toward the
 *  brow's ink is the brow's: a pale brow is a mix of brow and skin, a brow
 *  drawn through the bangs a mix of brow and hair. Higher leaves the pale
 *  part behind when the brow moves (the trace this rule exists for); lower
 *  takes the skin's and the hair's own shading. */
const BROW_SHARE = 0.2;
/** The brow's ink is the median colour of this share of its band's paint
 *  farthest from the paint around it. */
const BROW_CORE_SHARE = 0.2;
/** Ink this close to hair, px, is the hair's soft edge, not brow left
 *  past the band. Wider also skips the hair's own outline where the face
 *  takes it, but with it the brow's lower edge between close strands; an
 *  outline lying along the brow past its band can then read as brow, which
 *  is why `browBand` only warns. */
const HAIR_LINE = 1;
/** The brow takes this many px past its judged pixels, paint that differs
 *  from the paint around: a soft stroke's faint rim and the resize's
 *  overshoot beside it, a light halo left on the face when the brow moves
 *  at 1. */
const BROW_EDGE = 2;
/** Hair within this many px of a band pixel is what a mix there may be
 *  with; farther, the pixel is judged against skin and the paint around
 *  only, so a pale brow on skin is not called hair. */
const HAIR_NEAR = 2;
/** A nose or mouth mark grows this many px: its soft edge, which differs
 *  from the skin too little to be told by colour. */
const MARK_EDGE = 2;

/** Rows a lower lid followed across the iris may drift per column: a lid's
 *  curve, under 45 degrees over the iris. */
const LID_DRIFT = 1;
/** Paint more than this many times `samePaint` off the blends of an eye's
 *  ink and the skin around it is a paint of its own, a white, however
 *  shaded; a drawn closed eye's light paint (its line's soft edge, and the
 *  resize's overshoot beside it) lies within it. */
const WHITE_SCALE = 3;
/** An eye with under this share of its paint white has no white to speak
 *  of and is drawn closed. Measured: open test eyes 0.19 to 0.26, a painted
 *  eye with a pale, shaded white 0.135, a closed test eye 0.02 (its line's
 *  overshoot); this sits between the last two by ratio. */
const WHITE_SHARE = 0.06;

const fmt = (v: number, digits = 3) => Number(v.toFixed(digits));
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

const labOf = (rgb: Float32Array, i: number): Lab =>
  srgbToOklab(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);

/** The median colour, per sRGB channel, of pixels `idx` of `rgb`. */
function medianColour(
  rgb: Float32Array,
  idx: number[],
): { rgb: [number, number, number]; lab: Lab } {
  const c = [0, 1, 2].map((k) => median(idx.map((i) => rgb[i * 3 + k]))) as [
    number,
    number,
    number,
  ];
  return { rgb: c, lab: srgbToOklab(...c) };
}

interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A box's pixel bounds on the canvas, as `boxMask` takes them. */
function bounds(pic: Illustration, [x0, y0, x1, y1]: Box): Bounds {
  return {
    x0: Math.max(0, Math.ceil(x0)),
    y0: Math.max(0, Math.ceil(y0)),
    x1: Math.min(pic.width - 1, Math.floor(x1)),
    y1: Math.min(pic.height - 1, Math.floor(y1)),
  };
}

/**
 * The distance under which two colours are the same skin: the skin
 * samples' own noise, scaled as the classifier scales it, and at least
 * SAME_PAINT_LEVELS of rounding at the skin's base colour, which a flat
 * picture with no noise still has beside every line.
 */
function samePaint(ctx: CutContext): number {
  const skin = ctx.reads.skin.filter((r) => r.lab !== null);
  const noises = skin.map((r) => r.noise).sort((a, b) => a - b);
  const noise = noises[(noises.length - 1) >> 1];
  const base = skin[0].rgb!;
  const rounded = base.map((v) => v - SAME_PAINT_LEVELS) as [
    number,
    number,
    number,
  ];
  return Math.max(
    NOISE_SCALE * noise,
    dist(srgbToOklab(...base), srgbToOklab(...rounded)),
  );
}

/**
 * Skin, round a feature: skin by colour, and either within `same` of the
 * skin filled over the feature from around it (`around`), or no farther
 * from the skin samples than that skin is, as shading the samples cover
 * is. An eye's white, often skin by colour, is neither.
 */
function skinTest(
  ctx: CutContext,
  around: Float32Array,
  same: number,
): (i: number) => boolean {
  const { pic, labels, classifier } = ctx;
  const rgb = pic.rgb;
  return (i) => {
    if (labels.classes[i] !== SKIN) return false;
    if (dist(labOf(rgb, i), labOf(around, i)) <= same) return true;
    const own = classifier.distances(
      rgb[i * 3],
      rgb[i * 3 + 1],
      rgb[i * 3 + 2],
    );
    const local = classifier.distances(
      around[i * 3],
      around[i * 3 + 1],
      around[i * 3 + 2],
    );
    return own.skin <= local.skin + same;
  };
}

// ---- eyes ----

type Side = "L" | "R";

/** Where one eye is cut: its box and its iris ellipse. */
interface EyeFrame {
  side: Side;
  /** `landmarks.eyes.<side>`, for hints. */
  at: string;
  b: Bounds;
  inBox: Mask;
  /** The ellipse's pixels inside the box. */
  ellipse: Mask;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

function eyeFrame(ctx: CutContext, side: Side): EyeFrame {
  const { pic, lm } = ctx;
  const { box, iris } = lm.eyes[side];
  const b = bounds(pic, box);
  const ellipse = new Uint8Array(pic.width * pic.height);
  for (let y = b.y0; y <= b.y1; y++) {
    for (let x = b.x0; x <= b.x1; x++) {
      const u = (x - iris.cx) / iris.rx;
      const v = (y - iris.cy) / iris.ry;
      if (u * u + v * v <= 1) ellipse[y * pic.width + x] = 1;
    }
  }
  return {
    side,
    at: `landmarks.eyes.${side}`,
    b,
    inBox: boxMask(pic, box),
    ellipse,
    ...iris,
  };
}

/** Pixels outside an eye's box, Chebyshev, of (x, y): 0 inside it. */
function pastBox(b: Bounds, x: number, y: number): number {
  return Math.max(b.x0 - x, x - b.x1, b.y0 - y, y - b.y1, 0);
}

/**
 * Paint outside the box (any label, hair included; not skin) that runs on
 * past it farther than STROKE_PAST_SHARE of the box's smaller side, from
 * within STROKE_GAP + EYE_EDGE px of the box: a strand or a line passing
 * the eye. Followed across gaps of up to STROKE_GAP px, as a thin
 * antialiased stroke breaks.
 */
function longStrokes(
  ctx: CutContext,
  f: EyeFrame,
  isSkin: (i: number) => boolean,
): { long: Mask; past: number } {
  const { pic, labels } = ctx;
  const { width, height } = pic;
  const { b } = f;
  const past = Math.max(
    1,
    Math.round(STROKE_PAST_SHARE * Math.min(b.x1 - b.x0 + 1, b.y1 - b.y0 + 1)),
  );
  const wx0 = Math.max(0, b.x0 - past);
  const wx1 = Math.min(width - 1, b.x1 + past);
  const wy0 = Math.max(0, b.y0 - past);
  const wy1 = Math.min(height - 1, b.y1 + past);
  const isPaint = (x: number, y: number) => {
    if (x < wx0 || x > wx1 || y < wy0 || y > wy1) return false;
    if (pastBox(b, x, y) === 0) return false;
    const i = y * width + x;
    return labels.solid[i] === 1 && !isSkin(i);
  };
  const long = new Uint8Array(width * height);
  const seen = new Uint8Array(width * height);
  const near = STROKE_GAP + EYE_EDGE;
  for (let y = wy0; y <= wy1; y++) {
    for (let x = wx0; x <= wx1; x++) {
      const d = pastBox(b, x, y);
      if (d === 0 || d > near || seen[y * width + x] || !isPaint(x, y)) {
        continue;
      }
      const queue = [y * width + x];
      seen[queue[0]] = 1;
      let far = 0;
      for (let q = 0; q < queue.length; q++) {
        const i = queue[q];
        const px = i % width;
        const py = (i - px) / width;
        far = Math.max(far, pastBox(b, px, py));
        for (let dy = -STROKE_GAP; dy <= STROKE_GAP; dy++) {
          for (let dx = -STROKE_GAP; dx <= STROKE_GAP; dx++) {
            const nx = px + dx;
            const ny = py + dy;
            if (!isPaint(nx, ny) || seen[ny * width + nx]) continue;
            seen[ny * width + nx] = 1;
            queue.push(ny * width + nx);
          }
        }
      }
      if (far >= past) for (const i of queue) long[i] = 1;
    }
  }
  return { long, past };
}

/** Where an eye was found in its box: its drawing, and the long strokes
 *  outside the box (`longStrokes`) that the drawing was cut clear of. */
interface EyeDrawing {
  eye: Mask;
  long: Mask;
  /** STROKE_PAST_SHARE of the box's smaller side, px. */
  past: number;
}

/**
 * The eye's drawing, the sclera's shape: what in its box is not skin
 * (`skinTest`), hair crossing the box and its soft edge left out (the labels
 * give the hair to the hair). The main piece and every other piece clear of
 * the box's border by more than its rim (EYE_EDGE) are the eye, but a small
 * piece detached above the lash,
 * the lid's crease, and pieces joined (across STROKE_GAP px) to a long
 * stroke outside the box or to hair crossing it (`strokePieces`): a strand
 * or a line crossing into the box, which stays with whatever it belongs to. Its holes are closed, and its soft rim
 * taken.
 */
function eyeDrawing(
  ctx: CutContext,
  f: EyeFrame,
  around: Float32Array,
  same: number,
): EyeDrawing {
  const { pic, labels } = ctx;
  const { width } = pic;
  const n = width * pic.height;
  const { b } = f;
  const isSkin = skinTest(ctx, around, same);
  // Hair crossing the box, and its soft edge: a blend of hair and skin that
  // is neither, and would join the eye to the strand.
  const hairEdge = dilate(
    pic,
    labels.label.map((l, i) => (l === LABEL_HAIR && f.inBox[i] ? 1 : 0)),
    HAIR_EDGE,
  );
  const paint = new Uint8Array(n);
  for (let y = b.y0; y <= b.y1; y++) {
    for (let x = b.x0; x <= b.x1; x++) {
      const i = y * width + x;
      if (labels.solid[i] && !hairEdge[i] && !isSkin(i)) paint[i] = 1;
    }
  }

  const { id, sizes } = pieces(pic, paint);
  let main = -1;
  const onBorder = new Set<number>();
  for (let y = b.y0; y <= b.y1; y++) {
    for (let x = b.x0; x <= b.x1; x++) {
      const k = id[y * width + x];
      if (k < 0) continue;
      if (main < 0 || sizes[k] > sizes[main]) main = k;
      // Within its rim of the border: the rim would reach it.
      if (
        x - b.x0 <= EYE_EDGE ||
        b.x1 - x <= EYE_EDGE ||
        y - b.y0 <= EYE_EDGE ||
        b.y1 - y <= EYE_EDGE
      ) {
        onBorder.add(k);
      }
    }
  }
  const { long, past } = longStrokes(ctx, f, isSkin);
  const strokes = strokePieces(pic, f, id, main, or(long, hairEdge));
  const eye0 = new Uint8Array(n);
  const creases = new Uint8Array(n);
  if (main >= 0) {
    // The main piece's top per column, and its rows.
    const mainTop = new Int32Array(width).fill(-1);
    let top = Infinity;
    let bottom = -Infinity;
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = b.x0; x <= b.x1; x++) {
        if (id[y * width + x] !== main) continue;
        if (mainTop[x] < 0) mainTop[x] = y;
        top = Math.min(top, y);
        bottom = y;
      }
    }
    const cut = top + LASH_KEEP_FRACTION * (bottom - top + 1);
    const above = new Map<number, boolean>();
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = b.x0; x <= b.x1; x++) {
        const k = id[y * width + x];
        if (k < 0 || k === main) continue;
        const ok =
          (mainTop[x] < 0 || y < mainTop[x]) &&
          y < cut &&
          (above.get(k) ?? true);
        above.set(k, ok);
      }
    }
    const crease = new Set<number>();
    for (const [k, ok] of above) {
      if (ok && sizes[k] < CREASE_SHARE * sizes[main]) crease.add(k);
    }
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = b.x0; x <= b.x1; x++) {
        const i = y * width + x;
        const k = id[i];
        if (k < 0 || strokes.has(k)) continue;
        if (crease.has(k)) creases[i] = 1;
        else if (k === main || !onBorder.has(k)) eye0[i] = 1;
      }
    }
  }
  // Its soft rim: the blends at its edge pass for shaded skin, and left on
  // the face they draw the eye's outline there once the eye shuts. Not
  // round a stroke it was cut clear of.
  const stroke = dilate(
    pic,
    Uint8Array.from(id, (k) => (k >= 0 && strokes.has(k) ? 1 : 0)),
    EYE_EDGE,
  );
  const eye = fillHoles(pic, eye0);
  const rim = dilate(pic, eye, EYE_EDGE);
  for (let y = b.y0; y <= b.y1; y++) {
    for (let x = b.x0; x <= b.x1; x++) {
      const i = y * width + x;
      if (
        rim[i] &&
        !eye[i] &&
        labels.solid[i] &&
        !hairEdge[i] &&
        !creases[i] &&
        !stroke[i] &&
        dist(labOf(pic.rgb, i), labOf(around, i)) > same
      ) {
        eye[i] = 1;
      }
    }
  }
  return { eye: and(eye, f.inBox), long, past };
}

/** The pieces of an eye's paint, but the main one, joined across
 *  STROKE_GAP px, directly or through each other, to a long stroke outside
 *  the box or to the soft edge of hair crossing it (`to`): a strand's own
 *  line, leading into the strand. */
function strokePieces(
  pic: Illustration,
  f: EyeFrame,
  id: Int32Array,
  main: number,
  to: Mask,
): Set<number> {
  const { width, height } = pic;
  const { b } = f;
  const out = new Set<number>();
  const joined = (x: number, y: number) => {
    for (let dy = -STROKE_GAP; dy <= STROKE_GAP; dy++) {
      for (let dx = -STROKE_GAP; dx <= STROKE_GAP; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (to[j] || (id[j] >= 0 && out.has(id[j]))) return true;
      }
    }
    return false;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = b.x0; x <= b.x1; x++) {
        const k = id[y * width + x];
        if (k < 0 || k === main || out.has(k) || !joined(x, y)) continue;
        out.add(k);
        changed = true;
      }
    }
  }
  return out;
}

/** The eye's own colours, and how each of its pixels reads against them. */
interface EyeColours {
  ink: { rgb: [number, number, number]; lab: Lab };
  white: { rgb: [number, number, number]; lab: Lab };
  iris: { rgb: [number, number, number]; lab: Lab };
  /** Nearer the ink than the white. */
  dark(i: number): boolean;
  /** Nearer the white than the ink and the iris. */
  isWhite(i: number): boolean;
  /** Nearer the iris than the ink and the white. */
  nearIris(i: number): boolean;
  /** The iris's own colour, darker or lighter (`irisLike`). */
  irisLike(i: number): boolean;
}

/**
 * Its ink (the darkest EYE_EXTREME_SHARE of its paint outside the ellipse),
 * its white (the lightest) and its iris (the ellipse's lower ring), each a
 * median colour. A pixel is iris-like when it lies nearer the iris's own
 * shades (the line from black through the iris's colour on to full
 * lightness: its hue, darker or lighter) than the blends of the ink and the
 * skin around (`skin`), which the lid lines are, and than the white: a
 * squarish disc's dark rim is iris-like, a lid line beside it is not.
 */
function eyeColours(
  pic: Illustration,
  f: EyeFrame,
  all: number[],
  skin: Lab,
): EyeColours {
  const { width } = pic;
  const outside: number[] = [];
  const ring: number[] = [];
  for (const i of all) {
    const x = i % width;
    const y = (i - x) / width;
    if (!f.ellipse[i]) outside.push(i);
    const r = Math.hypot((x - f.cx) / f.rx, (y - f.cy) / f.ry);
    if (y > f.cy && r >= IRIS_RING_IN && r <= IRIS_RING_OUT) ring.push(i);
  }
  const byL = (outside.length > 0 ? outside : all)
    .map((i) => ({ i, l: labOf(pic.rgb, i)[0] }))
    .sort((p, q) => p.l - q.l);
  const share = Math.max(1, Math.ceil(byL.length * EYE_EXTREME_SHARE));
  const ink = medianColour(
    pic.rgb,
    byL.slice(0, share).map((p) => p.i),
  );
  const white = medianColour(
    pic.rgb,
    byL.slice(-share).map((p) => p.i),
  );
  const iris = medianColour(pic.rgb, ring.length > 0 ? ring : all);
  const dK = new Map<number, number>();
  const dW = new Map<number, number>();
  const dI = new Map<number, number>();
  for (const i of all) {
    const lab = labOf(pic.rgb, i);
    dK.set(i, dist(lab, ink.lab));
    dW.set(i, dist(lab, white.lab));
    dI.set(i, dist(lab, iris.lab));
  }
  const k = (i: number) => dK.get(i) ?? Infinity;
  const w = (i: number) => dW.get(i) ?? Infinity;
  const r = (i: number) => dI.get(i) ?? Infinity;
  const black: Lab = [0, 0, 0];
  const L = Math.max(iris.lab[0], 1e-6);
  const light: Lab = [1, iris.lab[1] / L, iris.lab[2] / L];
  return {
    ink,
    white,
    iris,
    dark: (i) => k(i) < w(i),
    isWhite: (i) => w(i) < k(i) && w(i) < r(i),
    nearIris: (i) => r(i) <= k(i) && r(i) < w(i),
    irisLike: (i) => {
      const lab = labOf(pic.rgb, i);
      const tone = segmentDistance(lab, black, light);
      return (
        tone < segmentDistance(lab, skin, ink.lab) &&
        tone < dist(lab, white.lab)
      );
    },
  };
}

/**
 * How far a colour lies off the blends of the eye's ink and the skin
 * around it (`skin`), in units of `same`: over WHITE_SCALE it is a paint of
 * its own. A drawn closed eye's light paint is the soft edge of its line,
 * such a blend.
 */
function offBlend(lab: Lab, skin: Lab, c: EyeColours, same: number): number {
  return segmentDistance(lab, skin, c.ink.lab) / same;
}

/** The share of the eye's paint that is white: nearer its white than its
 *  ink and iris, and a paint of its own (`offBlend`). */
function whiteShare(
  pic: Illustration,
  c: EyeColours,
  all: number[],
  skin: Lab,
  same: number,
): number {
  let white = 0;
  for (const i of all) {
    if (
      c.isWhite(i) &&
      offBlend(labOf(pic.rgb, i), skin, c, same) > WHITE_SCALE
    ) {
      white++;
    }
  }
  return white / all.length;
}

/** The rows the eye's drawing spans, and the row LASH_KEEP_FRACTION down
 *  them that splits the upper lash from the lower lid, as the composer
 *  splits a drawn eye. */
function lashCutOf(pic: Illustration, all: number[]): number {
  let top = Infinity;
  let bottom = -Infinity;
  for (const i of all) {
    const y = Math.floor(i / pic.width);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  return top + LASH_KEEP_FRACTION * (bottom - top + 1);
}

/**
 * The upper lid: per column, the bottom row of the lash's ink (-1 with
 * none), at most the iris's centre row, so a pupil touching the lash does
 * not carry it down. Beside the ellipse it is read from the eye's inside
 * (the first ink above the centre row), or from the eye's top where the
 * lash itself hangs to the centre row. Over the ellipse, where the pupil
 * lies in between, it is the lash's run of ink from the eye's top, a flick
 * standing clear above the lash passed over. Either way a lighter streak
 * along the lash (LID_STREAK) is carried through. Over the ellipse the run
 * ends no deeper than the lash's top plus the lash's thickness beside the
 * ellipse (LID_SIDE columns either side, carried across in a straight
 * line): an iris shaded as dark as the lash at its top runs on from the
 * lash in colour.
 */
function upperLid(
  pic: Illustration,
  f: EyeFrame,
  eye: Mask,
  c: EyeColours,
): Int32Array {
  const { width } = pic;
  const { b, cx, cy, rx } = f;
  const mid = Math.min(b.y1, Math.floor(cy));
  const lid = new Int32Array(width).fill(-1);
  const dark = (x: number, y: number) => {
    const i = y * width + x;
    return eye[i] === 1 && c.dark(i);
  };
  const ink = (x: number, y: number) =>
    dark(x, y) && !c.nearIris(y * width + x);
  /** The run's top with its soft edge, a blend of the ink and the skin
   *  that may read nearer the iris's colour. */
  const softTop = (x: number, top: number) => {
    let y = top;
    while (y - 1 >= b.y0 && top - (y - 1) <= EYE_EDGE && dark(x, y - 1)) y--;
    return y;
  };
  /** The last row of the run of ink holding row `y`, going `step` (1 down,
   *  -1 up) no farther than the centre row: a streak of up to LID_STREAK
   *  rows of dark paint that is not ink is carried through where ink
   *  follows it. */
  const runEnd = (x: number, y: number, step: number) => {
    const inside = (r: number) => r >= b.y0 && r <= mid;
    for (;;) {
      while (inside(y + step) && ink(x, y + step)) y += step;
      let rows = 0;
      while (rows <= LID_STREAK) {
        const r = y + step * (rows + 1);
        if (!inside(r) || !dark(x, r) || ink(x, r)) break;
        rows++;
      }
      const next = y + step * (rows + 1);
      if (rows === 0 || rows > LID_STREAK || !inside(next) || !ink(x, next)) {
        return y;
      }
      y = next;
    }
  };
  /** The lash's [top, bottom] rows read from the eye's top: the first run
   *  of ink, or the one after it wherever skin shows in between. */
  const fromTop = (x: number): [number, number] | null => {
    let run: [number, number] | null = null;
    let skin = false;
    for (let y = b.y0; y <= mid; y++) {
      if (!ink(x, y)) {
        if (eye[y * width + x] === 0) skin = true;
        continue;
      }
      if (run !== null && !skin) break;
      const top = y;
      y = runEnd(x, y, 1);
      run = [softTop(x, top), y];
      skin = false;
    }
    return run;
  };
  /** The same read from the eye's inside, where no pupil lies between. */
  const fromInside = (x: number): [number, number] | null => {
    let y = mid;
    // Ink on the centre row: the lash's wing hanging past it, or not the
    // lash at all.
    if (ink(x, y)) return null;
    while (y >= b.y0 && !ink(x, y)) y--;
    if (y < b.y0) return null;
    return [softTop(x, runEnd(x, y, -1)), y];
  };
  const x0 = Math.max(b.x0, Math.ceil(cx - rx));
  const x1 = Math.min(b.x1, Math.floor(cx + rx));
  for (let x = b.x0; x <= b.x1; x++) {
    if (x >= x0 && x <= x1) continue;
    const run = fromInside(x) ?? fromTop(x);
    if (run) lid[x] = run[1];
  }
  const thickness = (from: number, step: number): number | null => {
    const t: number[] = [];
    for (
      let x = from;
      t.length < LID_SIDE && x >= b.x0 && x <= b.x1;
      x += step
    ) {
      // Where the lash hangs to the centre row (a wing, or the lash beside
      // an iris as wide as the eye), its run from the top.
      const run = fromInside(x) ?? fromTop(x);
      if (run) t.push(run[1] - run[0] + 1);
    }
    return t.length > 0 ? median(t) : null;
  };
  const left = thickness(Math.floor(cx - rx) - 1, -1);
  const right = thickness(Math.ceil(cx + rx) + 1, 1);
  for (let x = x0; x <= x1; x++) {
    const run = fromTop(x);
    if (!run) continue;
    if (left === null && right === null) {
      lid[x] = run[1];
      continue;
    }
    const u = (x - (cx - rx)) / (2 * rx);
    const t =
      left === null
        ? right!
        : right === null
          ? left
          : left + (right - left) * u;
    lid[x] = Math.min(run[1], run[0] + Math.round(t) - 1);
  }
  return lid;
}

/**
 * The lower lid's ink across the iris, inside the ellipse. The lower lid is
 * drawn over the iris and folds with the white, so where its line crosses
 * the disc it is the lid's, not the iris's. It is found where it shows on
 * its own, just outside the ellipse (its lowest run of ink below `lashCut`
 * and clear of the upper lid, on LID_SIDE columns either side), and
 * followed across the ellipse column
 * by column, drifting at most LID_DRIFT rows per column and never thicker
 * than beside it. Without a lid line outside the ellipse on both sides,
 * dark paint at the disc's bottom is the iris's own outline, and nothing is
 * carried.
 */
function lowerLidAcross(
  pic: Illustration,
  f: EyeFrame,
  eye: Mask,
  c: EyeColours,
  lashCut: number,
  upper: Int32Array,
): Mask {
  const { width } = pic;
  const { b, cx, rx } = f;
  const out = new Uint8Array(width * pic.height);
  const lashInk = (x: number, y: number) => {
    const i = y * width + x;
    return y > lashCut && eye[i] === 1 && c.dark(i) && !c.nearIris(i);
  };
  const runAt = (x: number): [number, number] | null => {
    let y = b.y1;
    while (y > lashCut && !lashInk(x, y)) y--;
    if (y <= lashCut) return null;
    const bottom = y;
    while (lashInk(x, y - 1)) y--;
    // The upper lash's own corner, hanging below the cut, is no lower lid.
    return y > upper[x] ? [y, bottom] : null;
  };
  // A lid's line runs on past the ellipse: on every one of LID_SIDE columns,
  // drifting no more than it may across the iris. The iris's own outline
  // beside an ellipse set a px or two inside it is gone within a column or
  // two, or falls away steeply.
  const side = (from: number, step: number) => {
    const runs: [number, number][] = [];
    for (let k = 0; k < LID_SIDE; k++) {
      const x = from + k * step;
      const run = x < b.x0 || x > b.x1 ? null : runAt(x);
      const prev = runs[runs.length - 1];
      if (
        !run ||
        (prev && (run[0] > prev[1] + LID_DRIFT || run[1] < prev[0] - LID_DRIFT))
      ) {
        return [];
      }
      runs.push(run);
    }
    return runs;
  };
  const left = side(Math.floor(cx - rx) - 1, -1);
  const right = side(Math.ceil(cx + rx) + 1, 1);
  if (left.length === 0 || right.length === 0) return out;
  const thickness = median([...left, ...right].map(([t, bt]) => bt - t + 1));
  const follow = (start: [number, number], x0: number, x1: number) => {
    const step = x1 >= x0 ? 1 : -1;
    let [top, bottom] = start;
    for (let x = x0; x !== x1 + step; x += step) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let y = top - LID_DRIFT; y <= bottom + LID_DRIFT; y++) {
        if (y >= b.y0 && y <= b.y1 && lashInk(x, y)) {
          lo = Math.min(lo, y);
          hi = Math.max(hi, y);
        }
      }
      if (lo === Infinity) return; // the line ends
      if (hi - lo + 1 > thickness + 1) {
        lo = Math.max(lo, Math.round((top + bottom) / 2 - thickness / 2));
        hi = Math.min(hi, lo + thickness - 1);
      }
      for (let y = lo; y <= hi; y++) {
        if (lashInk(x, y)) out[y * width + x] = 1;
      }
      [top, bottom] = [lo, hi];
    }
  };
  follow(left[0], Math.floor(cx - rx), Math.ceil(cx + rx));
  follow(right[0], Math.ceil(cx + rx), Math.floor(cx - rx));
  return and(out, f.ellipse);
}

/**
 * The iris as it shows: the paint in the ellipse below the upper lid that
 * is not white, with the holes it closes (a highlight touching the lid
 * included: the part under the lash is counted in), the iris-like paint
 * joined to it within IRIS_MARGIN past the ellipse, and its soft rim
 * against the white; the lower lid's ink across it left out.
 */
function irisShown(
  pic: Illustration,
  f: EyeFrame,
  eye: Mask,
  all: number[],
  c: EyeColours,
  lid: Int32Array,
  lowerAcross: Mask,
  same: number,
): Mask {
  const { width } = pic;
  const n = width * pic.height;
  const coloured = new Uint8Array(n);
  const cap = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!f.ellipse[i]) continue;
    const x = i % width;
    if ((i - x) / width <= lid[x]) cap[i] = 1;
    else if (eye[i] && !c.isWhite(i)) coloured[i] = 1;
  }
  const shape = fillHoles(
    pic,
    erode(pic, dilate(pic, or(coloured, cap), IRIS_CLOSE), IRIS_CLOSE),
  );
  const inEllipse = and(and(shape, andNot(f.ellipse, cap)), eye);
  // A disc squarer than the ellipse: its corners past the ellipse, joined
  // to it and iris-like, are the iris's, not the lids'.
  const margin = new Uint8Array(n);
  for (const i of all) {
    const x = i % width;
    const y = (i - x) / width;
    const r = Math.hypot((x - f.cx) / f.rx, (y - f.cy) / f.ry);
    if (
      !f.ellipse[i] &&
      r <= 1 + IRIS_MARGIN &&
      y > lid[x] &&
      !lowerAcross[i] &&
      c.irisLike(i)
    ) {
      margin[i] = 1;
    }
  }
  const disc = or(inEllipse, reachThrough(pic, inEllipse, margin, Infinity));
  // Left in the sclera, the soft rim shows as a ring where the iris was once
  // it moves.
  const near = dilate(pic, disc, IRIS_RIM);
  const shown = new Uint8Array(disc);
  for (const i of all) {
    if (!near[i] || shown[i] || c.dark(i)) continue;
    const x = i % width;
    if (
      (i - x) / width > lid[x] &&
      dist(labOf(pic.rgb, i), c.white.lab) > same
    ) {
      shown[i] = 1;
    }
  }
  return andNot(shown, lowerAcross);
}

/** The upper lash (the dark paint not iris above `lashCut`, and the eye's
 *  rows above its first dark one, the lash's soft top edge, so the lash
 *  shares the sclera's top row: the blink fold rides it) and the lower lid
 *  (the dark paint not iris below it). */
function lashesOf(
  pic: Illustration,
  all: number[],
  c: EyeColours,
  iris: Mask,
  lashCut: number,
): { lash: Mask; lower: Mask } {
  const n = pic.width * pic.height;
  const lash = new Uint8Array(n);
  const lower = new Uint8Array(n);
  let lashTop = Infinity;
  for (const i of all) {
    if (iris[i] || !c.dark(i)) continue;
    const y = Math.floor(i / pic.width);
    if (y <= lashCut) {
      lash[i] = 1;
      lashTop = Math.min(lashTop, y);
    } else {
      lower[i] = 1;
    }
  }
  if (lashTop < Infinity) {
    for (const i of all) if (Math.floor(i / pic.width) < lashTop) lash[i] = 1;
  }
  return { lash, lower };
}

/** The iris layer: as it shows, and filled from the disc's own colours
 *  (white highlights left out) where the lids cover it. */
function irisLayer(
  pic: Illustration,
  shown: Mask,
  hidden: Mask,
  c: EyeColours,
): LayerPaint {
  const layer = paintOf(pic, or(shown, hidden));
  let disc = erode(
    pic,
    shown.map((v, i) => (v && !c.isWhite(i) ? 1 : 0)),
    1,
  );
  if (count(disc) === 0) disc = shown;
  if (count(hidden) === 0 || count(disc) === 0) return layer;
  const filled = fillFrom(pic, disc);
  layer.rgb = new Float32Array(pic.rgb);
  for (let i = 0; i < hidden.length; i++) {
    if (!hidden[i] || shown[i]) continue;
    for (let c3 = 0; c3 < 3; c3++) layer.rgb[i * 3 + c3] = filled[i * 3 + c3];
    layer.alpha[i] = 1;
  }
  return layer;
}

/** The sclera: the whole drawing's shape, filled wherever `covered` (the
 *  upper lash, the iris) lies over it from the eye's white, its lightest
 *  paint (that colour itself where none shows clear of the iris); the lower
 *  lid and everything else as drawn. */
function scleraLayer(
  pic: Illustration,
  eye: Mask,
  c: EyeColours,
  covered: Mask,
  iris: Mask,
): LayerPaint {
  const n = pic.width * pic.height;
  const layer = paintOf(pic, eye);
  const whites = andNot(
    and(
      erode(
        pic,
        eye.map((v, i) => (v && c.isWhite(i) ? 1 : 0)),
        1,
      ),
      eye,
    ),
    dilate(pic, iris, SOURCE_INSET),
  );
  const fill =
    count(whites) > 0
      ? fillFrom(pic, whites)
      : Float32Array.from({ length: n * 3 }, (_, k) => c.white.rgb[k % 3]);
  layer.rgb = new Float32Array(pic.rgb);
  for (let i = 0; i < n; i++) {
    if (!eye[i] || !covered[i]) continue;
    for (let k = 0; k < 3; k++) layer.rgb[i * 3 + k] = fill[i * 3 + k];
  }
  return layer;
}

/**
 * The disc the paint finds for the iris check: below the upper lid
 * (`below`) and off the lower lid, the iris-like paint grown from the
 * ellipse's inside, and the dark paint joined to it over the columns it
 * spans (a disc's top as dark as the lash), never the lash's or the lids'
 * ink beside it or the white's shading; closed over its pupil and
 * highlight (the lash above counted in, so a pupil touching it closes too),
 * its largest piece, within the columns and above the bottom row the
 * colour reaches. Grown by colour, its edges and its bottom row are the
 * disc's own wherever the ellipse lies on it.
 */
function discFound(
  pic: Illustration,
  f: EyeFrame,
  eye: Mask,
  c: EyeColours,
  below: Mask,
  lower: Mask,
): Mask {
  const { width } = pic;
  const tone = below.map((v, i) => (v && !lower[i] && c.irisLike(i) ? 1 : 0));
  const seeds = and(tone, f.ellipse);
  const coloured = or(seeds, reachThrough(pic, seeds, tone, Infinity));
  // Over the columns the colour spans, the dark paint joined to it: a
  // disc's top as dark as the lash.
  const span = maskBox(pic, coloured);
  const dark = below.map((v, i) => {
    const x = i % width;
    return v && !lower[i] && span && x >= span[0] && x <= span[2] && c.dark(i)
      ? 1
      : 0;
  });
  const grown = or(coloured, reachThrough(pic, coloured, dark, Infinity));
  const lash = andNot(eye, below);
  const disc = largestPiece(
    pic,
    and(
      fillHoles(
        pic,
        erode(pic, dilate(pic, or(grown, lash), DISC_CLOSE), DISC_CLOSE),
      ),
      below,
    ),
  );
  // No wider than its colour, and no lower: the closing may take a lid's
  // or a lash's ink beside it.
  return span
    ? disc.map((v, i) => {
        const x = i % width;
        const y = (i - x) / width;
        return v && x >= span[0] && x <= span[2] && y <= span[3] ? 1 : 0;
      })
    : disc;
}

function largestPiece(pic: Illustration, m: Mask): Mask {
  const { id, sizes } = pieces(pic, m);
  if (sizes.length === 0) return m;
  let best = 0;
  for (let k = 1; k < sizes.length; k++) if (sizes[k] > sizes[best]) best = k;
  return Uint8Array.from(id, (k) => (k === best ? 1 : 0));
}

interface EyeCut {
  /** The whole drawing: the sclera's shape. */
  eye: Mask;
  sclera: LayerPaint;
  /** Null for an eye drawn closed. */
  iris: LayerPaint | null;
  lash: Mask;
  lower: Mask;
  checks: CutCheck[];
}

/**
 * One eye, split as the composer splits a drawn eye: the drawing
 * (`eyeDrawing`), read against its own ink, white and iris (`eyeColours`);
 * the lids (`upperLid`, `lowerLidAcross`); the iris as it shows
 * (`irisShown`); the lashes (`lashesOf`); then the iris and sclera layers.
 * An eye with no white (`whiteShare` under WHITE_SHARE) and no iris (the
 * ellipse's ring a blend of its ink and the skin, `offBlend`) is drawn
 * closed: it is all lash over the sclera's shape, with no iris.
 */
function cutEye(
  ctx: CutContext,
  side: Side,
  around: Float32Array,
  same: number,
): EyeCut {
  const { pic } = ctx;
  const n = pic.width * pic.height;
  const f = eyeFrame(ctx, side);
  const drawing = eyeDrawing(ctx, f, around, same);
  const { eye } = drawing;
  const all: number[] = [];
  for (let i = 0; i < n; i++) if (eye[i]) all.push(i);
  const none = new Uint8Array(n);
  if (all.length === 0) {
    return {
      eye,
      sclera: paintOf(pic, eye),
      iris: null,
      lash: none,
      lower: none,
      checks: [
        {
          id: `opening.${side}`,
          level: "fail",
          pass: false,
          value: null,
          limit: 1,
          hint: `nothing in ${f.at}.box differs from the skin around it: put the box round the drawn eye, lashes included`,
        },
        eyeCheck(side, null, false),
        irisSkipped(side, `no eye found in ${f.at}.box to find the iris in`),
      ],
    };
  }
  const skin = medianColour(around, all).lab;
  const c = eyeColours(pic, f, all, skin);
  const opening = openingCheck(ctx, side, drawing, around, same);
  const white = whiteShare(pic, c, all, skin, same);
  // An iris of its own colour on the ellipse's ring is an open eye whatever
  // its white: tinted, or mostly hidden behind a large iris.
  const irisOwn = offBlend(c.iris.lab, skin, c, same) > WHITE_SCALE;
  if (white < WHITE_SHARE && !irisOwn) {
    // Drawn closed: the line is the lash, folding over the sclera's shape,
    // which is the skin under it.
    const sclera = paintOf(pic, eye);
    sclera.rgb = around;
    return {
      eye,
      sclera,
      iris: null,
      lash: eye,
      lower: none,
      checks: [
        opening,
        eyeCheck(side, white, false),
        irisSkipped(side, "no iris cut: the eye was read as drawn closed"),
      ],
    };
  }

  const lid = upperLid(pic, f, eye, c);
  const lashCut = lashCutOf(pic, all);
  const lowerAcross = lowerLidAcross(pic, f, eye, c, lashCut, lid);
  const shown = irisShown(pic, f, eye, all, c, lid, lowerAcross, same);
  const { lash, lower } = lashesOf(pic, all, c, shown, lashCut);
  const cap = f.ellipse.map((v, i) =>
    v && Math.floor(i / pic.width) <= lid[i % pic.width] ? 1 : 0,
  );
  const hidden = or(and(cap, lash), lowerAcross);
  const iris = irisLayer(pic, shown, hidden, c);
  const irisMask = Uint8Array.from(iris.alpha, (a) => (a > 0 ? 1 : 0));
  const sclera = scleraLayer(
    pic,
    eye,
    c,
    or(lash, andNot(irisMask, lower)),
    irisMask,
  );
  const below = eye.map((v, i) =>
    v && Math.floor(i / pic.width) > lid[i % pic.width] && !lowerAcross[i]
      ? 1
      : 0,
  );
  return {
    eye,
    sclera,
    iris: count(irisMask) > 0 ? iris : null,
    lash,
    lower,
    checks: [
      opening,
      eyeCheck(side, white, true),
      irisCheck(
        pic,
        side,
        discFound(pic, f, eye, c, below, lower),
        and(f.ellipse, below),
      ),
    ],
  };
}

/** Whether the eye has a white (its `whiteShare` against WHITE_SHARE),
 *  and, with too little, whether it was still cut open (`open`: its iris
 *  ring is a paint of its own) or read as drawn closed. */
function eyeCheck(side: Side, white: number | null, open: boolean): CutCheck {
  const id = `eye.${side}`;
  const at = `landmarks.eyes.${side}`;
  const base = { id, level: "warn" as const, limit: WHITE_SHARE };
  if (white === null) {
    return {
      ...base,
      pass: false,
      value: null,
      hint: "no eye found to read a white in",
    };
  }
  if (white >= WHITE_SHARE) {
    return {
      ...base,
      pass: true,
      value: fmt(white),
      hint: `${pct(white)} of the eye is white: cut open, its iris and lids apart`,
    };
  }
  if (open) {
    return {
      ...base,
      pass: false,
      value: fmt(white),
      hint: `only ${pct(white)} of the eye reads as white: the white is tinted or mostly hidden behind the iris. The eye was cut open, its iris apart, and the sclera under the iris and the lash was filled from the eye's lightest paint: look at eye_${side}.png to see that it reads as the white`,
    };
  }
  return {
    ...base,
    pass: false,
    value: fmt(white),
    hint: `the eye was read as drawn closed (${pct(white)} of it white, and the colour on ${at}.iris's ring a blend of its ink and the skin): its line is the lash over the sclera's shape, with no iris. That is right for a closed eye; for an open one it means ${at}.iris is off the iris: put the ellipse on the coloured disc`,
  };
}

function irisSkipped(side: Side, hint: string): CutCheck {
  return {
    id: `iris.${side}`,
    level: "warn",
    pass: false,
    value: null,
    limit: IRIS_IOU,
    hint,
  };
}

/** A side of an eye box. */
type BoxSide = "top" | "bottom" | "left" | "right";

/**
 * Whether the box holds the whole eye: its paint touching the box's border
 * means the box clips it (how far the eye runs on past each side is read
 * by following its paint out of the box, and the box suggested leaves
 * OPENING_SPARE to OPENING_SPARE + EYE_EDGE px past it); an eye covering
 * under LOOSE_SHARE of its box warns. Where the paint the border cuts runs
 * on as a long stroke (`longStrokes`), the tool cannot tell a lash wing
 * from a strand or a line crossing the box: the hint says what it sees,
 * and a box clipping only such strokes warns rather than fails.
 */
function openingCheck(
  ctx: CutContext,
  side: Side,
  drawing: EyeDrawing,
  around: Float32Array,
  same: number,
): CutCheck {
  const { pic, labels, lm } = ctx;
  const { width, height } = pic;
  const { eye, long } = drawing;
  const at = `landmarks.eyes.${side}.box`;
  const box = lm.eyes[side].box;
  const b = bounds(pic, box);
  const id = `opening.${side}`;
  const eb = maskBox(pic, eye)!;
  const margins: Record<BoxSide, number> = {
    top: eb[1] - b.y0,
    bottom: b.y1 - eb[3],
    left: eb[0] - b.x0,
    right: b.x1 - eb[2],
  };
  const least = Math.min(...Object.values(margins));
  if (least === 0) {
    // Follow the eye's paint out of the box, as far again as the box.
    const reach = Math.max(b.x1 - b.x0, b.y1 - b.y0);
    const wx0 = Math.max(0, b.x0 - reach);
    const wx1 = Math.min(width - 1, b.x1 + reach);
    const wy0 = Math.max(0, b.y0 - reach);
    const wy1 = Math.min(height - 1, b.y1 + reach);
    const isSkin = skinTest(ctx, around, same);
    const isPaint = (x: number, y: number) => {
      const i = y * width + x;
      return labels.solid[i] && labels.label[i] !== LABEL_HAIR && !isSkin(i);
    };
    const seen = new Uint8Array(width * height);
    const queue: number[] = [];
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = b.x0; x <= b.x1; x++) {
        const i = y * width + x;
        if (eye[i]) {
          seen[i] = 1;
          queue.push(i);
        }
      }
    }
    const ext = { top: b.y0, bottom: b.y1, left: b.x0, right: b.x1 };
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q];
      const x = i % width;
      const y = (i - x) / width;
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ]) {
        if (nx < wx0 || nx > wx1 || ny < wy0 || ny > wy1) continue;
        const j = ny * width + nx;
        if (seen[j]) continue;
        const inside = nx >= b.x0 && nx <= b.x1 && ny >= b.y0 && ny <= b.y1;
        if (inside || !isPaint(nx, ny)) continue;
        seen[j] = 1;
        queue.push(j);
        ext.top = Math.min(ext.top, ny);
        ext.bottom = Math.max(ext.bottom, ny);
        ext.left = Math.min(ext.left, nx);
        ext.right = Math.max(ext.right, nx);
      }
    }
    // Past where the paint was followed to: its rim, then the spare.
    const grow = (past: number) => past + EYE_EDGE + OPENING_SPARE;
    const sides: {
      side: BoxSide;
      move: string;
      stroke: string | null;
    }[] = [];
    const add = (s: BoxSide, move: string) => {
      const run = borderRun(pic, b, eye, s);
      sides.push({
        side: s,
        move,
        stroke:
          run && strokeAt(pic, b, long, s, run)
            ? `the paint its ${s} edge cuts, ${run[1] - run[0] + 1} px wide at ${s === "top" || s === "bottom" ? "x" : "y"} ${run[0]}..${run[1]}, runs on as a stroke more than ${drawing.past} px past the box: if it is hair or a line crossing the eye's box, leave that edge (the stroke is not the eye's, and the box would only follow it); if it is the eye's own (a lash wing), move ${move}`
            : null,
      });
    };
    if (margins.top === 0) {
      const g = grow(b.y0 - ext.top);
      add("top", `y0 up by ${g} (to ${Math.max(0, box[1] - g)})`);
    }
    if (margins.bottom === 0) {
      const g = grow(ext.bottom - b.y1);
      add("bottom", `y1 down by ${g} (to ${Math.min(height - 1, box[3] + g)})`);
    }
    if (margins.left === 0) {
      const g = grow(b.x0 - ext.left);
      add("left", `x0 left by ${g} (to ${Math.max(0, box[0] - g)})`);
    }
    if (margins.right === 0) {
      const g = grow(ext.right - b.x1);
      add("right", `x1 right by ${g} (to ${Math.min(width - 1, box[2] + g)})`);
    }
    const clipped = sides.filter((s) => s.stroke === null);
    const strokes = sides.filter((s) => s.stroke !== null);
    const parts: string[] = [];
    if (clipped.length > 0) {
      parts.push(
        `${at} clips the eye, whose paint touches its border; what it cuts off stays on the face and the lash tears on a blink. Grow it ${clipped.map((s) => `at its ${s.side}: move ${s.move}`).join("; ")}`,
      );
    }
    if (strokes.length > 0) {
      parts.push(
        `${at}'s border cuts paint it cannot tell from the eye: ${strokes.map((s) => s.stroke).join("; ")}`,
      );
    }
    return {
      id,
      level: clipped.length > 0 ? "fail" : "warn",
      pass: false,
      value: 0,
      limit: 1,
      hint: parts.join(". "),
    };
  }
  const area = (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1);
  const covers = count(eye) / area;
  if (covers < LOOSE_SHARE) {
    return {
      id,
      level: "warn",
      pass: false,
      value: fmt(covers),
      limit: LOOSE_SHARE,
      hint: `the eye covers ${pct(covers)} of ${at}: a loose box takes the lines and shading round the eye into it; the eye's paint spans [${eb.join(", ")}], so a box ${OPENING_SPARE} px round that is [${Math.max(0, eb[0] - OPENING_SPARE)}, ${Math.max(0, eb[1] - OPENING_SPARE)}, ${Math.min(width - 1, eb[2] + OPENING_SPARE)}, ${Math.min(height - 1, eb[3] + OPENING_SPARE)}]`,
    };
  }
  return {
    id,
    level: "fail",
    pass: true,
    value: least,
    limit: 1,
    hint: `the eye sits ${least} px or more inside ${at}`,
  };
}

/** The first and last of the eye's pixels on one border line of its box
 *  (x along the top and bottom, y along the sides); null with none. */
function borderRun(
  pic: Illustration,
  b: Bounds,
  eye: Mask,
  side: BoxSide,
): [number, number] | null {
  const { width } = pic;
  const along = side === "top" || side === "bottom";
  const fixed = { top: b.y0, bottom: b.y1, left: b.x0, right: b.x1 }[side];
  const [from, to] = along ? [b.x0, b.x1] : [b.y0, b.y1];
  let first = -1;
  let last = -1;
  for (let v = from; v <= to; v++) {
    const i = along ? fixed * width + v : v * width + fixed;
    if (!eye[i]) continue;
    if (first < 0) first = v;
    last = v;
  }
  return first < 0 ? null : [first, last];
}

/** Whether a long stroke meets the eye's paint at `side` within `run`
 *  (within STROKE_GAP + EYE_EDGE px outside the border). */
function strokeAt(
  pic: Illustration,
  b: Bounds,
  long: Mask,
  side: BoxSide,
  run: [number, number],
): boolean {
  const { width, height } = pic;
  const near = STROKE_GAP + EYE_EDGE;
  const along = side === "top" || side === "bottom";
  for (let v = run[0] - near; v <= run[1] + near; v++) {
    for (let d = 1; d <= near; d++) {
      const x = along ? v : side === "left" ? b.x0 - d : b.x1 + d;
      const y = along ? (side === "top" ? b.y0 - d : b.y1 + d) : v;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      if (long[y * width + x]) return true;
    }
  }
  return false;
}

/**
 * The iris ellipse against the disc the colours find, both under the lash:
 * their overlap (intersection over union) and how far apart their centres
 * are, with which way to move the ellipse.
 */
function irisCheck(
  pic: Illustration,
  side: Side,
  disc: Mask,
  ellipse: Mask,
): CutCheck {
  const { width } = pic;
  const id = `iris.${side}`;
  const at = `landmarks.eyes.${side}.iris`;
  let inter = 0;
  let union = 0;
  const centre = (m: Mask) => {
    let sx = 0;
    let sy = 0;
    let k = 0;
    for (let i = 0; i < m.length; i++) {
      if (!m[i]) continue;
      sx += i % width;
      sy += Math.floor(i / width);
      k++;
    }
    return k > 0 ? [sx / k, sy / k] : null;
  };
  for (let i = 0; i < disc.length; i++) {
    if (disc[i] && ellipse[i]) inter++;
    if (disc[i] || ellipse[i]) union++;
  }
  const d = centre(disc);
  const e = centre(ellipse);
  const found = maskBox(pic, disc);
  if (!d || !e || !found) {
    return {
      id,
      level: "warn",
      pass: false,
      value: 0,
      limit: IRIS_IOU,
      hint: `no iris-coloured paint found under the lash inside the eye: check ${at} sits on the coloured disc`,
    };
  }
  const iou = union > 0 ? inter / union : 0;
  const dx = Math.round(d[0] - e[0]);
  const dy = Math.round(d[1] - e[1]);
  const said = `the ellipse overlaps the disc found by ${pct(iou)}, centres ${Math.hypot(dx, dy).toFixed(1)} px apart`;
  if (iou >= IRIS_IOU)
    return {
      id,
      level: "warn",
      pass: true,
      value: fmt(iou),
      limit: IRIS_IOU,
      hint: said,
    };
  const moves: string[] = [];
  if (dx !== 0)
    moves.push(`cx ${dx > 0 ? "right" : "left"} by ${Math.abs(dx)}`);
  if (dy !== 0) moves.push(`cy ${dy > 0 ? "down" : "up"} by ${Math.abs(dy)}`);
  return {
    id,
    level: "warn",
    pass: false,
    value: fmt(iou),
    limit: IRIS_IOU,
    hint: `${said}: ${moves.length > 0 ? `move ${at}.${moves.join(" and ")}; ` : ""}the disc found spans x ${found[0]}..${found[2]} (rx about ${((found[2] - found[0] + 1) / 2).toFixed(1)}) and reaches down to y ${found[3]} (cy + ry)`,
  };
}

// ---- brows ----

/** One brow as cut: its pixels, and whether its band held it whole (null
 *  when the band holds no brow, which `browCheck` reports). */
interface BrowCut {
  brow: Mask;
  band: CutCheck | null;
}

/**
 * The brows. Brow ink is the paint in a band that is neither clean skin
 * nor clean hair: at least BROW_SHARE of the way toward the brow's ink from
 * the paint around the band, from the skin samples, and, where hair is near,
 * from the hair samples (a brow drawn through a strand is a mix of brow and
 * hair; a pale brow on skin, a mix of brow and skin). A brow takes no hair:
 * not the back hair's, which nothing refills, nor a front strand's own
 * paint; on a front strand running through the band (which the front hair
 * refills) only the brow's ink over it, and only where the samples call
 * the brow's ink and the strand apart (not near-black hair). A strand's
 * edge is not brow (`strandEdges`).
 */
function cutBrows(
  ctx: CutContext,
  eyes: Mask,
  same: number,
): { L?: BrowCut; R?: BrowCut } {
  const { pic, lm, labels, classifier } = ctx;
  const n = pic.width * pic.height;
  const bands = [labels.browBands.L, labels.browBands.R].filter(
    (m) => m !== undefined,
  );
  if (bands.length === 0) return {};
  const allBands = bands.reduce(or);
  // The paint around the band: hair and skin off lines, off the bands.
  const sources = erode(
    pic,
    labels.classes.map((c, i) =>
      labels.solid[i] && (c === HAIR || c === SKIN) && !allBands[i] && !eyes[i]
        ? 1
        : 0,
    ),
    SOURCE_INSET,
  );
  const around = fillFrom(pic, sources);
  const hairNear = or(
    labels.strandThrough,
    dilate(pic, andNot(labels.hair, allBands), HAIR_NEAR),
  );
  const isHair = (i: number) => labels.label[i] === LABEL_HAIR;

  const out: { L?: BrowCut; R?: BrowCut } = {};
  for (const side of ["L", "R"] as const) {
    const band = labels.browBands[side];
    if (!band) continue;
    const cand: number[] = [];
    const off = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (!band[i] || !labels.solid[i] || eyes[i]) continue;
      cand.push(i);
      off[i] = dist(labOf(pic.rgb, i), labOf(around, i));
    }
    const brow = new Uint8Array(n);
    if (cand.length === 0) {
      out[side] = { brow, band: null };
      continue;
    }
    const core = [...cand].sort((p, q) => off[q] - off[p]);
    const ink = medianColour(
      pic.rgb,
      core.slice(0, Math.max(1, Math.ceil(core.length * BROW_CORE_SHARE))),
    );
    const hairDistinct = classifier.classify(...ink.rgb) !== HAIR;
    const inkFrom = classifier.distances(...ink.rgb);
    const allowed = (i: number) =>
      labels.strandThrough[i]
        ? labels.hairFront[i] === 1 &&
          hairDistinct &&
          labels.classes[i] !== HAIR
        : !isHair(i);
    /** At least BROW_SHARE of the way to the brow's ink from every paint
     *  it may be a mix with. */
    const isInk = (i: number) => {
      const toInk = dist(ink.lab, labOf(around, i));
      if (toInk <= same) return false;
      const d = classifier.distances(
        pic.rgb[i * 3],
        pic.rgb[i * 3 + 1],
        pic.rgb[i * 3 + 2],
      );
      const fromLocal = dist(labOf(pic.rgb, i), labOf(around, i)) / toInk;
      const fromSkin = inkFrom.skin > 0 ? d.skin / inkFrom.skin : 1;
      const fromHair =
        hairDistinct && hairNear[i] && inkFrom.hair > 0
          ? d.hair / inkFrom.hair
          : 1;
      return Math.min(fromLocal, fromSkin, fromHair) >= BROW_SHARE;
    };
    for (const i of cand) if (allowed(i) && isInk(i)) brow[i] = 1;
    // The rim may run past the band: a band a px or two off the stroke
    // would leave its soft edge behind. Clean paint there is a source of
    // `around` itself, so it never differs from it and stays.
    const rim = dilate(pic, brow, BROW_EDGE);
    for (let i = 0; i < n; i++) {
      if (!rim[i] || brow[i] || !labels.solid[i] || eyes[i] || !allowed(i)) {
        continue;
      }
      if (!band[i] && isHair(i)) continue;
      if (dist(labOf(pic.rgb, i), labOf(around, i)) > same) brow[i] = 1;
    }
    for (const i of strandEdges(pic, brow, lm.brows![side]!, isHair)) {
      brow[i] = 0;
    }
    const missed =
      count(brow) > 0
        ? browMissed(ctx, side, lm.brows![side]!, band, brow, eyes, isInk)
        : null;
    out[side] = { brow, band: missed };
  }
  return out;
}

/** The on pixels of a mask. */
function maskIndices(m: Mask): number[] {
  const out: number[] = [];
  for (let i = 0; i < m.length; i++) if (m[i]) out.push(i);
  return out;
}

/**
 * The pieces of a brow cut that are a strand's edges, not brow: a piece
 * lying wholly on hair, or one running across the line farther than along
 * it (a brow runs along its line; a strand's edge crosses the band).
 */
function strandEdges(
  pic: Illustration,
  brow: Mask,
  line: IllustrationBrow,
  isHair: (i: number) => boolean,
): number[] {
  const { width } = pic;
  const where = browGeometry(line);
  const { id, sizes } = pieces(pic, brow);
  const k = sizes.length;
  const onFace = new Uint8Array(k);
  const span = Array.from({ length: k }, () => [
    Infinity,
    -Infinity,
    Infinity,
    -Infinity,
  ]);
  const dir = new Float64Array(k * 2).fill(NaN);
  for (let i = 0; i < brow.length; i++) {
    const p = id[i];
    if (p < 0) continue;
    if (!isHair(i)) onFace[p] = 1;
    const x = i % width;
    const y = (i - x) / width;
    if (Number.isNaN(dir[p * 2])) {
      const w = where(x, y);
      dir[p * 2] = w.tx;
      dir[p * 2 + 1] = w.ty;
    }
    const [tx, ty] = [dir[p * 2], dir[p * 2 + 1]];
    const along = x * tx + y * ty;
    const across = -x * ty + y * tx;
    const s = span[p];
    s[0] = Math.min(s[0], along);
    s[1] = Math.max(s[1], along);
    s[2] = Math.min(s[2], across);
    s[3] = Math.max(s[3], across);
  }
  const out: number[] = [];
  for (let i = 0; i < brow.length; i++) {
    const p = id[i];
    if (p < 0) continue;
    const s = span[p];
    if (!onFace[p] || s[3] - s[2] > s[1] - s[0]) out.push(i);
  }
  return out;
}

/** Brow ink found past its band, as a share of the brow, before the check
 *  warns: past the band's soft rim, which the brow takes, a few px of a
 *  stroke's blend is noise; a band off the brow leaves a strip. */
const BROW_MISS_SHARE = 0.05;

/**
 * Whether the band holds the whole brow: brow ink (`ink`) clear of the
 * hair by HAIR_LINE px (its soft edge lies there), joined to the
 * brow's pixels (8-connected, through ink on the strands that cross it too), that runs on outside the band, up to `halfWidth` past its
 * edge, stays on the face when the brow moves. Said with which way the line is off and by how much: past the
 * band's lower or upper edge (move the line, or widen the band), or past
 * its tail or inner end (extend the line). A warning: other ink touching
 * the brow (the face's outline, a crease) can read as brow too.
 */
function browMissed(
  ctx: CutContext,
  side: "L" | "R",
  brow: IllustrationBrow,
  band: Mask,
  cut: Mask,
  eyes: Mask,
  ink: (i: number) => boolean,
): CutCheck {
  const { pic, labels } = ctx;
  const { width, height } = pic;
  const at = `landmarks.brows.${side}`;
  const where = browGeometry(brow);
  const hairLine = dilate(
    pic,
    labels.label.map((l) => (l === LABEL_HAIR ? 1 : 0)),
    HAIR_LINE,
  );
  const seen = new Uint8Array(cut);
  const queue: number[] = [];
  for (let i = 0; i < cut.length; i++) if (cut[i]) queue.push(i);
  const found: number[] = [];
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    const x = i % width;
    const y = (i - x) / width;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (seen[j]) continue;
        seen[j] = 1;
        if (band[j] || !labels.solid[j] || eyes[j] || !ink(j)) continue;
        const w = where(nx, ny);
        if (w.d > w.half + brow.halfWidth) continue;
        if (!hairLine[j]) found.push(j);
        queue.push(j);
      }
    }
  }
  const browPx = count(cut);
  const value = found.length / (browPx + found.length);
  const base = {
    id: `browBand.${side}`,
    level: "warn" as const,
    value: fmt(value),
    limit: BROW_MISS_SHARE,
  };
  if (value <= BROW_MISS_SHARE) {
    return {
      ...base,
      pass: true,
      hint: `the band holds the brow: ${found.length} px of brow ink past it`,
    };
  }
  // Which way most of it lies.
  const groups = new Map<string, { px: number[]; e: number; tail: number }>();
  for (const i of found) {
    const x = i % width;
    const y = (i - x) / width;
    const w = where(x, y);
    const key = w.end ?? (w.dy > 0 ? "below" : "above");
    const g = groups.get(key) ?? { px: [], e: 0, tail: 0 };
    g.px.push(i);
    g.e = Math.max(g.e, w.end ? w.d : w.d - w.half);
    if (w.third) g.tail++;
    groups.set(key, g);
  }
  const [key, g] = [...groups].sort(
    (a, b) => b[1].px.length - a[1].px.length,
  )[0];
  const e = Math.max(1, Math.ceil(g.e));
  const xs = g.px.map((i) => i % width);
  const [xa, xb] = [Math.min(...xs), Math.max(...xs)];
  const span = `x ${xa}..${xb}`;
  const left = `${found.length} px of brow ink (${pct(value)} of the brow) run on`;
  const stays = "and stay on the face when the brow moves";
  let hint: string;
  if (key === "tail" || key === "end") {
    const point = key === "tail" ? "first (tail)" : "last (inner)";
    hint = `${left} past the line's ${key === "tail" ? "tail" : "inner end"} by up to ${e} px at ${span}, ${stays}: extend ${at}.line's ${point} point along the brow by about ${e} px`;
  } else {
    const widen = g.tail * 2 > g.px.length ? "tailHalfWidth" : "halfWidth";
    // How far the ink's middle lies off the line over the span: the brow's
    // pixels there and the ink past the band, by signed distance.
    const offsets: number[] = [];
    for (const i of [...g.px, ...maskIndices(cut)]) {
      const x = i % width;
      if (x < xa || x > xb) continue;
      const w = where(x, (i - x) / width);
      if (!w.end) offsets.push(w.dy > 0 ? w.d : -w.d);
    }
    const shift = Math.max(1, Math.round(Math.abs(median(offsets))));
    hint = `${left} past the band's ${key === "below" ? "lower" : "upper"} edge by up to ${e} px at ${span}, ${stays}: move ${at}.line's points over ${span} ${key === "below" ? "down" : "up"} by about ${shift} px (onto the ink's middle there), or widen ${at}.${widen} by ${e} (keeping the band no wider than the brow)`;
  }
  return { ...base, pass: false, hint };
}

// ---- nose and mouth ----

/** What in `box` differs from the skin filled over it (`first`), grown by
 *  MARK_EDGE, off `taken`. */
function markIn(
  ctx: CutContext,
  box: Box,
  first: Float32Array,
  same: number,
  taken: Mask,
): Mask {
  const { pic, labels } = ctx;
  const { width } = pic;
  const b = bounds(pic, box);
  const m = new Uint8Array(width * pic.height);
  for (let y = b.y0; y <= b.y1; y++) {
    for (let x = b.x0; x <= b.x1; x++) {
      const i = y * width + x;
      if (!labels.solid[i] || taken[i] || labels.label[i] === LABEL_HAIR) {
        continue;
      }
      if (dist(labOf(pic.rgb, i), labOf(first, i)) > same) m[i] = 1;
    }
  }
  const box1 = boxMask(pic, box);
  return dilate(pic, m, MARK_EDGE).map((v, i) =>
    v && box1[i] && labels.fg[i] && !taken[i] && labels.label[i] !== LABEL_HAIR
      ? 1
      : 0,
  );
}

// ---- checks on the brows and the mouth ----

/** Whether a brow's band held its ink: an empty one writes no layer. */
function browCheck(side: "L" | "R", pixels: number): CutCheck {
  return pixels > 0
    ? {
        id: `brow.${side}`,
        level: "warn",
        pass: true,
        value: pixels,
        limit: 1,
        hint: `the brow's band holds ${pixels} px of brow`,
      }
    : {
        id: `brow.${side}`,
        level: "warn",
        pass: false,
        value: 0,
        limit: 1,
        hint: `nothing in landmarks.brows.${side}'s band differs from the skin and hair around it, so no brow_${side} is written and the brow stays painted on the face: the line is off the brow; put it along the brow's middle, tail first`,
      };
}

/**
 * Whether the face has a mouth: the rig needs `mouth` or the lip set. The
 * drawn mouth is what in `mouth.box` differs from the skin; with none, and
 * no lip set to stand for it, the cut fails.
 */
function mouthCheck(pixels: number, lipSet: boolean): CutCheck {
  if (pixels > 0) {
    return {
      id: "mouth",
      level: "fail",
      pass: true,
      value: pixels,
      limit: 1,
      hint: `the drawn mouth is ${pixels} px${lipSet ? ", lifted off the face under the lip set" : ""}`,
    };
  }
  if (lipSet) {
    return {
      id: "mouth",
      level: "fail",
      pass: true,
      value: 0,
      limit: 1,
      hint: "nothing is drawn in landmarks.mouth.box; the lip set stands for the mouth",
    };
  }
  return {
    id: "mouth",
    level: "fail",
    pass: false,
    value: 0,
    limit: 1,
    hint: "nothing in landmarks.mouth.box differs from the skin, so no mouth is written and the rig has none: move the box onto the drawn mouth, or, for a picture with no mouth drawn, give a generated lip set",
  };
}

// ---- all of them ----

export interface FeatureCut {
  /** Each feature layer by role. */
  roles: Map<string, LayerPaint>;
  /** Every pixel a feature takes off the face. */
  holes: Mask;
  /** The skin to fill the holes with: from the skin around, off them. */
  skin: Float32Array;
  /** `skin`'s sources. */
  skinSources: Mask;
  checks: CutCheck[];
}

/**
 * The eyes, the brows, the nose and the drawn closed mouth as layers, and
 * the skin to fill the face with under them. With `lipSet`, a generated lip
 * set stands for the mouth: the drawn mouth still leaves the face but is
 * written as no layer, and a mouth box with nothing drawn in it is no fault.
 */
export function cutFeatures(ctx: CutContext, lipSet = false): FeatureCut {
  const { pic, lm, labels } = ctx;
  const n = pic.width * pic.height;
  const same = samePaint(ctx);
  // A first skin fill with every feature's box open: what the features are
  // told from.
  const boxes = [
    boxMask(pic, lm.eyes.L.box),
    boxMask(pic, lm.eyes.R.box),
    boxMask(pic, lm.mouth.box),
    ...(lm.nose ? [boxMask(pic, lm.nose.box)] : []),
    ...[labels.browBands.L, labels.browBands.R].filter((m) => m !== undefined),
  ].reduce(or);
  const first = fillFrom(pic, skinSources(ctx, boxes));

  const roles = new Map<string, LayerPaint>();
  const checks: CutCheck[] = [];
  let holes: Mask = new Uint8Array(n);
  for (const side of ["L", "R"] as const) {
    const e = cutEye(ctx, side, first, same);
    roles.set(`eye_${side}`, e.sclera);
    if (e.iris) roles.set(`iris_${side}`, e.iris);
    if (count(e.lash) > 0) roles.set(`lash_${side}`, paintOf(pic, e.lash));
    if (count(e.lower) > 0) {
      roles.set(`lash_lower_${side}`, paintOf(pic, e.lower));
    }
    holes = or(holes, e.eye);
    checks.push(...e.checks);
  }
  const brows = cutBrows(ctx, holes, same);
  for (const side of ["L", "R"] as const) {
    const b = brows[side];
    if (!b) continue;
    const m = b.brow;
    const pixels = count(m);
    checks.push(browCheck(side, pixels));
    if (b.band) checks.push(b.band);
    if (pixels === 0) continue;
    roles.set(`brow_${side}`, paintOf(pic, m));
    holes = or(holes, m);
  }
  if (lm.nose) {
    const nose = markIn(ctx, lm.nose.box, first, same, holes);
    if (count(nose) > 0) {
      roles.set("nose", paintOf(pic, nose));
      holes = or(holes, nose);
    }
  }
  const mouth = markIn(ctx, lm.mouth.box, first, same, holes);
  const mouthPixels = count(mouth);
  checks.push(mouthCheck(mouthPixels, lipSet));
  if (mouthPixels > 0) {
    // The rig refuses `mouth` beside the lip set, which stands for it.
    if (!lipSet) roles.set("mouth", paintOf(pic, mouth));
    holes = or(holes, mouth);
  }
  const sources = skinSources(ctx, holes);
  return {
    roles,
    holes,
    skin: fillFrom(pic, sources),
    skinSources: sources,
    checks,
  };
}
