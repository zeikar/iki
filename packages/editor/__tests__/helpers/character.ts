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
    layers.push(
      layer("hair_back", { x: 110, y: 20, w: 780, h: 980 }),
      layer("hair_front", { x: 170, y: 10, w: 660, h: 960 }),
    );
  }
  const options: GenerateOptions = {};
  if (hair) {
    // The bangs draw the head's outline at the eye row: ±262 about the face.
    options.turnTargets = { headHalfWidth: 262 };
    options.headEdges = {
      left: [
        { role: "hair_front", x: -262 },
        { role: "hair_back", x: -230 },
        { role: "face", x: -200 },
      ],
      right: [
        { role: "hair_front", x: 261 },
        { role: "hair_back", x: 229 },
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
