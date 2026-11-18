/**
 * `cutLayersFromIllustration`: one finished character picture cut, in
 * place, into role layers on the canvas: the face, the front and back hair,
 * the body and each custom part (a tail, a ponytail) as its own file. Every
 * visible pixel is copied from the picture; what a layer hides when the rig
 * moves it (the forehead under the bangs, the hair behind the face, the
 * neck behind the chin) is filled in from the paint around it.
 *
 * Driven by landmarks an agent reads off `view_illustration_grid`
 * (`illustration-landmarks.ts`), and checked: the report says, in numbers,
 * whether the layers stack back into the picture, whether each seed and
 * sample sits on the paint it should, how much of each fill was made up far
 * from any paint, and whether the front hair is wider than the face.
 *
 * Frame: canvas px, origin top-left, x right, y down, CANVAS wide; every
 * layer is a canvas-sized PNG with the paint where the picture has it.
 */

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { ORDER } from "./compose";
import {
  and,
  backdropColoured,
  boxMask,
  count,
  dilate,
  erode,
  matteIllustration,
  or,
  pixelIndex,
  polygonMask,
  pushPull,
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
import { drawLandmarks, pictureView } from "./illustration-grid";
import {
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
  resolveOutputDir,
  writeFileAtomic,
} from "./limits";

export interface CutLayersFromIllustrationInput {
  /** The finished picture (PNG, JPEG or WebP), resolved against cwd. */
  imagePath: string;
  /** Checked by `validateLandmarks` against the picture's canvas. */
  landmarks: unknown;
  /** An existing directory under the working directory. */
  outputDir: string;
  /** Not supported yet: a generated lip set placed on the drawn mouth. */
  mouthKeyed?: string;
  /** Not supported yet: see `mouthKeyed`. */
  mouthInterior?: string;
}

/** One number an agent acts on. */
export interface CutCheck {
  id: string;
  /** `fail`: the cut is wrong and `passed` is false while it fails.
   *  `warn`: worth a look; `passed` ignores it. */
  level: "fail" | "warn";
  pass: boolean;
  /** Null when there is nothing to measure (no face on the eye row). */
  value: number | null;
  /** Null for a number reported without a limit. */
  limit: number | null;
  /** Which landmark to move, and which way, when the check fails. */
  hint: string;
  /** Measured apart from `value`: on `stack`, the share of the mouth box's
   *  own pixels off (the mouth is replaced later, so it does not count). */
  apart?: { mouthBox: number };
  /** On `pockets`: the hair-rung pockets keyed as backdrop on their own, a
   *  point inside each. */
  keyed?: Point[];
}

export interface CutLayer {
  role: string;
  path: string;
  /** `[x0, y0, x1, y1]` of the painted pixels, both corners inside; null
   *  for a layer with none. */
  box: Box | null;
  pixels: number;
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
      /** No fail-level check failed. */
      passed: boolean;
    }
  | { ok: false; error: string };

/** A layer in memory: the paint's colour and its coverage per pixel. Its
 *  `rgb` is the picture's own, shared, until a fill writes to it. */
export interface LayerPaint {
  rgb: Float32Array;
  alpha: Float32Array;
}

/** Everything the cut works from, for the stages that build layers. */
export interface CutContext {
  pic: Illustration;
  source: CanvasPicture;
  lm: IllustrationLandmarks;
  classifier: ColourClassifier;
  reads: SampleReads;
  labels: IllustrationLabels;
  /** Pockets keyed as backdrop on their own, a point inside each. */
  keyed: Point[];
}

/** A fill's sources stay this far inside their paint: a pixel beside a line
 *  is half line, and its colour would streak the fill. */
const SOURCE_INSET = 2;
/** Skin carried under strands that cross the face's edge, px past it: what
 *  shows when the strand swings off the face. Too little shows a gap. */
const FACE_MARGIN = 10;
/** Hair and custom parts run on under the body's edge this far, px: what
 *  shows when the body breathes or the head turns. Too little shows a gap
 *  at the shoulder. */
const UNDER_BODY = 16;
/** The head's hair runs on under each custom part's root this far, px: what
 *  shows when the part swings. Too little shows a hole at the root. */
const UNDER_PART = 14;
/** The neck's own paint starts this many rows under the jaw's lowest face
 *  row: the rows above are the line and its soft edge, and smearing them
 *  would paint the neck the line's colour. */
const NECK_FROM = 4;
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

const fmt = (v: number, digits = 3) => Number(v.toFixed(digits));
const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

// ---- fills and layers ----

/** Skin a fill may read from: the face's flood, skin by colour, solid, off
 *  `holes` (the features, once they leave the face) and inset from lines. */
export function skinSources(ctx: CutContext, holes: Mask | null): Mask {
  const { labels } = ctx;
  const k = labels.skin.map((v, i) =>
    v && labels.solid[i] && labels.classes[i] === SKIN && !holes?.[i] ? 1 : 0,
  );
  return erode(ctx.pic, k, SOURCE_INSET);
}

/** Hair a fill may read from inside `mask`: hair by colour (no ink), solid,
 *  inset from lines. */
export function hairSources(ctx: CutContext, mask: Mask): Mask {
  const { labels } = ctx;
  const k = mask.map((v, i) =>
    v && labels.solid[i] && labels.classes[i] === HAIR ? 1 : 0,
  );
  return erode(ctx.pic, k, SOURCE_INSET);
}

/** The picture's colours with every pixel off `sources` filled from them. */
export function fillFrom(pic: Illustration, sources: Mask): Float32Array {
  return pushPull(pic, pic.rgb, sources);
}

/** A layer of the picture's own paint over `mask`. */
export function paintOf(pic: Illustration, mask: Mask): LayerPaint {
  const alpha = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) if (mask[i]) alpha[i] = pic.alpha[i];
  return { rgb: pic.rgb, alpha };
}

/** Lay `filled` colours, opaque, over `region` where the layer has no paint
 *  of its own; `region` must lie under opaque paint of a layer drawn above.
 *  Returns the pixels filled. */
function fillUnder(
  pic: Illustration,
  layer: LayerPaint,
  region: Mask,
  filled: Float32Array | ((i: number) => number),
): Mask {
  const done = new Uint8Array(region.length);
  for (let i = 0; i < region.length; i++) {
    if (!region[i] || layer.alpha[i] > 0) continue;
    if (layer.rgb === pic.rgb) layer.rgb = new Float32Array(pic.rgb);
    const from = typeof filled === "function" ? filled(i) : i;
    const src = typeof filled === "function" ? pic.rgb : filled;
    for (let c = 0; c < 3; c++) layer.rgb[i * 3 + c] = src[from * 3 + c];
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
}

/** The face: its skin as drawn; under the bangs inside the skull, and a
 *  margin under strands that cross its edge, skin filled from the skin
 *  around. */
function faceLayer(ctx: CutContext, opaque: Mask, fills: FillRegion[]) {
  const { pic, labels } = ctx;
  const sources = skinSources(ctx, null);
  const face = paintOf(pic, labels.face);
  const under = and(
    or(labels.skullArea, dilate(pic, labels.face, FACE_MARGIN)),
    and(labels.hairFront, opaque),
  );
  fills.push({
    id: "face.forehead",
    region: fillUnder(pic, face, under, fillFrom(pic, sources)),
    sources,
    limit: FILL_LIMIT,
    hint: "the skin under the bangs is made up far from any skin: pull landmarks.skull in to the head's outline, and put a landmarks.skinSeeds point on any forehead skin between strands the face's flood missed",
  });
  return face;
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

/** The body: as drawn, and the neck carried up behind the chin to neckTopY
 *  by smearing each neck column up from under the jaw's line, under the
 *  face and the front hair only (the back hair and the custom parts are
 *  drawn under the body). */
function bodyLayer(ctx: CutContext, opaque: Mask, fills: FillRegion[]) {
  const { pic, lm, labels } = ctx;
  const { width, height } = pic;
  const body = paintOf(pic, labels.body);
  const neck = new Uint8Array(width * height);
  const from = new Int32Array(width * height).fill(-1);
  for (let x = 0; x < width; x++) {
    let jaw = -1;
    for (let y = height - 1; y >= 0 && jaw < 0; y--) {
      if (labels.label[y * width + x] === LABEL_FACE) jaw = y;
    }
    if (jaw < 0 || jaw + NECK_FROM >= height) continue;
    const s = (jaw + NECK_FROM) * width + x;
    if (
      labels.label[s] !== LABEL_BODY ||
      labels.label[(jaw + 1) * width + x] !== LABEL_BODY
    ) {
      continue;
    }
    for (let y = lm.neckTopY; y <= jaw; y++) {
      const i = y * width + x;
      if (!opaque[i] || !(labels.face[i] || labels.hairFront[i])) continue;
      neck[i] = 1;
      from[i] = s;
    }
  }
  fills.push({
    id: "body.neck",
    region: fillUnder(pic, body, neck, (i) => from[i]),
    sources: and(labels.body, labels.solid),
    limit: null,
    hint: "the neck behind the chin, carried up to landmarks.neckTopY by construction",
  });
  return body;
}

/** The face, the hair, the body and the custom parts, with their fills. */
function buildLayers(ctx: CutContext): BuiltLayers {
  const { pic, labels } = ctx;
  const fills: FillRegion[] = [];
  const opaque = Uint8Array.from(pic.alpha, (a) => (a >= OPAQUE_ALPHA ? 1 : 0));
  const face = faceLayer(ctx, opaque, fills);
  const { hairBack, parts } = hairLayers(ctx, opaque, fills);
  const body = bodyLayer(ctx, opaque, fills);
  return {
    roles: new Map([
      ["hair_back", hairBack],
      ["body", body],
      ["face", face],
      ["hair_front", paintOf(pic, labels.hairFront)],
    ]),
    parts,
    fills,
  };
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
  /** A point well inside it (2 px or more from its edge when it has one). */
  at: Point;
  /** Whether `at` is 2 px or more inside. */
  deep: boolean;
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
): Pocket[] {
  const { width, height } = pic;
  const n = width * height;
  const candidate = and(
    backdropColoured(pic),
    labels.label.map((l) => (l === LABEL_FACE ? 0 : 1)),
  );
  const owner = new Int32Array(n).fill(-1);
  const deep = erode(pic, candidate, 2);
  const found: Omit<Pocket, "hairShare">[] = [];
  for (let s = 0; s < n; s++) {
    if (!candidate[s] || owner[s] !== -1) continue;
    const queue = [s];
    owner[s] = -2;
    let at = s;
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q];
      if (deep[i] && !deep[at]) at = i;
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
    for (const i of queue) owner[i] = found.length;
    found.push({
      size: queue.length,
      at: [at % width, Math.floor(at / width)],
      deep: deep[at] === 1,
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
): Point[] {
  const paint = new Set(paintSeeds.map((p) => pixelIndex(pic, p)));
  const cap = POCKET_KEY_SHARE * pic.width * pic.height;
  return findPockets(pic, labels)
    .filter(
      (p) =>
        p.deep &&
        p.size <= cap &&
        p.hairShare >= POCKET_HAIR_SHARE &&
        !p.pixels.some((i) => paint.has(i)),
    )
    .map((p) => p.at);
}

function pocketsCheck(ctx: CutContext): CutCheck {
  const pockets = findPockets(ctx.pic, ctx.labels);
  const show = (p: Point) => `[${p[0]}, ${p[1]}]`;
  const named = pockets
    .slice(0, POCKETS_NAMED)
    .map((p) => `${show(p.at)} (${p.size} px)`);
  const parts: string[] = [];
  // An automatic key may have taken paint: it always warns, first, so the
  // keyed points are looked at on preview-labels.png.
  if (ctx.keyed.length > 0) {
    parts.push(
      `keyed as backdrop on their own, the hair ringing them: ${ctx.keyed.map(show).join(", ")}; check each on preview-labels.png, and if one is paint (an ornament, a pale panel), add a point inside it to landmarks.paintSeeds`,
    );
  }
  if (pockets.length > 0) {
    parts.push(
      `backdrop-coloured paint the border flood cannot reach, now cut into a layer: if it is backdrop showing through (a gap between the neck and a tail, under an arm), add these to landmarks.backgroundSeeds: ${named.join(", ")}`,
    );
  }
  return {
    id: "pockets",
    level: "warn",
    pass: pockets.length === 0 && ctx.keyed.length === 0,
    value: pockets.length,
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

// ---- previews ----

type Image = ReturnType<typeof pictureView>;
type RGB = [number, number, number];
const LABEL_COLOURS: Record<string, RGB> = {
  face: [255, 190, 140],
  hair_front: [235, 50, 60],
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

function labelsPreview(ctx: CutContext): Image {
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
  labels.parts.forEach(({ mask }, k) =>
    tint(mask, PART_COLOURS[k % PART_COLOURS.length]),
  );
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
 * writes nothing.
 */
export async function cutLayersFromIllustration(
  input: CutLayersFromIllustrationInput,
): Promise<CutLayersFromIllustrationResult> {
  try {
    // First, so a refused target costs no decode.
    const outDir = resolveOutputDir(input.outputDir);
    if (input.mouthKeyed !== undefined || input.mouthInterior !== undefined) {
      throw new AutoRigInputError(
        "mouthKeyed and mouthInterior are not supported yet: leave them out, and the drawn mouth stays on the face",
      );
    }
    const source = await readPictureOnCanvas(input.imagePath);
    const lm = validateLandmarks(input.landmarks, source);
    const pass = (backgroundSeeds: Point[]) => {
      const pic = matteIllustration(source, { backgroundSeeds });
      const { classifier, reads } = classifierFor(pic, lm);
      const classes = classifyPicture(pic, classifier, PAINT_ALPHA);
      const labels = labelIllustration(pic, lm, classes);
      return { pic, classifier, reads, labels };
    };
    let first = pass(lm.backgroundSeeds);
    // Gaps between strands are keyed without a seed: one more pass with a
    // point inside each, not a loop (a gap a key opens cannot ring another).
    const keyed =
      first.pic.background === "flat"
        ? hairRungPockets(first.pic, first.labels, lm.paintSeeds)
        : [];
    if (keyed.length > 0) first = pass([...lm.backgroundSeeds, ...keyed]);
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

    const built = buildLayers(ctx);
    const checks: CutCheck[] = [
      stackCheck(ctx, stackOrder(built)),
      seedsCheck(ctx),
      ...built.fills.map((f) => fillCheck(pic, f)),
      frontHairWidthCheck(ctx, built),
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
      const layer = built.roles.get(role);
      if (layer) roleFiles.push({ role, layer, data: await png(layer) });
    }
    const partFiles = await Promise.all(
      built.parts.map(async (p) => ({ ...p, data: await png(p.paint) })),
    );
    const previews = {
      labels: await rgbPng(labelsPreview(ctx)),
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
    const layers: CutLayer[] = roleFiles.map(({ role, layer, data }) => {
      const file = path.join(outDir, `${role}.png`);
      writeFileAtomic(file, data);
      return { role, path: file, ...coverage(pic, layer) };
    });
    const customParts: CutCustomPart[] = partFiles.map(
      ({ id, tie, paint, data }) => {
        const file = path.join(customDir, `${id}.png`);
        writeFileAtomic(file, data);
        return { id, path: file, tie, ...coverage(pic, paint) };
      },
    );
    const labelsPath = path.join(outDir, "preview-labels.png");
    const landmarksPath = path.join(outDir, "preview-landmarks.png");
    writeFileAtomic(labelsPath, previews.labels);
    writeFileAtomic(landmarksPath, previews.landmarks);

    return {
      ok: true,
      outputDir: outDir,
      canvas: { width: pic.width, height: pic.height },
      layers,
      customParts,
      previews: { labels: labelsPath, landmarks: landmarksPath },
      checks,
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
