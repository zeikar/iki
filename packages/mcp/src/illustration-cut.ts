/**
 * `cutLayersFromIllustration`: one finished character picture cut, in
 * place, into role layers on the canvas: the face, the front and back hair,
 * a side lock on each side given, the body and each custom part (a tail, a
 * ponytail) as its own file. Every
 * visible pixel is copied from the picture; what a layer hides when the rig
 * moves it (the forehead under the bangs, the hair behind the face, the
 * neck behind the chin, the cheek under a side lock) is filled in from the
 * paint around it.
 *
 * Driven by landmarks an agent reads off `view_illustration_grid`
 * (`illustration-landmarks.ts`), and checked: the report says, in numbers,
 * whether the layers stack back into the picture, whether each seed and
 * sample sits on the paint it should, how much of each fill was made up far
 * from any paint, and whether the front hair is wider than the face; and
 * `measure_layers`' own checks on the written directory follow.
 *
 * The drawn mouth is a closed line. Given a generated lip set (the
 * composer's keyed open mouth and interior), the composer cuts it and it is
 * placed on the drawn mouth's corners in place of that line.
 *
 * Frame: canvas px, origin top-left, x right, y down, CANVAS wide; every
 * layer is a canvas-sized PNG with the paint where the picture has it.
 */

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  hasCoverage,
  ORDER,
  readLipSources,
  sizedPart,
  trimmedPart,
  type LipSources,
} from "./compose";
import { KEYED_SRC, splitLipSet } from "./compose-lips";
import {
  and,
  andNot,
  backdropColoured,
  backdropSeed,
  boxMask,
  count,
  dilate,
  erode,
  matteIllustration,
  or,
  pixelIndex,
  polygonMask,
  readPictureOnCanvas,
  type Box,
  type CanvasPicture,
  type CanvasSize,
  type Illustration,
  type Mask,
  type Point,
} from "./illustration";
import {
  buildClassifier,
  classifyPicture,
  HAIR,
  NEITHER,
  readSamples,
  SKIN,
  withoutSample,
  type ColourClassifier,
  type SampleReads,
} from "./illustration-colour";
import {
  fillFrom,
  hairSources,
  paintOf,
  SOURCE_INSET,
  type CutCheck,
  type CutContext,
  type LayerPaint,
} from "./illustration-context";
import { cutFeatures, type FeatureCut } from "./illustration-features";
import { drawLandmarks, pictureView } from "./illustration-grid";
import {
  bridges,
  labelIllustration,
  LABEL_BODY,
  LABEL_FACE,
  LABEL_HAIR,
  maskBox,
  PAINT_ALPHA,
  type IllustrationLabels,
} from "./illustration-labels";
import {
  validateLandmarks,
  type IllustrationLandmarks,
} from "./illustration-landmarks";
import {
  AutoRigInputError,
  confineToWorkingDirectory,
  resolveInputPath,
  resolveOutputDir,
  writeFileAtomic,
} from "./limits";
import { formatLipFacts, measureDir } from "./measure";
import { VISIBLE_MIN_PX } from "./measure-hair-side";
import type { LipFacts } from "./measure-lips";

export interface CutLayersFromIllustrationInput {
  /** The finished picture (PNG, JPEG or WebP), resolved against cwd. */
  imagePath: string;
  /** Checked by `validateLandmarks` against the picture's canvas. */
  landmarks: unknown;
  /** An existing directory under the working directory. */
  outputDir: string;
  /** The lip set's open mouth, its inside painted flat #00FF00 (what the
   *  composer reads as `mouth_keyed.png`). With `mouthInterior` the lip set
   *  is written in place of the drawn mouth, its corners on
   *  `landmarks.mouth`'s; one without the other is refused. */
  mouthKeyed?: string;
  /** The lip set's cavity, teeth and tongue (the composer's
   *  `mouth_interior.png`); see `mouthKeyed`. */
  mouthInterior?: string;
}

export interface CutLayer {
  role: string;
  path: string;
  /** `[x0, y0, x1, y1]` of the painted pixels, both corners inside; null
   *  for a layer with none. */
  box: Box | null;
  pixels: number;
}

/** `measureLayers`' report on the written directory, less the checks whose
 *  only remedy is re-laying-out or regenerating a generated part (see
 *  `measureDir`'s `inPlace`). */
export interface CutMeasure {
  warnings: string[];
  /** The lip set's opening as the rig reads it, with a lip set. */
  lips?: LipFacts;
}

export interface CutCustomPart {
  id: string;
  path: string;
  box: Box | null;
  pixels: number;
  /** The landmark's tie, for the custom part's rig. */
  tie: Point;
}

export type CutLayersFromIllustrationResult =
  | {
      ok: true;
      outputDir: string;
      canvas: CanvasSize;
      layers: CutLayer[];
      customParts: CutCustomPart[];
      previews: { labels: string; landmarks: string };
      checks: CutCheck[];
      measure: CutMeasure;
      /** No fail-level check failed. */
      passed: boolean;
    }
  | { ok: false; error: string };

/** Skin carried under strands that cross the face's edge, px past it: what
 *  shows when the strand swings off the face. Too little shows a gap. */
const FACE_MARGIN = 10;
/** A drawn line's width at the canvas size, px: the strand's outline
 *  beside a side lock, kept out of what the skin under it is coloured
 *  from. */
const LOCK_LINE = 4;
/** How far a side lock is carried up under the bangs from its top edge, px:
 *  its hidden root. The rig moves a lock as the front hair down to the first
 *  row on which it shows under the bangs and eases it to the face's motion
 *  over 0.2 hh below; the measure (`measure-hair-side.ts`) reads the root as
 *  hidden when the lock's top row lies under `hair_front`. Where the bangs'
 *  hem dips below that first row, the lock under the dip already eases
 *  toward the face while the hem moves as the bangs: on the nod the two
 *  part by up to about 0.02 hh (the bangs' 0.18 against the face's 0.16),
 *  about 5 px on a head at this canvas size, plus the measure's 3 px of
 *  antialiasing. 12 px keeps the root under the hem past both with a
 *  margin; the carry runs only where `hair_front` is opaque above, so more
 *  would only lengthen the lock's box, whose top the rig pins its sway to. */
const SIDE_ROOT_REACH = 12;
/** Hair and custom parts run on under the body's edge this far, px: what
 *  shows when the body breathes or the head turns. Too little shows a gap
 *  at the shoulder. */
const UNDER_BODY = 16;
/** The head's hair runs on under each custom part's root this far, px: what
 *  shows when the part swings. Too little shows a hole at the root. */
const UNDER_PART = 14;
/** How far under the jaw's lowest face row the neck's own skin is looked
 *  for, px: past the jaw's line, the shadow the chin casts on the neck and
 *  a strand's tip hanging over it. Farther reaches down through a collar to
 *  the chest. */
const NECK_REACH = 40;
/** Columns of the neck's own side line carried up past its skin: a drawn
 *  line's width at the canvas size. More reaches the strands and the
 *  backdrop's fringe beside the neck. */
const NECK_LINE = 3;
/** Alpha at which the picture's paint hides whatever a fill puts under it:
 *  full, at 8 bits. Under a soft edge the picture shows its backdrop, and a
 *  fill there would show through. */
const OPAQUE_ALPHA = 1 - 0.5 / 255;
/** A fill pixel farther than this from any source pixel (a square of this
 *  half-size) was made up rather than carried on: it shows a flat average
 *  colour where the picture would have shading. */
const FILL_REACH = 40;
/** Share of a fill that may be made up before the check warns: past it,
 *  what shows when the layer above moves is mostly one flat colour. */
const FILL_LIMIT = 0.25;
/** A channel off by more than this many levels counts as off: past the
 *  rounding of a soft edge, short of a visible change. */
const STACK_LEVELS = 24;
/** Share of the canvas the stacked layers may get wrong, about a short
 *  stroke's worth at the canvas size. */
const STACK_LIMIT = 0.003;

/** A backdrop-coloured region smaller than this, px, is a highlight or a
 *  gap in a line, not a pocket of backdrop worth a seed. */
const POCKET_PX = 200;
/** Pockets the check names at most, largest first. */
const POCKETS_NAMED = 5;
/** A pocket's ring is the paint this many px out from it, through
 *  POCKET_RING_OUT: past its soft edge and the line round it (whose pixels
 *  are a mix the floods may give to anything), into the paint that closes
 *  it in. Sized for a line about 4 canvas px wide (2 picture px on a
 *  picture about half the canvas); a much heavier line puts its own ink in
 *  the ring, which reads as neither hair nor body and lowers the hair's
 *  share. */
const POCKET_RING_IN = 4;
const POCKET_RING_OUT = 8;
/** The largest pocket keyed on its own, as a share of the canvas: a gap
 *  between strands is small and thin (twin's largest is about 0.5 %), a
 *  pale panel edged with hair is not, and over this it is only named. */
const POCKET_KEY_SHARE = 0.01;
/** A pocket whose ring is at least this share hair is a gap in the hair and
 *  keyed as backdrop on its own; a gap closed at one end by the clothes
 *  stays over it, a hole in a shirt is far under it. */
const POCKET_HAIR_SHARE = 0.8;
/** The share of a pocket's pixels a `backgroundSeeds` point must be accepted
 *  at for the pocket to be named for one: under it, a seed keys too little
 *  of it to clear it, and the next cut names it again. */
const POCKET_SEED_SHARE = 0.5;

const fmt = (v: number, digits = 3) => Number(v.toFixed(digits));
const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

export type { CutCheck } from "./illustration-context";

// ---- fills and layers ----

/** Lay `filled` colours, opaque, over `region` where the layer has no paint
 *  of its own; `region` must lie under opaque paint of a layer drawn above.
 *  Returns the pixels filled. */
function fillUnder(
  pic: Illustration,
  layer: LayerPaint,
  region: Mask,
  filled: Float32Array | ((i: number) => ArrayLike<number>),
): Mask {
  const done = new Uint8Array(region.length);
  for (let i = 0; i < region.length; i++) {
    if (!region[i] || layer.alpha[i] > 0) continue;
    if (layer.rgb === pic.rgb) layer.rgb = new Float32Array(pic.rgb);
    const rgb =
      typeof filled === "function"
        ? filled(i)
        : filled.subarray(i * 3, i * 3 + 3);
    for (let c = 0; c < 3; c++) layer.rgb[i * 3 + c] = rgb[c];
    layer.alpha[i] = 1;
    done[i] = 1;
  }
  return done;
}

/** Straight-alpha RGBA bytes; colour zeroed where nothing is painted. */
export function encodeLayer(layer: LayerPaint): Buffer {
  const n = layer.alpha.length;
  const buf = Buffer.alloc(n * 4);
  const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  for (let i = 0; i < n; i++) {
    const a = byte(layer.alpha[i] * 255);
    if (a === 0) continue;
    for (let c = 0; c < 3; c++) buf[i * 4 + c] = byte(layer.rgb[i * 3 + c]);
    buf[i * 4 + 3] = a;
  }
  return buf;
}

interface FillRegion {
  id: string;
  /** The pixels filled. */
  region: Mask;
  sources: Mask;
  /** Null for a fill made up by construction, reported without a limit. */
  limit: number | null;
  hint: string;
}

interface BuiltLayers {
  roles: Map<string, LayerPaint>;
  parts: { id: string; tie: Point; paint: LayerPaint }[];
  fills: FillRegion[];
  features: FeatureCut;
  /** Where the picture's paint is opaque: what a fill may lie under. */
  opaque: Mask;
}

/** The face: its skin as drawn, the features lifted off it; under them,
 *  under the bangs inside the skull, and a margin under strands that cross
 *  its edge, skin filled from the skin around. */
function faceLayer(
  ctx: CutContext,
  opaque: Mask,
  fills: FillRegion[],
  features: FeatureCut,
) {
  const { pic, labels } = ctx;
  const { skin, skinSources: sources, holes } = features;
  const face = paintOf(pic, labels.face);
  for (let i = 0; i < holes.length; i++) if (holes[i]) face.alpha[i] = 0;
  fills.push({
    id: "face.features",
    region: fillUnder(pic, face, and(and(holes, labels.face), opaque), skin),
    sources,
    limit: null,
    hint: "the skin under the eyes, the brows, the nose and the mouth, filled from the skin around by construction (it shows when a feature moves or an eye shuts)",
  });
  const head = or(labels.skullArea, dilate(pic, labels.face, FACE_MARGIN));
  fills.push({
    id: "face.forehead",
    region: fillUnder(
      pic,
      face,
      and(head, and(labels.hairFront, opaque)),
      skin,
    ),
    sources,
    limit: FILL_LIMIT,
    hint: "the skin under the bangs is made up far from any skin: pull landmarks.skull in to the head's outline, and put a landmarks.skinSeeds point on any forehead skin between strands the face's flood missed",
  });
  const locks = sideLocks(labels);
  if (locks) {
    // No margin here: grown outward from the face, it lays skin beside the
    // ear's outer edge and under the lobe, where the hair is behind the
    // lock, and the lock leaning away shows it as a patch.
    const bridge = bridges(pic, locks, labels.face);
    // Coloured smoothly from the face's own paint round the gap, the ear's
    // shading with it (it reads neither skin nor hair, so the skin fill
    // would lay it flat and pale), less a line's width beside the lock: the
    // strand's soft edge and any of its outline the face kept.
    const across = fillFrom(
      pic,
      andNot(and(labels.face, labels.solid), dilate(pic, locks, LOCK_LINE)),
    );
    const hidden = or(labels.skullArea, bridge);
    fills.push({
      id: "face.sideHair",
      region: fillUnder(pic, face, and(hidden, and(locks, opaque)), (i) =>
        (bridge[i] ? across : skin).subarray(i * 3, i * 3 + 3),
      ),
      sources,
      limit: FILL_LIMIT,
      hint: "the skin under the side locks is made up far from any skin: put a landmarks.skinSeeds point on the cheek and the ear beside each lock",
    });
  }
  return face;
}

/** The front hair, a strand running through a brow's band refilled across
 *  it, column by column, from the strand right above and right below: the
 *  brow passes under it, and moving the brow leaves no trace in the hair. */
function frontHairLayer(ctx: CutContext, fills: FillRegion[]): LayerPaint {
  const { pic, labels } = ctx;
  const { width, height } = pic;
  const layer = paintOf(pic, labels.hairFront);
  const strand = and(labels.strandThrough, labels.hairFront);
  const region = new Uint8Array(width * height);
  for (let x = 0; x < width; x++) {
    for (let y = 1; y < height; y++) {
      if (!strand[y * width + x] || strand[(y - 1) * width + x]) continue;
      let end = y;
      while (end < height && strand[end * width + x]) end++;
      const a = (y - 1) * width + x;
      const b = end * width + x;
      if (end < height && layer.alpha[a] > 0 && layer.alpha[b] > 0) {
        if (layer.rgb === pic.rgb) layer.rgb = new Float32Array(pic.rgb);
        for (let k = y; k < end; k++) {
          const i = k * width + x;
          const t = (k - y + 1) / (end - y + 1);
          for (let c = 0; c < 3; c++) {
            layer.rgb[i * 3 + c] =
              pic.rgb[a * 3 + c] * (1 - t) + pic.rgb[b * 3 + c] * t;
          }
          layer.alpha[i] = 1;
          region[i] = 1;
        }
      }
      y = end;
    }
  }
  fills.push({
    id: "hair_front.strands",
    region,
    sources: andNot(labels.hairFront, strand),
    limit: FILL_LIMIT,
    hint: "a strand through a brow's band is refilled far from its own hair: check landmarks.brows' bands are no wider than the brow",
  });
  return layer;
}

/** The back hair, with the head's shell behind the face and the bangs down
 *  to shellLower, the hair under each custom part's root and under the
 *  body's edge; and each custom part with its own margin under the body. */
function hairLayers(ctx: CutContext, opaque: Mask, fills: FillRegion[]) {
  const { pic, lm, labels } = ctx;
  const { width } = pic;
  const sources = hairSources(ctx, labels.hairBack);
  const filled = fillFrom(pic, sources);
  const hairBack = paintOf(pic, labels.hairBack);

  const first = lm.shellLower[0];
  const last = lm.shellLower.at(-1)!;
  const shellArea = polygonMask(pic, [
    [0, 0],
    [width - 1, 0],
    [width - 1, last[1]],
    ...[...lm.shellLower].reverse(),
    [0, first[1]],
  ]);
  const cover = or(or(labels.face, labels.hairFront), labels.skullArea);
  fills.push({
    id: "hair_back.shell",
    region: fillUnder(
      pic,
      hairBack,
      and(and(cover, shellArea), opaque),
      filled,
    ),
    sources,
    limit: null,
    hint: "the hair behind the face and the bangs, made up by construction (it shows only at the head's edge on a turn)",
  });
  const locks = sideLocks(labels);
  if (locks) {
    fills.push({
      id: "hair_back.sideHair",
      region: fillUnder(
        pic,
        hairBack,
        and(and(locks, shellArea), opaque),
        filled,
      ),
      sources,
      limit: null,
      hint: "the hair behind the side locks down to landmarks.shellLower, made up by construction (it shows beside a lock when the lock swings or the head turns)",
    });
  }
  const near = dilate(pic, labels.hairBack, UNDER_PART);
  labels.parts.forEach(({ cut, mask }, k) => {
    fills.push({
      id: `custom.${cut.id}.root`,
      region: fillUnder(pic, hairBack, and(and(near, mask), opaque), filled),
      sources,
      limit: FILL_LIMIT,
      hint: `the head's hair under ${cut.id}'s root is made up far from any back hair: move landmarks.customParts[${k}]'s ${"polygon" in cut ? "polygon" : "line"} to where the part leaves the head's hair`,
    });
  });
  // Carried from hair that can colour it: a thin strand touching the body
  // has no source of its own and is not carried.
  const underBody = (from: Mask) =>
    and(
      dilate(pic, and(from, labels.bigHair), UNDER_BODY + SOURCE_INSET),
      and(labels.body, opaque),
    );
  fills.push({
    id: "hair_back.underBody",
    region: fillUnder(pic, hairBack, underBody(sources), filled),
    sources,
    limit: FILL_LIMIT,
    hint: "the back hair under the body's edge is made up far from any back hair: check on preview-labels.png that the hair above the shoulders is labelled hair, adding landmarks.samples.hair points on its tones",
  });

  const parts = labels.parts.map(({ cut, mask }, k) => {
    const paint = paintOf(pic, mask);
    const own = hairSources(ctx, mask);
    fills.push({
      id: `custom.${cut.id}.underBody`,
      region: fillUnder(pic, paint, underBody(own), fillFrom(pic, own)),
      sources: own,
      limit: FILL_LIMIT,
      hint: `${cut.id} under the body's edge is made up far from its own hair: check landmarks.customParts[${k}] takes the part's hair down to the shoulder`,
    });
    return { id: cut.id, tie: cut.tie, paint };
  });
  return { hairBack, parts };
}

/**
 * The body: as drawn, and the neck carried up behind the chin to neckTopY,
 * under the face and the front hair only (the back hair and the custom
 * parts are drawn under the body). Each column under the jaw's lowest face
 * row carries up the neck's own skin nearest under the jaw: skin-class
 * body paint clear of lines (`neckSkin`), found down through the body's
 * paint within NECK_REACH rows, past the jaw's line and the shadow it casts.
 * A column with none (a strand's tip, a line, the backdrop's fringe under
 * the jaw) between two that have it takes their colours, blended by
 * distance. Past the outermost ones, on the row their skin was found on,
 * the neck runs on over its skin-class paint near the line (which the
 * inset leaves out) and then its own side line, at most NECK_LINE columns
 * of it; anything else there is no neck and carries nothing. The hidden
 * neck is skin all over, its sides drawn as they are below the jaw.
 */
function bodyLayer(ctx: CutContext, opaque: Mask, fills: FillRegion[]) {
  const { pic, lm, labels } = ctx;
  const { width, height } = pic;
  const body = paintOf(pic, labels.body);
  const sources = neckSkin(ctx);
  const jaws = new Int32Array(width).fill(-1);
  const from = new Int32Array(width).fill(-1);
  for (let x = 0; x < width; x++) {
    let jaw = -1;
    for (let y = height - 1; y >= 0 && jaw < 0; y--) {
      if (labels.label[y * width + x] === LABEL_FACE) jaw = y;
    }
    if (jaw < 0) continue;
    jaws[x] = jaw;
    for (let y = jaw + 1; y < height && y <= jaw + NECK_REACH; y++) {
      const i = y * width + x;
      if (labels.label[i] !== LABEL_BODY || !labels.solid[i]) break;
      if (sources[i]) {
        from[x] = i;
        break;
      }
    }
  }
  const colour = new Float32Array(width * 3);
  const carried = new Uint8Array(width);
  let left = -1;
  for (let x = 0; x < width; x++) {
    if (from[x] < 0) continue;
    for (let c = 0; c < 3; c++) colour[x * 3 + c] = pic.rgb[from[x] * 3 + c];
    carried[x] = 1;
    // The columns since the last with skin: blended across from both.
    for (let g = left + 1; left >= 0 && g < x; g++) {
      const t = (g - left) / (x - left);
      for (let c = 0; c < 3; c++) {
        colour[g * 3 + c] =
          colour[left * 3 + c] * (1 - t) + colour[x * 3 + c] * t;
      }
      carried[g] = 1;
    }
    left = x;
  }
  const first = from.findIndex((v) => v >= 0);
  let last = width - 1;
  while (last >= 0 && from[last] < 0) last--;
  // Out from each side of the neck on the row its skin was found on.
  for (const [end, step] of [
    [first, -1],
    [last, 1],
  ]) {
    if (end < 0) break;
    const row = Math.floor(from[end] / width);
    let line = 0;
    for (let x = end + step; x >= 0 && x < width && jaws[x] >= 0; x += step) {
      const i = row * width + x;
      if (labels.label[i] !== LABEL_BODY || !labels.solid[i]) break;
      // Skin up to the line, then the line itself.
      if (labels.classes[i] !== SKIN || line > 0) {
        if (labels.classes[i] !== NEITHER || line === NECK_LINE) break;
        line++;
      }
      for (let c = 0; c < 3; c++) colour[x * 3 + c] = pic.rgb[i * 3 + c];
      carried[x] = 1;
    }
  }
  const neck = new Uint8Array(width * height);
  for (let x = 0; x < width; x++) {
    if (!carried[x] || jaws[x] < 0) continue;
    for (let y = Math.round(lm.neckTopY); y <= jaws[x]; y++) {
      const i = y * width + x;
      if (opaque[i] && (labels.face[i] || labels.hairFront[i])) neck[i] = 1;
    }
  }
  fills.push({
    id: "body.neck",
    region: fillUnder(pic, body, neck, (i) => {
      const x = i % width;
      return colour.subarray(x * 3, x * 3 + 3);
    }),
    sources,
    limit: null,
    hint: "the neck behind the chin, carried up to landmarks.neckTopY from the neck's own skin by construction",
  });
  return body;
}

/** Every side lock's hair, or null with no `sideHair` polygon. */
function sideLocks(labels: IllustrationLabels): Mask | null {
  const { L, R } = labels.hairSide;
  return L && R ? or(L, R) : (L ?? R ?? null);
}

/** Each side lock with paint, its root carried up from its top edge under
 *  the front hair by SIDE_ROOT_REACH, column by column, as far as the front
 *  hair is opaque above it, filled from the lock's own hair. */
function sideLockLayers(
  ctx: CutContext,
  opaque: Mask,
  fills: FillRegion[],
): Map<string, LayerPaint> {
  const { pic, labels } = ctx;
  const { width } = pic;
  const out = new Map<string, LayerPaint>();
  for (const side of ["L", "R"] as const) {
    const mask = labels.hairSide[side];
    if (!mask || count(mask) === 0) continue;
    const layer = paintOf(pic, mask);
    const root = new Uint8Array(mask.length);
    for (let i = width; i < mask.length; i++) {
      if (!mask[i] || mask[i - width]) continue;
      for (let j = i - width, k = 0; j >= 0 && k < SIDE_ROOT_REACH; k++) {
        if (!labels.hairFront[j] || !opaque[j]) break;
        root[j] = 1;
        j -= width;
      }
    }
    const own = hairSources(ctx, mask);
    fills.push({
      id: `hair_side_${side}.root`,
      region: fillUnder(pic, layer, root, fillFrom(pic, own)),
      sources: own,
      limit: FILL_LIMIT,
      hint: `the lock's root under the bangs is filled far from the lock's own hair (strands thinner than about 5 px have none clear of their lines); it never shows at rest: check on preview-labels.png that landmarks.sideHair.${side} holds the lock`,
    });
    out.set(`hair_side_${side}`, layer);
  }
  return out;
}

/** The neck's own skin: skin-class body paint, solid, clear of lines. */
function neckSkin(ctx: CutContext): Mask {
  const { labels } = ctx;
  return erode(
    ctx.pic,
    labels.body.map((v, i) =>
      v && labels.solid[i] && labels.classes[i] === SKIN ? 1 : 0,
    ),
    SOURCE_INSET,
  );
}

/** The face, the features, the hair (the side locks too), the body and the
 *  custom parts, with their fills. With `lipSet` the drawn mouth leaves the
 *  face as no layer. */
function buildLayers(ctx: CutContext, lipSet: boolean): BuiltLayers {
  const { pic } = ctx;
  const fills: FillRegion[] = [];
  const opaque = Uint8Array.from(pic.alpha, (a) => (a >= OPAQUE_ALPHA ? 1 : 0));
  const features = cutFeatures(ctx, lipSet);
  const face = faceLayer(ctx, opaque, fills, features);
  const { hairBack, parts } = hairLayers(ctx, opaque, fills);
  const body = bodyLayer(ctx, opaque, fills);
  return {
    roles: new Map([
      ["hair_back", hairBack],
      ["body", body],
      ["face", face],
      ...features.roles,
      ...sideLockLayers(ctx, opaque, fills),
      ["hair_front", frontHairLayer(ctx, fills)],
    ]),
    parts,
    fills,
    features,
    opaque,
  };
}

// ---- the lip set ----

/** The layer each of the composer's lip-set buffers is written as. */
const LIP_LAYERS = {
  mouth_inner: "inner",
  mouth_tongue: "tongue",
  mouth_teeth: "teeth",
  lip_lower: "lower",
  lip_upper: "upper",
} as const;

/** The rows of a frame's first and last columns, each its paint's
 *  alpha-weighted mean, as edge coordinates (a pixel's centre at +0.5): the
 *  ends of a trimmed mouth's line, where its corners are. */
async function endRows(png: Buffer): Promise<[number, number]> {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const row = (x: number) => {
    let sum = 0;
    let weight = 0;
    for (let y = 0; y < info.height; y++) {
      const a = data[(y * info.width + x) * 4 + 3];
      sum += a * (y + 0.5);
      weight += a;
    }
    return sum / weight;
  };
  return [row(0), row(info.width - 1)];
}

/**
 * The lip set, cut by the composer from the keyed mouth and the interior,
 * placed so its own corners (the trimmed frame's end columns, which are the
 * line's ends and go to `lip_upper`) land on landmarks.mouth's: scaled
 * uniformly by the two corners' distance, their midpoint on the drawn
 * corners'. Not turned: on a tilted drawn mouth the set lies level, centred
 * on the tilt. `mouth_tongue` / `mouth_teeth` only when the interior has
 * light paint for them, as the composer writes them.
 */
async function lipSetLayers(
  ctx: CutContext,
  lips: LipSources,
): Promise<Map<string, LayerPaint>> {
  const { pic, lm } = ctx;
  const canvas = { width: pic.width, height: pic.height };
  const cfg = { src: KEYED_SRC };
  // Never null: the keyed part is in memory.
  const trimmed = (await trimmedPart(
    "mouth_inner",
    cfg,
    "",
    lips.keyedPng,
    false,
  ))!;
  const [rowA, rowB] = await endRows(trimmed.data);
  const { cornerL, cornerR } = lm.mouth;
  const drawn = Math.hypot(cornerR[0] - cornerL[0], cornerR[1] - cornerL[1]);
  const own = Math.hypot(trimmed.w - 1, rowB - rowA);
  const corners = "landmarks.mouth.cornerL/cornerR";
  /** The set sized `w` px wide and split by the composer. */
  const cutAt = async (w: number) => {
    let part;
    try {
      part = await sizedPart("mouth_inner", { ...cfg, w }, trimmed, canvas);
    } catch (e) {
      // The composer names its layout key; here the size comes from the
      // corners.
      if (e instanceof AutoRigInputError) {
        throw new AutoRigInputError(
          e.message.replace(
            "layout.mouth_inner.w:",
            `${corners}: the lip set scaled to the corners,`,
          ),
        );
      }
      throw e;
    }
    return {
      part,
      split: await splitLipSet(part.buf, part.w, part.h, lips.interior),
    };
  };
  /** Whether the set cuts at `w` px wide. */
  const cutsAt = async (w: number) => {
    try {
      await cutAt(w);
      return true;
    } catch (e) {
      if (e instanceof AutoRigInputError) return false;
      throw e;
    }
  };
  const w = Math.max(1, Math.round((trimmed.w * drawn) / own));
  let cut;
  try {
    cut = await cutAt(w);
  } catch (e) {
    // Scaled down, the key's outline can thin past closing, which its own
    // message blames on the drawing. If it cuts at its drawn size, the
    // corners are what is too close: name the least distance that cuts.
    if (!(e instanceof AutoRigInputError) || w >= trimmed.w) throw e;
    if (!(await cutsAt(trimmed.w))) throw e;
    let lo = w;
    let hi = trimmed.w;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (await cutsAt(mid)) hi = mid;
      else lo = mid;
    }
    // The least distance whose width rounds to `hi`.
    const least = Math.ceil(((hi - 0.5) * own) / trimmed.w);
    throw new AutoRigInputError(
      `${corners} are ${Number(drawn.toFixed(1))} px apart, too close for the lip set: scaled that small, its outline thins past closing round the opening (the drawing itself cuts at its own size, so it needs no regenerating). It cuts from ${least} px apart: check the corners sit on the drawn mouth line's two ends; on a mouth drawn smaller than that, leave mouthKeyed and mouthInterior out to keep the drawn mouth`,
    );
  }
  const { part, split } = cut;
  // Read off the resized frame, not scaled from the trimmed one: the
  // resampler moves a row by a fraction of a pixel, which rounds to a row.
  const [landedA, landedB] = await endRows(part.buf);
  const left = Math.round((cornerL[0] + cornerR[0]) / 2 + 0.5 - part.w / 2);
  const top = Math.round(
    (cornerL[1] + cornerR[1]) / 2 + 0.5 - (landedA + landedB) / 2,
  );
  // Clipped by the canvas, a lip layer loses rows the fold reads, or is
  // lost whole and the set is partial, which the rig refuses.
  if (
    left < 0 ||
    top < 0 ||
    left + part.w > pic.width ||
    top + part.h > pic.height
  ) {
    throw new AutoRigInputError(
      `${corners} place the lip set, ${part.w}x${part.h} px, at (${left}, ${top}), past the ${pic.width}x${pic.height} canvas: the set reaches ${Math.round((landedA + landedB) / 2)} px above its corners and ${part.h - Math.round((landedA + landedB) / 2)} px below them. Check the corners sit on the drawn mouth line's two ends (corners too far apart make the set too big); with no room on the canvas round the mouth, leave mouthKeyed and mouthInterior out to keep the drawn mouth`,
    );
  }

  const out = new Map<string, LayerPaint>();
  for (const [role, key] of Object.entries(LIP_LAYERS)) {
    const buf = split[key];
    if ((key === "tongue" || key === "teeth") && !(await hasCoverage(buf))) {
      continue;
    }
    const rgba = await sharp({
      create: {
        width: pic.width,
        height: pic.height,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([{ input: buf, left, top }])
      .raw()
      .toBuffer();
    const n = pic.width * pic.height;
    const layer: LayerPaint = {
      rgb: new Float32Array(n * 3),
      alpha: new Float32Array(n),
    };
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) layer.rgb[i * 3 + c] = rgba[i * 4 + c];
      layer.alpha[i] = rgba[i * 4 + 3] / 255;
    }
    out.set(role, layer);
  }
  return out;
}

// ---- checks ----

/** Each written layer in draw order: the roles by ORDER, the custom parts
 *  right after the back hair. */
function stackOrder(built: BuiltLayers): Buffer[] {
  const out: Buffer[] = [];
  for (const role of ORDER) {
    const layer = built.roles.get(role);
    if (layer) out.push(encodeLayer(layer));
    if (role === "hair_back") {
      for (const p of built.parts) out.push(encodeLayer(p.paint));
    }
  }
  return out;
}

function stackCheck(ctx: CutContext, stacked: Buffer[]): CutCheck {
  const { pic, source, lm } = ctx;
  const n = pic.width * pic.height;
  const mouth = boxMask(pic, lm.mouth.box);
  const flat = pic.backdrop;
  let off = 0;
  let mouthOff = 0;
  const mouthPixels = count(mouth);
  const acc = new Float32Array(4);
  for (let i = 0; i < n; i++) {
    // Over the backdrop when it was keyed, so a soft edge compares as the
    // picture shows it; premultiplied over transparency otherwise.
    acc[0] = flat ? flat[0] : 0;
    acc[1] = flat ? flat[1] : 0;
    acc[2] = flat ? flat[2] : 0;
    acc[3] = flat ? 255 : 0;
    for (const layer of stacked) {
      const a = layer[i * 4 + 3] / 255;
      if (a === 0) continue;
      for (let c = 0; c < 3; c++) {
        acc[c] = layer[i * 4 + c] * a + acc[c] * (1 - a);
      }
      acc[3] = 255 * a + acc[3] * (1 - a);
    }
    // `acc` is premultiplied, which over the opaque backdrop is the colour
    // itself.
    const sa = source.rgba[i * 4 + 3] / 255;
    let worst = Math.abs(acc[3] - source.rgba[i * 4 + 3]);
    for (let c = 0; c < 3; c++) {
      worst = Math.max(worst, Math.abs(acc[c] - source.rgba[i * 4 + c] * sa));
    }
    if (worst <= STACK_LEVELS) continue;
    if (mouth[i]) mouthOff++;
    else off++;
  }
  const value = off / n;
  return {
    id: "stack",
    level: "fail",
    pass: value <= STACK_LIMIT,
    value: fmt(value, 5),
    limit: STACK_LIMIT,
    hint:
      value <= STACK_LIMIT
        ? "the layers stack back into the picture"
        : `the layers stacked differ from the picture on ${off} px (${pct(value)}) outside the mouth's box: paint no layer took, or a fill drawn over paint; find it on preview-labels.png and move the seed or outline that left it out`,
    apart: { mouthBox: fmt(mouthPixels ? mouthOff / mouthPixels : 0, 5) },
  };
}

const className = (c: number) =>
  c === HAIR ? "hair" : c === SKIN ? "skin" : "neither";

function seedsCheck(ctx: CutContext): CutCheck {
  const { pic, lm, labels, reads } = ctx;
  const problems: string[] = [];
  const unchecked: string[] = [];
  const show = (p: Point) => `[${p[0]}, ${p[1]}]`;
  lm.skinSeeds.forEach((p, k) => {
    const i = pixelIndex(pic, p);
    const where = `landmarks.skinSeeds[${k}] ${show(p)}`;
    if (!labels.solid[i]) {
      problems.push(
        `${where} is on the backdrop: move it onto the face's skin`,
      );
    } else if (labels.classes[i] !== SKIN) {
      problems.push(
        `${where} reads as ${labels.classes[i] === HAIR ? "hair" : "neither hair nor skin (a line, a feature)"}: move it onto plain skin, or add a landmarks.samples.skin.shadow point on that tone`,
      );
    }
  });
  lm.bodySeeds.forEach((p, k) => {
    const i = pixelIndex(pic, p);
    const where = `landmarks.bodySeeds[${k}] ${show(p)}`;
    if (!labels.solid[i]) {
      problems.push(
        `${where} is on the backdrop: move it onto the neck or the clothes`,
      );
    } else if (labels.classes[i] === HAIR && !labels.bodyOnlyArea[i]) {
      problems.push(
        `${where} reads as hair: move it onto the neck or the clothes, or put a landmarks.bodyOnly polygon over that paint`,
      );
    }
  });
  // A sample is a member of its own set, so it is judged by the classifier
  // the other samples make: one on a line or the other class's paint then
  // reads as what it really is. Only where its tone has another point; a
  // lone point carries its tone, and leaving it out says nothing.
  const all = [...reads.hair, ...reads.skin];
  const tone = (path: string) => path.slice(0, path.lastIndexOf("["));
  for (const s of all) {
    const own = s.path.includes(".hair.") ? HAIR : SKIN;
    if (!s.onPaint) {
      problems.push(
        `${s.path} ${show(s.point)} is on the backdrop: move it onto the ${className(own)}'s paint`,
      );
      continue;
    }
    const others = all.filter(
      (r) => r !== s && r.lab !== null && tone(r.path) === tone(s.path),
    );
    if (others.length === 0) {
      unchecked.push(tone(s.path));
      continue;
    }
    const judge = buildClassifier(withoutSample(reads, s.path));
    const cls = judge && s.rgb ? judge.classify(...s.rgb) : NEITHER;
    if (cls !== own) {
      problems.push(
        `${s.path} ${show(s.point)} reads as ${className(cls)} to the other samples: it sits on a line or on the other class's paint (move it onto a flat patch of ${className(own)}), or on a tone no other point covers (add a second point on that tone)`,
      );
    }
  }
  const note =
    unchecked.length > 0
      ? `; not judged against the rest (one point each): ${unchecked.join(", ")}`
      : "";
  return {
    id: "seeds",
    level: "fail",
    pass: problems.length === 0,
    value: problems.length,
    limit: 0,
    hint:
      (problems.length === 0
        ? "every seed and sample sits on its paint"
        : problems.join("; ")) + note,
  };
}

function fillCheck(size: CanvasSize, fill: FillRegion): CutCheck {
  const reach = dilate(size, fill.sources, FILL_REACH);
  let total = 0;
  let far = 0;
  for (let i = 0; i < fill.region.length; i++) {
    if (!fill.region[i]) continue;
    total++;
    if (!reach[i]) far++;
  }
  const value = total ? far / total : 0;
  const pass = fill.limit === null || value <= fill.limit;
  const share = `${pct(value)} of the ${total} px filled are over ${FILL_REACH} px from the paint they are filled from`;
  return {
    id: `fills.${fill.id}`,
    level: "warn",
    pass,
    value: fmt(value),
    limit: fill.limit,
    hint:
      fill.limit === null
        ? `${share}: ${fill.hint}`
        : pass
          ? share
          : `${share}: ${fill.hint}`,
  };
}

/** A region of opaque, backdrop-coloured paint outside the face. */
interface Pocket {
  size: number;
  /** A point well inside it (2 px or more from its edge when it has one),
   *  one a `backgroundSeeds` point is accepted at when it is `seedable`. */
  at: Point;
  /** Whether `at` is 2 px or more inside. */
  deep: boolean;
  /** Whether POCKET_SEED_SHARE of it takes a `backgroundSeeds` point
   *  (`backdropSeed`), `at` among them: one under it is pale paint, near the
   *  backdrop's colour on the canvas but past it in the picture (a fine
   *  texture the resize averages). */
  seedable: boolean;
  pixels: number[];
  /** Share of the painted pixels POCKET_RING_IN to POCKET_RING_OUT px
   *  around it labelled hair: the ink between the pocket and the paint
   *  closing it in is looked through. */
  hairShare: number;
}

/**
 * Backdrop the figure encloses, out of the border flood's reach, stays
 * paint: it reads `neither`, and a flood from the body or the hair runs into
 * it. These are the backdrop-coloured regions outside the face of at least
 * POCKET_PX, largest first.
 */
export function findPockets(
  pic: Illustration,
  labels: IllustrationLabels,
  source: CanvasPicture,
): Pocket[] {
  const { width, height, backdrop } = pic;
  // A picture with no backdrop to key has no backdrop-coloured paint.
  if (!backdrop) return [];
  const n = width * height;
  const candidate = and(
    backdropColoured(pic),
    labels.label.map((l) => (l === LABEL_FACE ? 0 : 1)),
  );
  const owner = new Int32Array(n).fill(-1);
  const deep = erode(pic, candidate, 2);
  const seedable = (i: number) =>
    backdropSeed(source, backdrop, i % width, Math.floor(i / width)).ok;
  const found: Omit<Pocket, "hairShare">[] = [];
  for (let s = 0; s < n; s++) {
    if (!candidate[s] || owner[s] !== -1) continue;
    const queue = [s];
    owner[s] = -2;
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q];
      const x = i % width;
      for (const j of [
        x > 0 ? i - 1 : -1,
        x < width - 1 ? i + 1 : -1,
        i - width,
        i + width < n ? i + width : -1,
      ]) {
        if (j >= 0 && candidate[j] && owner[j] === -1) {
          owner[j] = -2;
          queue.push(j);
        }
      }
    }
    if (queue.length < POCKET_PX) continue;
    // Named at the first pixel a seed is accepted at, deep inside if one
    // is; a pocket no seed clears, at its first deep one.
    let deepSeed = -1;
    let anySeed = -1;
    let firstDeep = -1;
    let accepted = 0;
    for (const i of queue) {
      if (deep[i] && firstDeep < 0) firstDeep = i;
      if (!seedable(i)) continue;
      accepted++;
      if (anySeed < 0) anySeed = i;
      if (deep[i] && deepSeed < 0) deepSeed = i;
    }
    const takesSeed = accepted >= POCKET_SEED_SHARE * queue.length;
    const at = takesSeed
      ? deepSeed >= 0
        ? deepSeed
        : anySeed
      : firstDeep >= 0
        ? firstDeep
        : s;
    for (const i of queue) owner[i] = found.length;
    found.push({
      size: queue.length,
      at: [at % width, Math.floor(at / width)],
      deep: deep[at] === 1,
      seedable: takesSeed,
      pixels: queue,
    });
  }

  // Every pocket's ring at once: one search out from all of them, a pixel
  // going to the pocket that reaches it first, POCKET_RING_OUT steps deep
  // (8-connected, so a step is a Chebyshev px).
  const ring = new Float64Array(found.length);
  const hair = new Float64Array(found.length);
  const depth = new Int16Array(n).fill(-1);
  let front: number[] = [];
  for (let i = 0; i < n; i++) {
    if (owner[i] >= 0) {
      depth[i] = 0;
      front.push(i);
    }
  }
  for (let d = 1; d <= POCKET_RING_OUT && front.length > 0; d++) {
    const next: number[] = [];
    for (const i of front) {
      const x = i % width;
      const y = (i - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const j = yy * width + xx;
          if (depth[j] !== -1) continue;
          depth[j] = d;
          owner[j] = owner[i];
          next.push(j);
          if (d >= POCKET_RING_IN && !candidate[j] && labels.fg[j]) {
            ring[owner[i]]++;
            if (labels.label[j] === LABEL_HAIR) hair[owner[i]]++;
          }
        }
      }
    }
    front = next;
  }
  return found
    .map((p, k) => ({ ...p, hairShare: ring[k] ? hair[k] / ring[k] : 0 }))
    .sort((a, b) => b.size - a.size);
}

/**
 * The pockets to key as backdrop on their own, a point inside each: those
 * the hair rings (a gap between strands, between a tail and the head's
 * hair), up to POCKET_KEY_SHARE of the canvas. A pocket rung by skin, cloth
 * or a mix (a white shirt on a white ground) may be paint, and is left to
 * the agent; so is one holding a `paintSeeds` point, and one over the cap.
 */
export function hairRungPockets(
  pic: Illustration,
  labels: IllustrationLabels,
  paintSeeds: Point[],
  source: CanvasPicture,
): Point[] {
  const paint = new Set(paintSeeds.map((p) => pixelIndex(pic, p)));
  const cap = POCKET_KEY_SHARE * pic.width * pic.height;
  return findPockets(pic, labels, source)
    .filter(
      (p) =>
        p.seedable &&
        p.deep &&
        p.size <= cap &&
        p.hairShare >= POCKET_HAIR_SHARE &&
        !p.pixels.some((i) => paint.has(i)),
    )
    .map((p) => p.at);
}

/** The pockets keyed on their own and those named for `backgroundSeeds`:
 *  its value is how many of both, each to be looked at. A pocket no seed is
 *  accepted in is pale paint, said so and not counted. */
function pocketsCheck(ctx: CutContext): CutCheck {
  const found = findPockets(ctx.pic, ctx.labels, ctx.source);
  const pockets = found.filter((p) => p.seedable);
  const pale = found.filter((p) => !p.seedable);
  const show = (p: Point) => `[${p[0]}, ${p[1]}]`;
  const list = (ps: Pocket[]) => {
    const named = ps
      .slice(0, POCKETS_NAMED)
      .map((p) => `${show(p.at)} (${p.size} px)`);
    return `${ps.length > named.length ? `the largest ${named.length} at` : "at"} ${named.join(", ")}`;
  };
  const parts: string[] = [];
  const plural = (k: number, one: string, many: string) =>
    `${k} ${k === 1 ? one : many}`;
  // An automatic key may have taken paint: it always warns, first, so the
  // keyed points are looked at on preview-labels.png.
  if (ctx.keyed.length > 0) {
    parts.push(
      `keyed ${plural(ctx.keyed.length, "gap", "gaps")} the hair rings as backdrop on ${ctx.keyed.length === 1 ? "its" : "their"} own, at ${ctx.keyed.map(show).join(", ")}; check each on preview-labels.png, and if one is paint (an ornament, a pale panel), add a point inside it to landmarks.paintSeeds`,
    );
  }
  if (pockets.length > 0) {
    const one = pockets.length === 1;
    parts.push(
      `${plural(pockets.length, "region", "regions")} of backdrop-coloured paint the border flood cannot reach, ${list(pockets)}, ${one ? "is" : "are"} cut into a layer: if ${one ? "it is" : "one is"} backdrop showing through (a gap between the neck and a tail, under an arm), add its point to landmarks.backgroundSeeds`,
    );
  }
  if (pale.length > 0) {
    const one = pale.length === 1;
    parts.push(
      `${plural(pale.length, "region", "regions")} near the backdrop's colour, ${list(pale)}, ${one ? "is" : "are"} pale paint, not backdrop (the picture there is too far from the backdrop's colour to key), and ${one ? "stays" : "stay"} in ${one ? "its layer" : "their layers"}: ${one ? "it needs" : "they need"} nothing`,
    );
  }
  const value = ctx.keyed.length + pockets.length;
  return {
    id: "pockets",
    level: "warn",
    pass: value === 0,
    value,
    limit: 0,
    keyed: ctx.keyed,
    hint:
      parts.length === 0
        ? "no backdrop-coloured paint outside the face"
        : parts.join("; "),
  };
}

function frontHairWidthCheck(ctx: CutContext, built: BuiltLayers): CutCheck {
  const { pic, lm } = ctx;
  const row = Math.round((lm.eyes.L.iris.cy + lm.eyes.R.iris.cy) / 2);
  const face = built.roles.get("face")!;
  let x0 = Infinity;
  let x1 = -Infinity;
  for (let x = 0; x < pic.width; x++) {
    if (face.alpha[row * pic.width + x] > 0.5) {
      x0 = Math.min(x0, x);
      x1 = x;
    }
  }
  const faceWidth = x1 >= x0 ? x1 - x0 + 1 : 0;
  const hairBox = maskBox(pic, built.roles.get("hair_front")!.alpha);
  const hairWidth = hairBox ? hairBox[2] - hairBox[0] + 1 : 0;
  if (faceWidth === 0) {
    return {
      id: "frontHairWidth",
      level: "warn",
      pass: false,
      value: null,
      limit: 1,
      hint: `no face on the eye row ${row}: put landmarks.skinSeeds on the cheeks so the face's flood reaches it`,
    };
  }
  const value = hairWidth / faceWidth;
  return {
    id: "frontHairWidth",
    level: "warn",
    pass: value <= 1,
    value: fmt(value),
    limit: 1,
    hint:
      value <= 1
        ? `hair_front is ${hairWidth} px wide, the face ${faceWidth} px at the eye row ${row}`
        : `hair_front is ${hairWidth} px wide, wider than the face's ${faceWidth} px at the eye row ${row}: the head turn will be clamped; narrow landmarks.frontHair to the face, leaving the hair beyond it in the back hair`,
  };
}

/**
 * A side lock as the rig needs it: hair in its polygon; a top row whose
 * pixels each have the front hair's opaque paint right above, so its root is
 * carried under the bangs (a stretch of VISIBLE_MIN_PX or more past them
 * shows the root at rest, the measure's reading); and, at rest, clear of its
 * eye (`overEye`: the rig slides the eye's outer corner under the lock on
 * the turn). Each problem names which way to move the polygon.
 */
function sideHairCheck(
  ctx: CutContext,
  built: BuiltLayers,
  side: "L" | "R",
): CutCheck {
  const { pic, labels } = ctx;
  const { opaque } = built;
  const { width } = pic;
  const at = `landmarks.sideHair.${side}`;
  const role = `hair_side_${side}`;
  /** Outward, as the viewer sees it: L is on the viewer's right. */
  const outward = side === "L" ? "right" : "left";
  const mask = labels.hairSide[side]!;
  const problems: string[] = [];
  const box = maskBox(pic, mask);
  if (!box) {
    // Hair inside the polygon that another cut took: the front hair keeps
    // what both claim, and L what both sides' polygons claim.
    const inside = and(labels.hair, polygonMask(pic, ctx.lm.sideHair![side]!));
    const takers = [
      [
        labels.hairFront,
        "landmarks.frontHair, which keeps the paint both claim",
      ],
      [
        side === "R" ? labels.hairSide.L : undefined,
        "landmarks.sideHair.L, which keeps the paint both sides' polygons claim",
      ],
    ] as const;
    const took = takers.filter(([m]) => m && count(and(inside, m)) > 0);
    problems.push(
      count(inside) === 0
        ? `${at} holds no hair, so no ${role} is written: move it onto the lock hanging in front of the ear on the viewer's ${outward}, or check on preview-labels.png that the lock is labelled hair (add landmarks.samples.hair points on its tones)`
        : `all of the hair inside ${at} is taken by ${took.map(([, by]) => by).join(", and by ")}, so no ${role} is written: ${took.some(([m]) => m !== labels.hairFront) ? "pull the two polygons apart" : "start the polygon below the front hair's edge (or the hair is the bangs', not a side lock)"}`,
    );
  } else {
    const top = box[1];
    const front = (j: number) => j >= 0 && labels.hairFront[j] && opaque[j];
    // The top row's pixels with no front hair right above, in stretches.
    let shown = 0;
    let x0 = Infinity;
    let x1 = -Infinity;
    let stretch = 0;
    for (let x = box[0]; x <= box[2] + 1; x++) {
      const i = top * width + x;
      if (x <= box[2] && mask[i] && !front(i - width)) {
        stretch++;
        continue;
      }
      if (stretch >= VISIBLE_MIN_PX) {
        shown += stretch;
        x0 = Math.min(x0, x - stretch);
        x1 = Math.max(x1, x - 1);
      }
      stretch = 0;
    }
    if (shown > 0) {
      // How far up the front hair is over those columns, if anywhere.
      let gap = Infinity;
      for (let x = x0; x <= x1; x++) {
        for (let y = top - 1; y >= 0 && top - 1 - y < gap; y--) {
          if (front(y * width + x)) {
            gap = top - 1 - y;
            break;
          }
        }
      }
      const above = Number.isFinite(gap)
        ? `hair_front ends ${gap} px above it there`
        : "no hair_front lies above it there";
      problems.push(
        `${role}'s top row (y ${top}) shows past hair_front on ${shown} px, x ${x0}-${x1}: ${above}, so its root shows at rest and is not carried under the bangs. Move ${at}'s top up${Number.isFinite(gap) ? ` ${gap} px or more` : ""} into landmarks.frontHair (the two may overlap; the front hair keeps the paint both take), or extend landmarks.frontHair down over the lock's top`,
      );
    }
    const over = overEye(ctx, built, side);
    if (over) {
      problems.push(
        `${role} reaches ${over.px} px over eye_${side} at rest (to x ${over.x} on y ${over.y}), past landmarks.eyes.${side}.box's ${EYE_BOX_SPARE} px of spare and the lock's ${LOCK_LINE} px outline: the rig slides the eye's outer corner under the lock on the turn, so it must lie clear of it at rest. Pull ${at}'s inner edge back ${over.px} px or more to the ${outward}, to x ${side === "R" ? "<=" : ">="} ${over.edge}, and widen landmarks.frontHair over the hair it leaves; if hair is really drawn over the eye there, the cut cannot split it from the eye: report it`,
      );
    }
  }
  return {
    id: `sideHair.${side}`,
    level: "warn",
    pass: problems.length === 0,
    value: problems.length,
    limit: 0,
    hint:
      problems.length > 0
        ? problems.join("; ")
        : `${role} is ${count(mask)} px, its root carried up to ${SIDE_ROOT_REACH} px under hair_front`,
  };
}

/** The spare a declared eye box keeps past the drawn eye, px: the opening
 *  check asks for 2 to 4. */
const EYE_BOX_SPARE = 4;

/**
 * Whether a side lock lies over its eye at rest (the rig slides the eye's
 * outer corner under the lock on the turn, so the corner must be clear of
 * it). A cut eye stops where a lock covers it, so the eye's own layer cannot
 * tell; this reads the box the agent declared round the whole drawn eye
 * instead. On the eye's rows (its layer's, or the box's without one) the
 * lock's paint may reach into the box from its outer edge by the box's spare
 * and the lock's own outline (EYE_BOX_SPARE + LOCK_LINE); `px` is how far
 * past that it reaches, reported from VISIBLE_MIN_PX, with the column it
 * reaches and its row.
 */
function overEye(
  ctx: CutContext,
  built: BuiltLayers,
  side: "L" | "R",
): { px: number; x: number; y: number; edge: number } | null {
  const { pic, lm } = ctx;
  const { width } = pic;
  const lock = built.roles.get(`hair_side_${side}`);
  if (!lock) return null;
  const [x0, y0, x1, y1] = lm.eyes[side].box;
  const eye = built.roles.get(`eye_${side}`);
  const eyeBox =
    eye &&
    maskBox(
      pic,
      eye.alpha.map((a) => (a >= 0.5 ? 1 : 0)),
    );
  const top = eyeBox ? Math.max(y0, eyeBox[1]) : y0;
  const bottom = eyeBox ? Math.min(y1, eyeBox[3]) : y1;
  const allowed = EYE_BOX_SPARE + LOCK_LINE;
  let best: { px: number; x: number; y: number; edge: number } | null = null;
  for (let y = top; y <= bottom; y++) {
    for (let x = x0; x <= x1; x++) {
      if (lock.alpha[y * width + x] < 0.5) continue;
      const depth = side === "R" ? x - x0 + 1 : x1 - x + 1;
      const px = depth - allowed;
      if (px >= VISIBLE_MIN_PX && (!best || px > best.px)) {
        best = {
          px,
          x,
          y,
          edge: side === "R" ? x0 + allowed - 1 : x1 - allowed + 1,
        };
      }
    }
  }
  return best;
}

// ---- previews ----

type Image = ReturnType<typeof pictureView>;
type RGB = [number, number, number];
const LABEL_COLOURS: Record<string, RGB> = {
  features: [40, 200, 70],
  face: [255, 190, 140],
  hair_front: [235, 50, 60],
  hair_side: [250, 140, 30],
  hair_back: [150, 60, 220],
  body: [40, 100, 240],
};
const PART_COLOURS: RGB[] = [
  [30, 200, 220],
  [60, 220, 90],
  [235, 205, 30],
  [235, 90, 200],
];
/** The label colour's share over the picture: enough to read the label,
 *  little enough to see the paint under it. */
const LABEL_OPACITY = 0.6;

function labelsPreview(ctx: CutContext, built: BuiltLayers): Image {
  const { pic, source, labels } = ctx;
  const img = pictureView(
    source,
    { x: 0, y: 0, w: pic.width, h: pic.height },
    1,
  );
  const tint = (m: Mask, c: RGB) => {
    for (let i = 0; i < m.length; i++) {
      if (!m[i]) continue;
      for (let k = 0; k < 3; k++) {
        img.rgb[i * 3 + k] = Math.round(
          img.rgb[i * 3 + k] * (1 - LABEL_OPACITY) + c[k] * LABEL_OPACITY,
        );
      }
    }
  };
  tint(labels.face, LABEL_COLOURS.face);
  tint(labels.body, LABEL_COLOURS.body);
  tint(labels.hairFront, LABEL_COLOURS.hair_front);
  tint(labels.hairBack, LABEL_COLOURS.hair_back);
  for (const m of [labels.hairSide.L, labels.hairSide.R]) {
    if (m) tint(m, LABEL_COLOURS.hair_side);
  }
  labels.parts.forEach(({ mask }, k) =>
    tint(mask, PART_COLOURS[k % PART_COLOURS.length]),
  );
  tint(built.features.holes, LABEL_COLOURS.features);
  return img;
}

function landmarksPreview(ctx: CutContext): Image {
  const crop = { x: 0, y: 0, w: ctx.pic.width, h: ctx.pic.height };
  const img = pictureView(ctx.source, crop, 1);
  drawLandmarks(img, ctx.lm as unknown as Record<string, unknown>, crop, 1);
  return img;
}

// ---- the tool ----

/** The colour classifier, or a refusal naming the set with no sample on
 *  paint. */
function classifierFor(
  pic: Illustration,
  lm: IllustrationLandmarks,
): { classifier: ColourClassifier; reads: SampleReads } {
  const reads = readSamples(pic, lm.samples);
  const classifier = buildClassifier(reads);
  if (classifier === null) {
    const empty = reads.hair.every((r) => r.lab === null) ? "hair" : "skin";
    throw new AutoRigInputError(
      `landmarks.samples.${empty}: no sample is on paint, so there is nothing to tell hair from skin by; move them onto the ${empty}`,
    );
  }
  return { classifier, reads };
}

/**
 * Cut the picture into layers in `outputDir`. Only caller-input failures
 * (`AutoRigInputError`) come back as `{ ok: false, error }`; a refusal
 * writes nothing. A write that fails part-way says the dir is now a mix:
 * the files written before it replace an earlier cut's of the same name, and
 * the rest of that cut's files (a role this cut would have removed too) are
 * still there until the cut is run again.
 */
export async function cutLayersFromIllustration(
  input: CutLayersFromIllustrationInput,
): Promise<CutLayersFromIllustrationResult> {
  try {
    // First, so a refused target costs no decode.
    const outDir = resolveOutputDir(input.outputDir);
    if (
      (input.mouthKeyed === undefined) !==
      (input.mouthInterior === undefined)
    ) {
      throw new AutoRigInputError(
        input.mouthKeyed === undefined
          ? "mouthInterior needs mouthKeyed: the lip set is cut from the keyed open mouth, and the interior is fitted into its opening; give both, or neither to keep the drawn mouth"
          : "mouthKeyed needs mouthInterior: the drawn interior is fitted into the keyed opening; give both, or neither to keep the drawn mouth",
      );
    }
    const source = await readPictureOnCanvas(input.imagePath);
    const lm = validateLandmarks(input.landmarks, source);
    // Keyed before the cut, so a key that fails costs no cut.
    const lips =
      input.mouthKeyed === undefined || input.mouthInterior === undefined
        ? undefined
        : await readLipSources(
            resolveInputPath(input.mouthKeyed, "mouthKeyed"),
            resolveInputPath(input.mouthInterior, "mouthInterior"),
          );
    const pass = async (backgroundSeeds: Point[]) => {
      const pic = await matteIllustration(source, { backgroundSeeds });
      const { classifier, reads } = classifierFor(pic, lm);
      const classes = classifyPicture(pic, classifier, PAINT_ALPHA);
      const labels = labelIllustration(pic, lm, classes);
      return { pic, classifier, reads, labels };
    };
    let first = await pass(lm.backgroundSeeds);
    // Gaps between strands are keyed without a seed: one more pass with a
    // point inside each, not a loop (a gap a key opens cannot ring another).
    const keyed =
      first.pic.background === "flat"
        ? hairRungPockets(first.pic, first.labels, lm.paintSeeds, source)
        : [];
    if (keyed.length > 0) first = await pass([...lm.backgroundSeeds, ...keyed]);
    const { pic, classifier, reads, labels } = first;
    const ctx: CutContext = {
      pic,
      source,
      lm,
      classifier,
      reads,
      labels,
      keyed,
    };

    const built = buildLayers(ctx, lips !== undefined);
    const lipLayers = lips
      ? await lipSetLayers(ctx, lips)
      : new Map<string, LayerPaint>();
    const checks: CutCheck[] = [
      stackCheck(ctx, stackOrder(built)),
      seedsCheck(ctx),
      ...built.features.checks,
      ...built.fills.map((f) => fillCheck(pic, f)),
      frontHairWidthCheck(ctx, built),
      ...(["L", "R"] as const)
        .filter((side) => lm.sideHair?.[side])
        .map((side) => sideHairCheck(ctx, built, side)),
      pocketsCheck(ctx),
    ];

    // Encode everything before writing anything.
    const png = (layer: LayerPaint) =>
      sharp(encodeLayer(layer), {
        raw: { width: pic.width, height: pic.height, channels: 4 },
      })
        .png()
        .toBuffer();
    const rgbPng = (img: Image) =>
      sharp(img.rgb, {
        raw: { width: img.width, height: img.height, channels: 3 },
      })
        .png()
        .toBuffer();
    const roleFiles: { role: string; layer: LayerPaint; data: Buffer }[] = [];
    for (const role of ORDER) {
      const layer = built.roles.get(role) ?? lipLayers.get(role);
      if (layer) roleFiles.push({ role, layer, data: await png(layer) });
    }
    const partFiles = await Promise.all(
      built.parts.map(async (p) => ({ ...p, data: await png(p.paint) })),
    );
    const previews = {
      labels: await rgbPng(labelsPreview(ctx, built)),
      landmarks: await rgbPng(landmarksPreview(ctx)),
    };

    let customDir = path.join(outDir, "custom");
    if (partFiles.length > 0) {
      try {
        fs.mkdirSync(customDir, { recursive: true });
      } catch (e) {
        throw new AutoRigInputError(
          `write: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      // Before any layer is written: a `custom` symlink out of the output
      // dir would carry the writes with it.
      customDir = confineToWorkingDirectory(
        outDir,
        customDir,
        "custom parts dir",
        customDir,
      );
    }
    const labelsPath = path.join(outDir, "preview-labels.png");
    const landmarksPath = path.join(outDir, "preview-landmarks.png");
    let layers: CutLayer[];
    let customParts: CutCustomPart[];
    try {
      layers = roleFiles.map(({ role, layer, data }) => {
        const file = path.join(outDir, `${role}.png`);
        writeFileAtomic(file, data);
        return { role, path: file, ...coverage(pic, layer) };
      });
      customParts = partFiles.map(({ id, tie, paint, data }) => {
        const file = path.join(customDir, `${id}.png`);
        writeFileAtomic(file, data);
        return { id, path: file, tie, ...coverage(pic, paint) };
      });
      writeFileAtomic(labelsPath, previews.labels);
      writeFileAtomic(landmarksPath, previews.landmarks);
    } catch (e) {
      // Past the inputs' checks, unlike a refusal: the dir is a mix of this
      // cut's files written so far and an earlier cut's other files.
      if (!(e instanceof AutoRigInputError)) throw e;
      throw new AutoRigInputError(
        `${e.message}; the cut stopped part-way: in ${outDir} the files it wrote before that one replace an earlier cut's of the same name, and the rest of the earlier cut's files (any role this cut would have removed too) are still there, so the dir is a mix of the two until the cut is run again`,
      );
    }
    // An earlier cut into the same dir may have written a role this one does
    // not (the drawn `mouth` before a lip set, or the set before the drawn
    // mouth): left behind it would be measured and rigged with these, and
    // the rig refuses the mouth beside the lip set. Removed only once every
    // file of this cut is written, so a failed write removes nothing (the
    // dir is then a mix, which the message says). Only the fixed role names,
    // under the confined outDir, are ever removed.
    for (const role of ORDER) {
      if (roleFiles.some((f) => f.role === role)) continue;
      fs.rmSync(path.join(outDir, `${role}.png`), { force: true });
    }

    let measure: CutMeasure;
    try {
      const report = await measureDir(outDir, undefined, { inPlace: true });
      measure = {
        warnings: report.warnings,
        ...(report.lips && { lips: report.lips }),
      };
    } catch (e) {
      // The layers are written: a dir the measure refuses (a stray PNG it
      // cannot decode, too many files) is reported, not a refusal.
      if (!(e instanceof AutoRigInputError)) throw e;
      measure = {
        warnings: [`the written layers could not be measured: ${e.message}`],
      };
    }

    return {
      ok: true,
      outputDir: outDir,
      canvas: { width: pic.width, height: pic.height },
      layers,
      customParts,
      previews: { labels: labelsPath, landmarks: landmarksPath },
      checks,
      measure,
      passed: checks.every((c) => c.pass || c.level === "warn"),
    };
  } catch (e) {
    if (e instanceof AutoRigInputError) return { ok: false, error: e.message };
    throw e;
  }
}

/** A layer's painted box and pixel count, as written (alpha over 0 at 8
 *  bits). */
function coverage(
  size: CanvasSize,
  layer: LayerPaint,
): { box: Box | null; pixels: number } {
  const on = Uint8Array.from(layer.alpha, (a) =>
    Math.round(a * 255) > 0 ? 1 : 0,
  );
  return { box: maskBox(size, on), pixels: count(on) };
}

/**
 * A cut as the tool's text: the written files one per line, a `CHECK` line
 * per check (`WARN` a warn-level check that did not pass, `FAIL` a
 * fail-level one), the `MEASURE:` lines, and last `CUT pass` or `CUT FAIL:`
 * with the failed fail-level checks.
 */
export function formatCutReport(
  r: Extract<CutLayersFromIllustrationResult, { ok: true }>,
): string {
  const show = (v: number | null) => (v === null ? "none" : `${v}`);
  const checks = r.checks.map((c) => {
    const verdict = c.pass ? "pass" : c.level === "warn" ? "WARN" : "FAIL";
    const apart = c.apart
      ? `; the mouth's box, counted apart: ${pct(c.apart.mouthBox)} of it off`
      : "";
    return `CHECK ${c.id}: ${verdict} ${show(c.value)} (limit ${show(c.limit)}) ${c.hint}${apart}`;
  });
  const measure = [
    ...(r.measure.lips ? [formatLipFacts(r.measure.lips)] : []),
    ...(r.measure.warnings.length > 0
      ? r.measure.warnings
      : ["all geometry checks passed"]),
  ].map((line) => `MEASURE: ${line}`);
  const failed = r.checks
    .filter((c) => !c.pass && c.level === "fail")
    .map((c) => c.id);
  return [
    ...r.layers.map((l) => l.path),
    ...r.customParts.map((p) => p.path),
    r.previews.labels,
    r.previews.landmarks,
    ...checks,
    ...measure,
    failed.length === 0 ? "CUT pass" : `CUT FAIL: ${failed.join(", ")}`,
  ].join("\n");
}
