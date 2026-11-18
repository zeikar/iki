/**
 * What the stages of an in-place cut share: the context they cut from, a
 * layer in memory, a check, and the fills every stage builds layers with.
 */

import {
  erode,
  pushPull,
  type CanvasPicture,
  type Illustration,
  type Mask,
  type Point,
} from "./illustration";
import {
  HAIR,
  SKIN,
  type ColourClassifier,
  type SampleReads,
} from "./illustration-colour";
import type { IllustrationLabels } from "./illustration-labels";
import type { IllustrationLandmarks } from "./illustration-landmarks";

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
export const SOURCE_INSET = 2;

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
