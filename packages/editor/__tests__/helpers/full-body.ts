/**
 * `character()`'s bust standing on a full body: every head layer keeps its
 * box on a canvas extended down by `extend` px, and the torso layer becomes a
 * figure down to the feet whose `rowRuns` split into two legs at the crotch.
 * No pixels: the generator reads geometry only.
 */
import type { GenerateOptions, LayerInput } from "../../src/auto-rig/types";
import { CANVAS, character } from "./character";

/** The body's crop, canvas px. */
export const BODY_BOX = { x: 300, y: 740, w: 401, h: 1640 };
/** The torso's run, canvas columns `[start, end)`, on rows BODY_BOX.y to
 *  CROTCH_ROW − 1. */
export const TORSO_RUNS = [300, 701];
/** The first row the legs part on: 0.46 of the body's height down, inside
 *  `HIP_BAND`. */
export const CROTCH_ROW = 1500;
/** The two legs' runs, canvas columns, on rows CROTCH_ROW to FEET_ROW. */
export const LEG_RUNS = [320, 490, 511, 681];
/** The body's last row. */
export const FEET_ROW = BODY_BOX.y + BODY_BOX.h - 1;

export function fullBody({ extend = 1600 }: { extend?: number } = {}): {
  layers: LayerInput[];
  options: GenerateOptions;
  canvas: { width: number; height: number };
} {
  const canvas = { width: CANVAS.width, height: CANVAS.height + extend };
  const bust = character();
  const head = bust.layers
    .filter((l) => l.role !== "body")
    .map((l) => ({ ...l, canvasW: canvas.width, canvasH: canvas.height }));
  const body: LayerInput = {
    role: "body",
    fileName: "body.png",
    canvasW: canvas.width,
    canvasH: canvas.height,
    bbox: { ...BODY_BOX },
    cropW: BODY_BOX.w,
    cropH: BODY_BOX.h,
    rowRuns: Array.from({ length: BODY_BOX.h }, (_, k) =>
      BODY_BOX.y + k < CROTCH_ROW ? [...TORSO_RUNS] : [...LEG_RUNS],
    ),
  };
  // Model y is centred on the canvas (`layout.ts`), so a box that keeps its
  // canvas rows moves up by half the extension.
  const { left, right } = bust.options.strandEdges!;
  const options: GenerateOptions = {
    ...bust.options,
    strandEdges: {
      left: { ...left!, y: left!.y + extend / 2 },
      right: { ...right!, y: right!.y + extend / 2 },
    },
  };
  return { layers: [body, ...head], options, canvas };
}
