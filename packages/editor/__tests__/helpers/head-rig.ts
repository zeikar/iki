/**
 * What the head's auto-rig tests share: readers of a part's landing less the
 * body's carry of the head, the fixture rig, and its measures.
 */

import { StandardParameter as P, type IkiModel } from "@ikijs/format";
import {
  generateIkiFromLayerSet,
  type LayerInput,
  type TurnSolveReport,
  type TurnTargets,
} from "@ikijs/editor";
import { buildHeadFrame } from "../../src/auto-rig/head";
import { type GenerateOptions } from "../../src/auto-rig/types";
import { CANVAS, character, type CharacterOptions } from "./character";
import { type ParamValues } from "./render-oracle";
import * as oracle from "./render-oracle";

// The bust has a body, so its head hangs from the body warp, which carries
// the chin's pivot on the follow of the turn and the tilt (and the breath).
// These tests read the head's own motion; the carry is tested in
// `auto-rig-body.test.ts`. So the readers below take every landing of a part
// that rides the head less the body's carry of the head's pivot at that
// pose, and read every other part raw. The head's world with a body is
// T(carry)·its world without one for every head part under AngleX/AngleY,
// and for every head part but the neck island under AngleZ (the neck rides
// the torso, which rolls about the hips): a test reading the neck under a
// roll, or the breath, reads the raw `oracle`.

/** The body warp's landing of `headDeformer`'s pivot less the pivot; none
 *  for a head that hangs from nothing. */
function headCarry(model: IkiModel, params: ParamValues): [number, number] {
  const head = model.deformers?.find((d) => d.id === "headDeformer");
  if (head === undefined || head.kind === "warp" || head.parent === undefined) {
    return [0, 0];
  }
  const { x, y } = head.pivot;
  const at = oracle.warpPointAt(model, head.parent, x, y, params);
  return [at.x - x, at.y - y];
}

/** Whether a part rides the head: on `headDeformer`, or on a warp hung from
 *  it. */
function ridesHead(model: IkiModel, partId: string): boolean {
  const id = model.parts.find((p) => p.id === partId)?.deformer;
  if (id === "headDeformer") return true;
  return model.deformers?.find((d) => d.id === id)?.parent === "headDeformer";
}

/** The carry to take off a part's landings at `params`. */
const carryOf = (
  model: IkiModel,
  partId: string,
  params: ParamValues,
): [number, number] =>
  ridesHead(model, partId) ? headCarry(model, params) : [0, 0];

export function landVertices(
  model: IkiModel,
  partId: string,
  params: ParamValues = {},
): Float32Array {
  const v = oracle.landVertices(model, partId, params);
  const [dx, dy] = carryOf(model, partId, params);
  return v.map((c, i) => c - (i % 2 === 0 ? dx : dy));
}

export function landedXAt(
  model: IkiModel,
  partId: string,
  restX: number,
  restY: number,
  params: ParamValues = {},
): number {
  return (
    oracle.landedXAt(model, partId, restX, restY, params) -
    carryOf(model, partId, params)[0]
  );
}

export function landedYAt(
  model: IkiModel,
  partId: string,
  restX: number,
  restY: number,
  params: ParamValues = {},
): number {
  return (
    oracle.landedYAt(model, partId, restX, restY, params) -
    carryOf(model, partId, params)[1]
  );
}

export function landedCentroidX(
  model: IkiModel,
  partId: string,
  params: ParamValues = {},
): number {
  return (
    oracle.landedCentroidX(model, partId, params) -
    carryOf(model, partId, params)[0]
  );
}

export function landerFor(
  model: IkiModel,
  partId: string,
  params: ParamValues = {},
): (restX: number, restY: number) => { x: number; y: number } {
  const land = oracle.landerFor(model, partId, params);
  const [dx, dy] = carryOf(model, partId, params);
  return (restX, restY) => {
    const { x, y } = land(restX, restY);
    return { x: x - dx, y: y - dy };
  };
}

export function rig(
  opts: CharacterOptions = {},
  targets: TurnTargets = {},
  {
    rigPlan,
    drop = () => false,
  }: {
    rigPlan?: GenerateOptions["rigPlan"];
    /** The roles whose `rowRuns` to leave out. */
    drop?: (role: string) => boolean;
  } = {},
): { model: IkiModel; report?: TurnSolveReport } {
  const { layers, options } = character(opts);
  let report: TurnSolveReport | undefined;
  const model = generateIkiFromLayerSet(
    layers.map((l) => (drop(l.role) ? { ...l, rowRuns: undefined } : l)),
    CANVAS,
    {
      ...options,
      rigPlan,
      turnTargets: { ...targets, ...options.turnTargets },
      onTurnSolved: (r) => {
        report = r;
      },
    },
  );
  return { model, report };
}

/** Every role's runs left out: the rig without them, today's hold. */
export const ALL_RUNS = () => true;

export const EYE_Y = 500 - 433.5;

/** The three cues `measure_turn_reference` reads, off where the render puts
 *  the iris edges and the head's outline: the outermost of the layers drawing
 *  it at the eye row (by default the bangs' at ±262 and the back hair's at
 *  ±230). */
export function renderedCues(
  model: IkiModel,
  ax: number,
  heads: { role: string; left: number; right: number }[] = [
    { role: "hair_front", left: -262, right: 262 },
    { role: "hair_back", left: -230, right: 230 },
  ],
) {
  const p: ParamValues = { [P.AngleX]: ax };
  const iris = (id: string, a: number, b: number) => [
    landedXAt(model, id, a, EYE_Y, p),
    landedXAt(model, id, b, EYE_Y, p),
  ];
  const [l0, l1] = iris("iris_R", -142, -68);
  const [r0, r1] = iris("iris_L", 69, 143);
  const hl = Math.min(
    ...heads.map((h) => landedXAt(model, h.role, h.left, EYE_Y, p)),
  );
  const hr = Math.max(
    ...heads.map((h) => landedXAt(model, h.role, h.right, EYE_Y, p)),
  );
  const head = {
    left: Math.min(...heads.map((h) => h.left)),
    right: Math.max(...heads.map((h) => h.right)),
  };
  const half = (head.right - head.left) / 2;
  const pc = (l0 + l1 + r0 + r1) / 4;
  const pc0 = (-142 - 68 + 69 + 143) / 4;
  const far = ax < 0 ? (l1 - l0) / 74 : (r1 - r0) / 74;
  const near = ax < 0 ? (r1 - r0) / 74 : (l1 - l0) / 74;
  return {
    eyeShift:
      (pc - (hl + hr) / 2 - (pc0 - (head.left + head.right) / 2)) / half,
    farEyeRatio: far / near,
    silhouetteRatio: (hr - hl) / 2 / half,
  };
}

export function signedAreas(v: Float32Array, indices: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]];
    out.push(
      (v[b * 2] - v[a * 2]) * (v[c * 2 + 1] - v[a * 2 + 1]) -
        (v[c * 2] - v[a * 2]) * (v[b * 2 + 1] - v[a * 2 + 1]),
    );
  }
  return out;
}

/** Whether (x, y) lies in the triangle t of the landed vertices v. */
export function inTriangle(v: Float32Array, t: number[], x: number, y: number) {
  const d = (a: number, b: number) =>
    (v[b * 2] - v[a * 2]) * (y - v[a * 2 + 1]) -
    (x - v[a * 2]) * (v[b * 2 + 1] - v[a * 2 + 1]);
  const s = [d(t[0], t[1]), d(t[1], t[2]), d(t[2], t[0])];
  return s.every((e) => e >= -1e-6) || s.every((e) => e <= 1e-6);
}

export function triangles(indices: number[]): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < indices.length; i += 3)
    out.push([indices[i], indices[i + 1], indices[i + 2]]);
  return out;
}

/** Whether the face plate draws a point, at rest. */
export function plateDraws(model: IkiModel): (x: number, y: number) => boolean {
  const v = landVertices(model, "face");
  const part = model.parts.find((p) => p.id === "face")!;
  const tris = triangles(part.mesh!.indices);
  return (x, y) => tris.some((t) => inTriangle(v, t, x, y));
}

/** Samples of the plate's still triangles at `pose` — the neck's, which the
 *  head slides over — above model y `above` that no moving triangle covers:
 *  a still copy of the plate showing beside the turned head. */
export function exposedStill(
  model: IkiModel,
  pose: ParamValues,
  above: number,
) {
  const rest = landVertices(model, "face");
  const v = landVertices(model, "face", pose);
  const part = model.parts.find((p) => p.id === "face")!;
  const moved = (i: number) =>
    Math.hypot(v[i * 2] - rest[i * 2], v[i * 2 + 1] - rest[i * 2 + 1]) >= 0.5;
  const tris = triangles(part.mesh!.indices);
  const moving = tris.filter((t) => t.some(moved));
  const S = 6;
  let n = 0;
  for (const t of tris.filter((t) => !t.some(moved))) {
    for (let i = 0; i <= S; i++) {
      for (let j = 0; i + j <= S; j++) {
        const w = [i / S, j / S, (S - i - j) / S];
        const x = w.reduce((s, wk, k) => s + wk * v[t[k] * 2], 0);
        const y = w.reduce((s, wk, k) => s + wk * v[t[k] * 2 + 1], 0);
        if (y > above && !moving.some((m) => inTriangle(v, m, x, y))) n++;
      }
    }
  }
  return n;
}

/** The fixture's profile unit: eye row 67 → chin −192.6. */
export const HH = 67 + 192.625;
/** The fixture's chin tip, model y. */
export const CHIN_Y = 67 - HH;
export const X30 = (ax: number) => ({ [P.AngleX]: ax });

/** The fixture's face narrowed by 25 px but for rows 170…260 of its crop,
 *  which step out to its drawn width: ears. The frame is built as the
 *  generator builds it. */
export function withEars(
  opts: CharacterOptions = {},
  targets: TurnTargets = {},
  tweak: (l: LayerInput) => LayerInput = (l) => l,
) {
  const { layers, options } = character(opts);
  const face = layers.find((l) => l.role === "face")!;
  const rows = face.rowHalfWidths!.map((w, r) =>
    r >= 170 && r <= 260 ? w : Math.max(10, w - 25),
  );
  const eared = layers.map((l) =>
    tweak(l === face ? { ...l, rowHalfWidths: rows } : l),
  );
  const turnTargets = { ...options.turnTargets, ...targets };
  let report: TurnSolveReport | undefined;
  const m = generateIkiFromLayerSet(eared, CANVAS, {
    ...options,
    turnTargets,
    onTurnSolved: (r) => {
      report = r;
    },
  });
  return {
    m,
    report: report!,
    frame: buildHeadFrame(eared, {
      headHalfWidth: turnTargets.headHalfWidth,
      headEdges:
        turnTargets.headHalfWidth !== undefined ? options.headEdges : undefined,
    }),
  };
}
