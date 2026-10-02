/**
 * A synthetic character as `createLayerSetMeasurer` would hand it to the
 * generator: layer boxes on a 1000 × 1000 canvas in the proportions of a
 * composed anime bust (egg-shaped face with ears and a neck, eyes with irises
 * and lashes, brows, a shaded nose, closed and open mouths, bangs framing the
 * face with side strands, back hair, a torso), plus the head edges and iris
 * strands the measurer derives. No pixels: the generator reads geometry only.
 */
import type {
  GenerateOptions,
  IrisStrand,
  LayerInput,
} from "../../src/auto-rig/types";

export const CANVAS = { width: 1000, height: 1000 };

type Box = { x: number; y: number; w: number; h: number };

function layer(
  role: string,
  bbox: Box,
  extra: Partial<LayerInput> = {},
): LayerInput {
  return {
    role,
    fileName: `${role}.png`,
    canvasW: CANVAS.width,
    canvasH: CANVAS.height,
    bbox,
    cropW: bbox.w,
    cropH: bbox.h,
    ...extra,
  };
}

/** The face plate's painted half-width per crop row: a skull widening to the
 *  ears at mid-height, a jaw tapering to a neck, and the neck's cut edge. */
function faceRows(h: number): number[] {
  const rows: number[] = [];
  for (let r = 0; r < h; r++) {
    const t = r / h;
    let w: number;
    if (t < 0.5) w = 110 + 88 * Math.sin((t / 0.5) * (Math.PI / 2));
    else if (t < 0.8) w = 198 - (198 - 78) * ((t - 0.5) / 0.3);
    else w = 78;
    if (r >= h - 4) w = 50;
    rows.push(Math.round(w * 2) / 2);
  }
  return rows;
}

export interface CharacterOptions {
  nose?: boolean;
  hair?: boolean;
  /** Bangs as a fringe spanning the face instead of side strands. */
  fringe?: boolean;
  /** Bangs cut short: a fringe over the forehead only, the back hair
   *  drawing the head's outline. */
  shortFringe?: boolean;
  /** The optional eye and cheek roles: pupils, highlights, blush. */
  extras?: boolean;
  /** A back hair drawn wide behind the bangs — ±310 at the eye row, the
   *  silhouette — and both hair layers carrying their opaque runs, banded
   *  as `FULL_BACK_ROWS` sets out. */
  fullBack?: boolean;
}

/**
 * The `fullBack` hair's bands, canvas rows `[from, to)` (the axis is at
 * column 500.5; the bangs' side locks' outer edges at columns 238 and 762,
 * model ∓262):
 * - `crown`: the back solid ±310 from row 0, above the bangs' top (row 10)
 *   in every column; the bangs a dome widening to ±262;
 * - `temple`: the back's outer end 5 px inside the bangs' edge;
 * - `solid`: from the brows down, the eye row (433.5) among them: the back
 *   one solid run ±310 behind the locks (as it is below the bangs' crop);
 * - `gap`: as on bob's row 366, a 3 px sliver of back 2 px outside the
 *   bangs' edge, then nothing until 8 px inside it;
 * - `stroke`: as on the hero's row 610, the back solid from inside the
 *   bangs' edge to 20 px past it, then empty for 30 px, then a 4 px stroke.
 */
const FULL_BACK_ROWS = {
  crown: [0, 210],
  temple: [210, 330],
  solid: [330, 630],
  gap: [630, 730],
  stroke: [730, 970],
} as const;

/** The `fullBack` layers' `rowRuns`, one entry per crop row: the bangs'
 *  crop holds canvas rows 10–969, the back's rows 0–999. */
function fullBackRuns(): { front: number[][]; back: number[][] } {
  const { temple, gap, stroke } = FULL_BACK_ROWS;
  const front: number[][] = [];
  const back: number[][] = [];
  for (let k = 0; k < 1000; k++) {
    // The solid band's, unless another band's.
    let f = [238, 347, 654, 762];
    let b = [190, 810];
    if (k < temple[0]) {
      const w = Math.round(Math.min(262, 200 + ((k - 10) * 62) / 80));
      f = [500 - w, 500 + w];
    } else if (k < temple[1]) {
      f = [238, 762];
      b = [243, 757];
    } else if (k >= gap[0] && k < gap[1]) {
      b = [233, 236, 246, 754, 764, 767];
    } else if (k >= stroke[0] && k < stroke[1]) {
      b = [184, 188, 218, 782, 812, 816];
    }
    if (k >= 10 && k < 970) front.push(f);
    back.push(b);
  }
  return { front, back };
}

export function character(opts: CharacterOptions = {}): {
  layers: LayerInput[];
  options: GenerateOptions;
} {
  const {
    nose = true,
    hair = true,
    fringe = false,
    shortFringe = false,
    extras = false,
    fullBack = false,
  } = opts;
  const face = { x: 300, y: 200, w: 401, h: 560 };
  const layers: LayerInput[] = [
    layer("body", { x: 90, y: 770, w: 820, h: 230 }),
    layer("face", face, { rowHalfWidths: faceRows(face.h) }),
    layer("eye_R", { x: 330, y: 400, w: 130, h: 66 }),
    layer("eye_L", { x: 541, y: 400, w: 130, h: 66 }),
    layer("iris_R", { x: 358, y: 396, w: 74, h: 74 }),
    layer("iris_L", { x: 569, y: 396, w: 74, h: 74 }),
    layer("lash_R", { x: 330, y: 400, w: 130, h: 35 }),
    layer("lash_L", { x: 541, y: 400, w: 130, h: 35 }),
    layer("brow_R", { x: 340, y: 350, w: 137, h: 23 }),
    layer("brow_L", { x: 524, y: 350, w: 137, h: 23 }),
    layer("mouth", { x: 465, y: 590, w: 70, h: 21 }),
    layer("mouth_open", { x: 465, y: 588, w: 70, h: 29 }),
  ];
  if (nose) {
    layers.push(
      layer(
        "nose",
        { x: 473, y: 500, w: 54, h: 83 },
        { denseCore: { x: 480, y: 512, w: 39, h: 63 } },
      ),
    );
  }
  if (extras) {
    layers.push(
      layer("pupil_R", { x: 382, y: 420, w: 26, h: 26 }),
      layer("pupil_L", { x: 593, y: 420, w: 26, h: 26 }),
      layer("highlight_R", { x: 400, y: 410, w: 14, h: 14 }),
      layer("highlight_L", { x: 611, y: 410, w: 14, h: 14 }),
      layer("blush_R", { x: 330, y: 500, w: 80, h: 40 }),
      layer("blush_L", { x: 591, y: 500, w: 80, h: 40 }),
    );
  }
  if (hair && shortFringe) {
    layers.push(
      layer("hair_back", { x: 110, y: 20, w: 780, h: 980 }),
      layer("hair_front", { x: 380, y: 150, w: 241, h: 180 }),
    );
    // The back hair draws the outline at the eye row; the fringe stops
    // above the eyes, so no strand crosses an iris's row.
    return {
      layers,
      options: {
        turnTargets: { headHalfWidth: 230 },
        headEdges: {
          left: [
            { role: "hair_back", x: -230 },
            { role: "face", x: -200 },
          ],
          right: [
            { role: "hair_back", x: 229 },
            { role: "face", x: 200 },
          ],
        },
      },
    };
  }
  if (hair) {
    const runs = fullBack ? fullBackRuns() : undefined;
    layers.push(
      runs
        ? layer(
            "hair_back",
            { x: 90, y: 0, w: 820, h: 1000 },
            { rowRuns: runs.back },
          )
        : layer("hair_back", { x: 110, y: 20, w: 780, h: 980 }),
      layer(
        "hair_front",
        { x: 170, y: 10, w: 660, h: 960 },
        runs ? { rowRuns: runs.front } : {},
      ),
    );
  }
  const options: GenerateOptions = {};
  if (hair) {
    // The bangs draw the head's outline at the eye row, ±262 about the face —
    // unless the full back hair, at ±310, draws it.
    const back = fullBack ? 310 : 230;
    options.turnTargets = { headHalfWidth: fullBack ? 310 : 262 };
    options.headEdges = {
      left: [
        { role: "hair_front", x: -262 },
        { role: "hair_back", x: -back },
        { role: "face", x: -200 },
      ],
      right: [
        { role: "hair_front", x: 261 },
        { role: "hair_back", x: back - 1 },
        { role: "face", x: 200 },
      ],
    };
    const y = 500 - 433.5;
    const left: IrisStrand = fringe
      ? { y, irisOuter: -142, irisInner: -68, runOuter: -240, runFace: null }
      : { y, irisOuter: -142, irisInner: -68, runOuter: -226, runFace: -153 };
    const right: IrisStrand = fringe
      ? { y, irisOuter: 143, irisInner: 69, runOuter: 241, runFace: null }
      : { y, irisOuter: 143, irisInner: 69, runOuter: 227, runFace: 154 };
    options.strandEdges = { left, right };
  }
  return { layers, options };
}
