import { describe, expect, it } from "vitest";
import {
  IKI_FORMAT_VERSION,
  StandardParameter as P,
  parseIkiModel,
  type IkiDeformer,
  type IkiGridWarp,
  type IkiMatrixDeformer,
  type IkiMesh,
  type IkiModel,
  type IkiPart,
  type IkiWarpDeformer,
} from "@ikijs/format";
import {
  LayerGeometryError,
  generateIkiFromLayerSet,
  type LayerInput,
  type TurnSolveReport,
} from "@ikijs/editor";
import { bindPointToRestGrid } from "../../engine/src/warp-grid";
import {
  BODY_GRID_PAD,
  BODY_MESH_PX,
  BODY_WARP_ID,
  CHEST_DROP,
  HIP_FRACTION,
  buildBodyWarp,
  headOwnBreath,
  headOwnRoll,
  hipLine,
} from "../src/auto-rig/body";
import { buildHeadFrame } from "../src/auto-rig/head";
import { bh, boxOfLayer, bw, cx, cy, roundTo } from "../src/auto-rig/layout";
import { AMPLITUDE, BODY, ROLL_DEG } from "../src/auto-rig/profile";
import type { GenerateOptions } from "../src/auto-rig/types";
import { CANVAS, character } from "./helpers/character";
import {
  BODY_BOX,
  CROTCH_ROW,
  FEET_ROW,
  LEG_RUNS,
  fullBody,
} from "./helpers/full-body";
import * as oracle from "./helpers/render-oracle";

const PAD = BODY_GRID_PAD;

type Point = { x: number; y: number };

const bodyOf = (layers: LayerInput[]): LayerInput =>
  layers.find((l) => l.role === "body")!;

/** The rest grid's column lines (row 0's x) and row lines (column 0's y). */
function linesOf(d: IkiWarpDeformer): { xs: number[]; ys: number[] } {
  const { cols, rows, points } = d.grid;
  return {
    xs: Array.from({ length: cols + 1 }, (_, c) => points[c * 2]),
    ys: Array.from(
      { length: rows + 1 },
      (_, r) => points[r * (cols + 1) * 2 + 1],
    ),
  };
}

function warpOn(d: IkiWarpDeformer, parameter: string): IkiGridWarp {
  const w = d.warps?.find((w) => w.parameter === parameter);
  if (w === undefined) throw new Error(`no ${parameter} warp`);
  return w;
}

/** The keyform offsets at `value`, one of the warp's stops. */
function offsetsAt(
  d: IkiWarpDeformer,
  parameter: string,
  value: number,
): number[] {
  const kf = warpOn(d, parameter).keyforms.find((k) => k.value === value);
  if (kf === undefined) throw new Error(`no ${parameter} stop at ${value}`);
  return kf.offsets;
}

/** Each rest lattice point with its index k (its offsets at 2k, 2k + 1). */
function points(d: IkiWarpDeformer): { x: number; y: number; k: number }[] {
  const p = d.grid.points;
  return Array.from({ length: p.length / 2 }, (_, k) => ({
    x: p[k * 2],
    y: p[k * 2 + 1],
    k,
  }));
}

/** The offset a rotation by `deg` (CCW-positive) about h gives (x, y). */
function rotation(x: number, y: number, h: Point, deg: number): Point {
  const r = (deg * Math.PI) / 180;
  const [dx, dy] = [x - h.x, y - h.y];
  return {
    x: dx * (Math.cos(r) - 1) - dy * Math.sin(r),
    y: dx * Math.sin(r) + dy * (Math.cos(r) - 1),
  };
}

/** The lattice point indices of the cell the engine binds (x, y) into. */
function cellCorners(d: IkiWarpDeformer, x: number, y: number): number[] {
  const { cols } = d.grid;
  const { cell } = bindPointToRestGrid(x, y, d.grid);
  const stride = cols + 1;
  const tl = Math.floor(cell / cols) * stride + (cell % cols);
  return [tl, tl + 1, tl + stride, tl + stride + 1];
}

function expectNear(actual: number, expected: number, tol: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);
}

const onGrid = (p: Point): Point => ({
  x: roundTo(p.x, 0.01),
  y: roundTo(p.y, 0.01),
});

/** Every extreme of the six parameters the body warp reads. */
const EXTREMES: oracle.ParamValues[] = [
  { [P.BodyAngleX]: -10 },
  { [P.BodyAngleX]: 10 },
  { [P.BodyAngleY]: -10 },
  { [P.BodyAngleY]: 10 },
  { [P.BodyAngleZ]: -10 },
  { [P.BodyAngleZ]: 10 },
  { [P.AngleX]: -30 },
  { [P.AngleX]: 30 },
  { [P.AngleZ]: -30 },
  { [P.AngleZ]: 30 },
  { [P.Breath]: 1 },
];

/** A model holding only the body warp, matrix deformers hung from it at
 *  `pivots` (the first is the head's), and the body part on the warp. */
function minimalModel(
  body: LayerInput,
  warp: { deformer: IkiWarpDeformer; mesh: IkiMesh },
  pivots: Point[],
): IkiModel {
  const b = boxOfLayer(body);
  const part: IkiPart = {
    id: "body",
    color: [1, 1, 1, 1],
    width: bw(b),
    height: bh(b),
    transform: { x: cx(b), y: cy(b) },
    order: 0,
    mesh: warp.mesh,
    deformer: BODY_WARP_ID,
  };
  const children: IkiDeformer[] = pivots.map((p, i) => ({
    id: i === 0 ? "headDeformer" : `shoulder${i}`,
    parent: BODY_WARP_ID,
    pivot: onGrid(p),
  }));
  const param = (id: string, min: number, max: number) => ({
    id,
    name: id,
    min,
    max,
    default: 0,
  });
  return {
    version: IKI_FORMAT_VERSION,
    name: "body",
    canvas: { width: body.canvasW, height: body.canvasH },
    parameters: [
      param(P.BodyAngleX, -10, 10),
      param(P.BodyAngleY, -10, 10),
      param(P.BodyAngleZ, -10, 10),
      param(P.AngleX, -30, 30),
      param(P.AngleZ, -30, 30),
      param(P.Breath, 0, 1),
    ],
    parts: [part],
    deformers: [warp.deformer, ...children],
  };
}

/** The full body, its head frame, and one shoulder-like pivot: a deltoid cap
 *  beside the torso, under the chin; `extra` pivots join it. */
function fullBodyWarp(extra: Point[] = []) {
  const { layers, canvas } = fullBody();
  const frame = buildHeadFrame(layers, {});
  const body = bodyOf(layers);
  const box = boxOfLayer(body);
  const chin = { x: frame.axisX, y: frame.chinY };
  const shoulder = { x: -250, y: 469.5 };
  const warp = buildBodyWarp({
    body,
    chin,
    hh: frame.hh,
    pivots: [shoulder, ...extra],
  });
  const anchor = canvas.height / 2 - CROTCH_ROW;
  const pivots = [chin, shoulder, ...extra].map(onGrid);
  // Decision 2's normal case: CHEST_DROP under the chin, or P above the
  // lowest pivot if that is lower; on the grid, give or take a hundredth.
  const yFull = Math.min(
    pivots[0].y - CHEST_DROP * frame.hh,
    Math.min(...pivots.map((p) => p.y)) - PAD,
  );
  return {
    body,
    box,
    hh: frame.hh,
    warp,
    pivots,
    anchor,
    yFull,
    H: { x: cx(box), y: anchor },
  };
}

/** Decision 2's short body: 100 × 20 px, model top 100, bottom 80, not cut
 *  and without runs, so its hips lie at its middle, 90. */
const SHORT: LayerInput = {
  role: "body",
  fileName: "body.png",
  canvasW: 1000,
  canvasH: 1000,
  bbox: { x: 450, y: 400, w: 100, h: 20 },
  cropW: 100,
  cropH: 20,
};
const shortWarp = (chinY: number) =>
  buildBodyWarp({ body: SHORT, chin: { x: 0, y: chinY }, hh: 100, pivots: [] });

describe("body.ts: the hips", () => {
  it("plants a full body at its crotch row's top edge", () => {
    const { layers, canvas } = fullBody();
    expect(hipLine(bodyOf(layers))).toBe(canvas.height / 2 - CROTCH_ROW);
  });

  it("plants a bust cut at the canvas's last row at its bottom edge", () => {
    const body = bodyOf(character().layers);
    expect(body.rowRuns).toBeUndefined();
    expect(body.bbox.y + body.bbox.h - 1).toBe(999);
    expect(hipLine(body)).toBe(-500);
  });

  it("plants a dress, its legs one run, HIP_FRACTION of its height down", () => {
    const { layers, canvas } = fullBody();
    const body = bodyOf(layers);
    const dress: LayerInput = {
      ...body,
      rowRuns: body.rowRuns!.map((runs, k) =>
        body.bbox.y + k < CROTCH_ROW ? runs : [LEG_RUNS[0], LEG_RUNS[3]],
      ),
    };
    expect(hipLine(dress)).toBe(
      canvas.height / 2 - BODY_BOX.y - HIP_FRACTION * BODY_BOX.h,
    );
  });
});

describe("body.ts: the lattice and its weights", () => {
  const { box, warp, pivots, anchor, yFull, H, hh } = fullBodyWarp();
  const d = warp.deformer;
  const { xs, ys } = linesOf(d);

  it("runs its rows down strictly around the body and every pivot, P to spare, on the hips and yFull", () => {
    for (let r = 1; r < ys.length; r++) expect(ys[r]).toBeLessThan(ys[r - 1]);
    const eps = 1e-9;
    expect(xs[0]).toBeLessThanOrEqual(
      Math.min(box.x0, ...pivots.map((p) => p.x)) - PAD + eps,
    );
    expect(xs[xs.length - 1]).toBeGreaterThanOrEqual(
      Math.max(box.x1, ...pivots.map((p) => p.x)) + PAD - eps,
    );
    expect(ys[0]).toBeGreaterThanOrEqual(
      Math.max(box.y1, ...pivots.map((p) => p.y)) + PAD - eps,
    );
    expect(ys[ys.length - 1]).toBeLessThanOrEqual(
      Math.min(anchor, box.y0) - PAD + eps,
    );
    expect(ys).toContain(anchor);
    expect(ys.some((y) => Math.abs(y - yFull) <= 0.01)).toBe(true);
  });

  it("rolls everything from yFull up as one rotation about the hips at BodyAngleZ +10", () => {
    const off = offsetsAt(d, P.BodyAngleZ, 10);
    const band = points(d).filter((p) => p.y >= yFull - 0.01);
    expect(band.length).toBeGreaterThan(xs.length);
    for (const { x, y, k } of band) {
      const want = rotation(x, y, H, -BODY.rollDeg);
      expectNear(off[k * 2], want.x, 0.01);
      expectNear(off[k * 2 + 1], want.y, 0.01);
    }
  });

  it("plants every point at or below the hips at every stop of all six warps", () => {
    const below = points(d).filter((p) => p.y <= anchor);
    expect(below.length).toBe(2 * xs.length);
    for (const w of d.warps!) {
      for (const kf of w.keyforms) {
        for (const { k } of below) {
          expect(kf.offsets[k * 2]).toBe(0);
          expect(kf.offsets[k * 2 + 1]).toBe(0);
        }
      }
    }
  });

  it("puts each pivot's whole cell at weight 1", () => {
    // As built (yFull CHEST_DROP under the chin), and with a pivot low
    // enough that yFull sits P above it instead.
    const low = fullBodyWarp([{ x: 150, y: 380 }]);
    expect(low.yFull).toBe(380 - PAD);
    for (const built of [
      { d, pivots, hh, H },
      { ...low, d: low.warp.deformer },
    ]) {
      const off = offsetsAt(built.d, P.BodyAngleX, 10);
      for (const p of built.pivots) {
        for (const k of cellCorners(built.d, p.x, p.y)) {
          const x = built.d.grid.points[k * 2];
          expectNear(
            off[k * 2],
            BODY.slide * built.hh - BODY.narrow * (x - built.H.x),
            0.01,
          );
          expect(off[k * 2 + 1]).toBe(0);
        }
      }
    }
  });

  it("fits the chest and the ramp between the chin and the hips of a body shorter than the chest drop", () => {
    expect(hipLine(SHORT)).toBe(90);
    const short = shortWarp(100);
    const s = short.deformer;
    expect(linesOf(s).ys).toEqual([106, 95, 92.5, 90, 74]);
    for (const w of s.warps!) {
      for (const kf of w.keyforms) {
        for (const { y, k } of points(s)) {
          if (y > 90) continue;
          expect(kf.offsets[k * 2]).toBe(0);
          expect(kf.offsets[k * 2 + 1]).toBe(0);
        }
      }
    }
    const roll = offsetsAt(s, P.BodyAngleZ, 10);
    for (const k of cellCorners(s, 0, 100)) {
      const [x, y] = [s.grid.points[k * 2], s.grid.points[k * 2 + 1]];
      const want = rotation(x, y, { x: 0, y: 90 }, -BODY.rollDeg);
      expectNear(roll[k * 2], want.x, 0.01);
      expectNear(roll[k * 2 + 1], want.y, 0.01);
    }

    // Rendered: nothing at or under the hips moves under any extreme.
    const model = minimalModel(SHORT, short, [{ x: 0, y: 100 }]);
    expect(() => parseIkiModel(model)).not.toThrow();
    for (const params of EXTREMES) {
      for (const y of [90, 89, 85, 80]) {
        for (const x of [-40, 0, 40]) {
          expect(
            Math.abs(oracle.landedXAt(model, "body", x, y, params) - x),
          ).toBeLessThan(0.01);
          expect(
            Math.abs(oracle.landedYAt(model, "body", x, y, params) - y),
          ).toBeLessThan(0.01);
        }
      }
    }
    expect(
      oracle.landedYAt(model, "body", 0, 97, { [P.Breath]: 1 }) - 97,
    ).toBeCloseTo(AMPLITUDE.breathBody * 100, 2);
  });

  it("still fits a ramp when the chin sits 1 px above the hips", () => {
    const s = shortWarp(91).deformer;
    expect(linesOf(s).ys).toEqual([106, 90.5, 90.25, 90, 74]);
    for (const w of s.warps!) {
      for (const kf of w.keyforms) {
        for (const { y, k } of points(s)) {
          if (y > 90) continue;
          expect(kf.offsets[k * 2]).toBe(0);
          expect(kf.offsets[k * 2 + 1]).toBe(0);
        }
      }
    }
    const roll = offsetsAt(s, P.BodyAngleZ, 10);
    for (const k of cellCorners(s, 0, 91)) {
      const [x, y] = [s.grid.points[k * 2], s.grid.points[k * 2 + 1]];
      expect(y).toBeGreaterThanOrEqual(90.5);
      const want = rotation(x, y, { x: 0, y: 90 }, -BODY.rollDeg);
      expectNear(roll[k * 2], want.x, 0.01);
      expectNear(roll[k * 2 + 1], want.y, 0.01);
    }
  });

  it("refuses only hips with no row line under the pivots", () => {
    const refusal =
      /its hips \(y 90\) leave no row line strictly between them and the lowest of the head's and shoulders' pivots/;
    for (const chinY of [90.01, 89]) {
      let caught: unknown;
      try {
        shortWarp(chinY);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(LayerGeometryError);
      expect((caught as Error).message).toMatch(refusal);
      expect((caught as Error).message).toMatch(/layer "body\.png"/);
    }
    expect(linesOf(shortWarp(90.02).deformer).ys).toEqual([106, 90.01, 90, 74]);
  });

  it("cuts the body's mesh on every lattice line inside the box", () => {
    const { vertices, uvs } = warp.mesh;
    const meshYs = [
      ...new Set(
        Array.from(
          { length: vertices.length / 2 },
          (_, i) => cy(box) + vertices[i * 2 + 1] * bh(box),
        ),
      ),
    ].sort((a, b) => b - a);
    // Vertices are written to 1e-5 of the box: under 0.01 px on this one.
    const inside = ys.filter((y) => y > box.y0 && y < box.y1);
    expect(inside).toContain(anchor);
    expect(inside.some((y) => Math.abs(y - yFull) <= 0.01)).toBe(true);
    for (const y of inside) {
      expect(meshYs.some((m) => Math.abs(m - y) <= 0.01)).toBe(true);
    }
    for (let i = 1; i < meshYs.length; i++) {
      expect(meshYs[i - 1] - meshYs[i]).toBeLessThanOrEqual(
        BODY_MESH_PX + 0.01,
      );
    }
    const vx = vertices.filter((_, i) => i % 2 === 0);
    const vy = vertices.filter((_, i) => i % 2 === 1);
    expect([Math.min(...vx), Math.max(...vx)]).toEqual([-0.5, 0.5]);
    expect([Math.min(...vy), Math.max(...vy)]).toEqual([-0.5, 0.5]);
    for (let i = 0; i < vertices.length; i += 2) {
      expectNear(uvs[i], vertices[i] + 0.5, 1e-9);
      expectNear(uvs[i + 1], 0.5 - vertices[i + 1], 1e-9);
    }
  });
});

describe("body.ts: the keyforms", () => {
  const { warp, yFull, H, hh } = fullBodyWarp();
  const d = warp.deformer;
  // The weight-1 band: every line from yFull up.
  const band = points(d).filter((p) => p.y >= yFull - 0.01);

  it("drives BodyAngleX/Y/Z, the follow of AngleX and AngleZ, and the breath, in that order", () => {
    expect(d.id).toBe(BODY_WARP_ID);
    expect(d.parent).toBeUndefined();
    expect(
      d.warps!.map((w) => [w.parameter, w.keyforms.map((k) => k.value)]),
    ).toEqual([
      [P.BodyAngleX, [-10, 0, 10]],
      [P.BodyAngleY, [-10, 0, 10]],
      [P.BodyAngleZ, [-10, 0, 10]],
      [P.AngleX, [-30, 0, 30]],
      [P.AngleZ, [-30, 0, 30]],
      [P.Breath, [0, 1]],
    ]);
  });

  it("rests at zero", () => {
    for (const w of d.warps!) {
      expect(offsetsAt(d, w.parameter, 0).every((o) => o === 0)).toBe(true);
    }
  });

  it("turns the upper body on BodyAngleX either way, narrowing it both ways", () => {
    for (const t of [-1, 1]) {
      const off = offsetsAt(d, P.BodyAngleX, 10 * t);
      for (const { x, k } of band) {
        expectNear(
          off[k * 2],
          t * BODY.slide * hh - BODY.narrow * (x - H.x),
          0.01,
        );
        expect(off[k * 2 + 1]).toBe(0);
      }
    }
  });

  it("follows AngleX by bodyFollowX of BodyAngleX", () => {
    for (const t of [-1, 1]) {
      const follow = offsetsAt(d, P.AngleX, 30 * t);
      const body = offsetsAt(d, P.BodyAngleX, 10 * t);
      for (const { k } of band) {
        expectNear(follow[k * 2], BODY.followX * body[k * 2], 0.02);
        expect(follow[k * 2 + 1]).toBe(0);
      }
    }
  });

  it("raises and bows the upper body on BodyAngleY, by each line's weight", () => {
    const fullLine = linesOf(d).ys.find((y) => Math.abs(y - yFull) <= 0.01)!;
    const off = offsetsAt(d, P.BodyAngleY, 10);
    const bow = offsetsAt(d, P.BodyAngleY, -10);
    // How far the ramp's lines lie off a linear ramp, at most.
    let offLinear = 0;
    for (const { y, k } of points(d)) {
      const w = y >= yFull - 0.01 ? 1 : y <= H.y ? 0 : undefined;
      expect(off[k * 2]).toBe(0);
      expectNear(bow[k * 2 + 1], -off[k * 2 + 1], 0.01);
      if (w !== undefined) expectNear(off[k * 2 + 1], w * BODY.bow * hh, 0.01);
      // The ramp: smoothstep from the planted line up to the full band, so
      // the waist eases out of the hips and into the chest.
      else {
        const t = (y - H.y) / (fullLine - H.y);
        expectNear(off[k * 2 + 1], t * t * (3 - 2 * t) * BODY.bow * hh, 0.01);
        offLinear = Math.max(
          offLinear,
          Math.abs(off[k * 2 + 1] - t * BODY.bow * hh),
        );
      }
    }
    // Not a linear ramp (the two agree only at its middle).
    expect(offLinear).toBeGreaterThan(0.5);
  });

  it("rolls the upper body about the hips on BodyAngleZ, and by β on AngleZ", () => {
    for (const t of [-1, 1]) {
      const roll = offsetsAt(d, P.BodyAngleZ, 10 * t);
      const follow = offsetsAt(d, P.AngleZ, 30 * t);
      for (const { x, y, k } of band) {
        const r = rotation(x, y, H, -t * BODY.rollDeg);
        expectNear(roll[k * 2], r.x, 0.01);
        expectNear(roll[k * 2 + 1], r.y, 0.01);
        const f = rotation(x, y, H, -t * BODY.followRoll);
        expectNear(follow[k * 2], f.x, 0.01);
        expectNear(follow[k * 2 + 1], f.y, 0.01);
      }
    }
  });

  it("lifts the upper body breath·hh on Breath 1", () => {
    const off = offsetsAt(d, P.Breath, 1);
    for (const { k } of band) {
      expect(off[k * 2]).toBe(0);
      expectNear(off[k * 2 + 1], AMPLITUDE.breathBody * hh, 0.01);
    }
  });

  it("parses: a matrix child at the chin and at each shoulder lies inside the grid", () => {
    const { layers } = fullBody();
    const frame = buildHeadFrame(layers, {});
    const body = bodyOf(layers);
    const chin = { x: frame.axisX, y: frame.chinY };
    const shoulders = [
      { x: -250, y: 469.5 },
      { x: 251, y: 469.5 },
    ];
    const both = buildBodyWarp({
      body,
      chin,
      hh: frame.hh,
      pivots: shoulders,
    });
    const model = minimalModel(body, both, [chin, ...shoulders]);
    expect(() => parseIkiModel(model)).not.toThrow();
    const raisedY = onGrid(chin).y + PAD + 1;
    expect(raisedY).toBeGreaterThan(linesOf(both.deformer).ys[0]);
    const raised: IkiModel = {
      ...model,
      deformers: model.deformers!.map((x) =>
        x.id === "headDeformer" && x.kind !== "warp"
          ? { ...x, pivot: { x: x.pivot.x, y: raisedY } }
          : x,
      ),
    };
    expect(() => parseIkiModel(raised)).toThrow(
      /lies outside its warp parent "bodyWarp" rest grid/,
    );
  });
});

describe("body.ts: the head on the body", () => {
  it("leaves the head's world roll and the chin's net breath as they were", () => {
    expect(headOwnRoll(false)).toBe(ROLL_DEG);
    expect(headOwnRoll(true) + BODY.followRoll).toBeCloseTo(ROLL_DEG, 9);
    expect(headOwnBreath(false)).toBe(AMPLITUDE.breathHead);
    expect(headOwnBreath(true) + AMPLITUDE.breathBody).toBeCloseTo(
      AMPLITUDE.breathHead,
      9,
    );
  });
});

/** The layer set rigged, with the turn report it gave. */
function rigged(
  layers: LayerInput[],
  options: GenerateOptions,
  canvas: { width: number; height: number },
): { model: IkiModel; report?: TurnSolveReport } {
  let report: TurnSolveReport | undefined;
  const model = generateIkiFromLayerSet(layers, canvas, {
    ...options,
    onTurnSolved: (r) => {
      report = r;
    },
  });
  return { model, report };
}

/** The head deformer, a matrix. */
function headOf(model: IkiModel): IkiMatrixDeformer {
  const d = model.deformers?.find((x) => x.id === "headDeformer");
  if (d === undefined || d.kind === "warp") {
    throw new Error("no matrix headDeformer");
  }
  return d;
}

const partOf = (model: IkiModel, id: string): IkiPart =>
  model.parts.find((p) => p.id === id)!;

/** Where the head's world affine takes its pivot, less the pivot. */
function headCarry(model: IkiModel, params: oracle.ParamValues): Point {
  const p = headOf(model).pivot;
  const w = oracle.deformerWorld(model, "headDeformer", params);
  return {
    x: w[0] * p.x + w[2] * p.y + w[4] - p.x,
    y: w[1] * p.x + w[3] * p.y + w[5] - p.y,
  };
}

/** The head's world rotation, degrees, CCW-positive. */
function headRoll(model: IkiModel, params: oracle.ParamValues): number {
  const w = oracle.deformerWorld(model, "headDeformer", params);
  return (Math.atan2(w[1], w[0]) * 180) / Math.PI;
}

/** How far the body's bottom row of vertices moves at `params`, at most. */
function feetMove(model: IkiModel, params: oracle.ParamValues): number {
  const rest = oracle.landVertices(model, "body");
  const posed = oracle.landVertices(model, "body", params);
  let bottom = Infinity;
  for (let i = 1; i < rest.length; i += 2) bottom = Math.min(bottom, rest[i]);
  let most = 0;
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i + 1] !== bottom) continue;
    most = Math.max(
      most,
      Math.abs(posed[i] - rest[i]),
      Math.abs(posed[i + 1] - rest[i + 1]),
    );
  }
  return most;
}

describe("the body rig on a bust", () => {
  const bust = character();
  const withBody = rigged(bust.layers, bust.options, CANVAS);
  const headOnly = rigged(
    bust.layers.filter((l) => l.role !== "body"),
    bust.options,
    CANVAS,
  );
  const { model } = withBody;

  it("hangs the head from bodyWarp and drops bodyDeformer", () => {
    const ids = model.deformers!.map((d) => d.id);
    expect(ids.slice(0, 2)).toEqual([BODY_WARP_ID, "headDeformer"]);
    expect(ids).not.toContain("bodyDeformer");
    expect(headOf(model).parent).toBe(BODY_WARP_ID);
    const body = partOf(model, "body");
    expect(body.deformer).toBe(BODY_WARP_ID);
    expect(body.mesh).toBeDefined();
    expect(() => parseIkiModel(model)).not.toThrow();
  });

  it("leaves the head rig as it was but for the head deformer and the neck's roll", () => {
    const noOrder = ({ order: _, ...p }: IkiPart) => p;
    for (const part of headOnly.model.parts) {
      if (part.id === "face") continue;
      expect(noOrder(partOf(model, part.id)), part.id).toEqual(noOrder(part));
    }
    // The face differs only in its roll: the neck island undoes the head's
    // own roll, which the body's follow makes smaller.
    const notRoll = (p: IkiPart) => ({
      ...noOrder(p),
      warps: p.warps?.filter((w) => w.parameter !== P.AngleZ),
    });
    const face = partOf(model, "face");
    const bareFace = partOf(headOnly.model, "face");
    expect(notRoll(face)).toEqual(notRoll(bareFace));
    const roll = (p: IkiPart) => p.warps!.find((w) => w.parameter === P.AngleZ);
    expect(roll(face)).toBeDefined();
    expect(roll(face)).not.toEqual(roll(bareFace));
    // The feature warps hang from the head unchanged.
    const features = (m: IkiModel) =>
      m.deformers!.filter(
        (d) => d.kind === "warp" && d.parent === "headDeformer",
      );
    expect(features(model).length).toBeGreaterThan(0);
    expect(features(model)).toEqual(features(headOnly.model));
    // The head deformer: its parent, and its own roll and breath.
    const head = headOf(model);
    const bareHead = headOf(headOnly.model);
    const rest = ({ parent: _p, bindings: _b, ...d }: IkiMatrixDeformer) => d;
    expect(rest(head)).toEqual(rest(bareHead));
    expect(bareHead.parent).toBeUndefined();
    expect(head.bindings).not.toEqual(bareHead.bindings);
    expect(head.bindings).toHaveLength(2);
    expect(withBody.report).toBeDefined();
    expect(withBody.report).toEqual(headOnly.report);
  });

  it("declares BodyAngleX/Y/Z ±10 only with a body", () => {
    const ids = model.parameters.map((p) => p.id);
    const z = ids.indexOf(P.AngleZ);
    expect(ids.slice(z + 1, z + 4)).toEqual([
      P.BodyAngleX,
      P.BodyAngleY,
      P.BodyAngleZ,
    ]);
    for (const [id, name] of [
      [P.BodyAngleX, "Body Angle X"],
      [P.BodyAngleY, "Body Angle Y"],
      [P.BodyAngleZ, "Body Angle Z"],
    ]) {
      expect(model.parameters.find((p) => p.id === id)).toEqual({
        id,
        name,
        min: -10,
        max: 10,
        default: 0,
      });
    }
    // Without a body, the head hangs from nothing and rolls and breathes
    // whole.
    const bare = headOnly.model;
    expect(
      bare.parameters.filter((p) => p.id.startsWith("ParamBodyAngle")),
    ).toEqual([]);
    expect(bare.deformers!.map((d) => d.id)).not.toContain(BODY_WARP_ID);
    const head = headOf(bare);
    expect(head.parent).toBeUndefined();
    const hh = buildHeadFrame(bust.layers, {}).hh;
    expect(head.bindings).toEqual([
      { parameter: P.AngleZ, channel: "rotate", from: ROLL_DEG, to: -ROLL_DEG },
      {
        parameter: P.Breath,
        channel: "translateY",
        from: 0,
        to: roundTo(AMPLITUDE.breathHead * hh, 0.01),
      },
    ]);
    // With one, both are the head's own share.
    const own = headOwnRoll(true);
    expect(headOf(model).bindings).toEqual([
      { parameter: P.AngleZ, channel: "rotate", from: own, to: -own },
      {
        parameter: P.Breath,
        channel: "translateY",
        from: 0,
        to: roundTo(headOwnBreath(true) * hh, 0.01),
      },
    ]);
  });
});

/** The y of every part's placement and every matrix pivot (`placed`) and
 *  of every warp grid point (`grid`), each in model order, and the model
 *  with each of them (and the canvas's height) zeroed: what a canvas
 *  extended down moves, and the rest. */
function splitYs(model: IkiModel): {
  placed: number[];
  grid: number[];
  rest: unknown;
} {
  const placed: number[] = [];
  const grid: number[] = [];
  const parts = model.parts.map((p) => {
    placed.push(p.transform.y);
    return { ...p, transform: { ...p.transform, y: 0 } };
  });
  const deformers = model.deformers!.map((d) => {
    if (d.kind === "warp") {
      const points = d.grid.points.map((v, i) => {
        if (i % 2 === 0) return v;
        grid.push(v);
        return 0;
      });
      return { ...d, grid: { ...d.grid, points } };
    }
    placed.push(d.pivot.y);
    return { ...d, pivot: { ...d.pivot, y: 0 } };
  });
  return {
    placed,
    grid,
    rest: {
      ...model,
      canvas: { ...model.canvas, height: 0 },
      parts,
      deformers,
    },
  };
}

describe("the full body", () => {
  const { layers, options, canvas } = fullBody();
  const { model } = rigged(layers, options, canvas);
  const frame = buildHeadFrame(layers, {});
  const hh = frame.hh;
  const pivot = headOf(model).pivot;
  const box = boxOfLayer(bodyOf(layers));
  const anchor = canvas.height / 2 - CROTCH_ROW;
  const H = { x: cx(box), y: anchor };
  /** Model x of a canvas column's centre, and y of a canvas row's. */
  const colX = (c: number) => c + 0.5 - canvas.width / 2;
  const rowY = (r: number) => canvas.height / 2 - r - 0.5;
  const legColumns: number[] = [];
  for (let c = 330; c <= 480; c += 30) legColumns.push(c);
  for (let c = 521; c <= 671; c += 30) legColumns.push(c);

  it("hangs the head at the frame's chin", () => {
    expect(pivot).toEqual(onGrid({ x: frame.axisX, y: frame.chinY }));
  });

  it("rests on the art", () => {
    const v = oracle.landVertices(model, "body");
    const xs = v.filter((_, i) => i % 2 === 0);
    const ys = v.filter((_, i) => i % 2 === 1);
    expectNear(Math.min(...xs), box.x0, 2);
    expectNear(Math.max(...xs), box.x1, 2);
    expectNear(Math.min(...ys), box.y0, 2);
    expectNear(Math.max(...ys), box.y1, 2);
  });

  it("plants everything under the hips at every body pose", () => {
    const at = oracle.landerFor(model, "body");
    const points: Point[] = [];
    for (const y of [anchor, anchor - 1, anchor - 5, rowY(FEET_ROW)]) {
      for (const c of legColumns) points.push({ x: colX(c), y });
    }
    for (const params of EXTREMES) {
      const posed = oracle.landerFor(model, "body", params);
      for (const { x, y } of points) {
        const [a, b] = [at(x, y), posed(x, y)];
        const label = `${JSON.stringify(params)} (${x}, ${y})`;
        expect(Math.abs(b.x - a.x), label).toBeLessThan(0.01);
        expect(Math.abs(b.y - a.y), label).toBeLessThan(0.01);
      }
    }
    // The ramp is live right up to the planted line.
    const tilt = oracle.landerFor(model, "body", { [P.BodyAngleZ]: 10 });
    const x = colX(legColumns[0]);
    const [a, b] = [at(x, anchor + 5), tilt(x, anchor + 5)];
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThan(0.01);
  });

  it("breathes: the shoulders lift, the chin's net is the head's, the feet stay", () => {
    const breath = { [P.Breath]: 1 };
    const top = (params: oracle.ParamValues) =>
      oracle.landedYAt(model, "body", cx(box), box.y1, params);
    expectNear(top(breath) - top({}), AMPLITUDE.breathBody * hh, 0.01);
    const carry = headCarry(model, breath);
    expectNear(carry.x, 0, 1e-3);
    expectNear(carry.y, AMPLITUDE.breathHead * hh, 0.02);
    expect(feetMove(model, breath)).toBeLessThan(0.1);
  });

  it("BodyAngleX and BodyAngleY carry the head without turning it, feet still", () => {
    for (const t of [-1, 1]) {
      const turn = { [P.BodyAngleX]: 10 * t };
      const c = headCarry(model, turn);
      expectNear(
        c.x,
        t * BODY.slide * hh - BODY.narrow * (pivot.x - H.x),
        0.02,
      );
      expectNear(c.y, 0, 0.02);
      expect(Math.abs(headRoll(model, turn))).toBeLessThan(0.01);
      expect(feetMove(model, turn)).toBeLessThan(0.1);
      // The torso's top row narrows about the body's centre, either way.
      const top = (params: oracle.ParamValues) =>
        oracle.landedXAt(model, "body", box.x1, box.y1, params) -
        oracle.landedXAt(model, "body", box.x0, box.y1, params);
      expect(top(turn) / top({})).toBeCloseTo(1 - BODY.narrow, 3);

      const bow = { [P.BodyAngleY]: 10 * t };
      const b = headCarry(model, bow);
      expectNear(b.x, 0, 0.02);
      expectNear(b.y, t * BODY.bow * hh, 0.02);
      expect(Math.abs(headRoll(model, bow))).toBeLessThan(0.01);
      expect(feetMove(model, bow)).toBeLessThan(0.1);
    }
  });

  it("follows AngleX by bodyFollowX of BodyAngleX", () => {
    for (const t of [-1, 1]) {
      const follow = { [P.AngleX]: 30 * t };
      const c = headCarry(model, follow);
      const body = headCarry(model, { [P.BodyAngleX]: 10 * t });
      expectNear(c.x, BODY.followX * body.x, 0.05);
      expectNear(c.y, 0, 0.05);
      expect(Math.abs(headRoll(model, follow))).toBeLessThan(0.01);
      expect(feetMove(model, follow)).toBeLessThan(0.1);
    }
  });

  it("rolls the head ROLL_DEG in the world at AngleZ ±30 while the body leans β about the hips", () => {
    // The bust's neck outline and base (auto-rig.test.ts), moved with the
    // head on the taller canvas.
    const dy = canvas.height / 2 - CANVAS.height / 2;
    const rest = oracle.landVertices(model, "face");
    const neck: number[] = [];
    for (let i = 0; i < rest.length / 2; i++) {
      const [x, y] = [rest[i * 2], rest[i * 2 + 1]];
      if (y < dy - 205 && (Math.abs(x - 0.5) >= 78 || y < dy - 255)) {
        neck.push(i);
      }
    }
    expect(neck.length).toBeGreaterThan(6);
    for (const t of [-1, 1]) {
      const tilt = { [P.AngleZ]: 30 * t };
      expectNear(headRoll(model, tilt), -t * ROLL_DEG, 0.05);
      const top = { x: cx(box), y: box.y1 };
      const lean = rotation(top.x, top.y, H, -t * BODY.followRoll);
      const at = oracle.landerFor(model, "body", tilt)(top.x, top.y);
      expectNear(at.x, top.x + lean.x, 0.5);
      expectNear(at.y, top.y + lean.y, 0.5);
      expect(feetMove(model, tilt)).toBeLessThan(0.1);
      const v = oracle.landVertices(model, "face", tilt);
      for (const i of neck) {
        const [x, y] = [rest[i * 2], rest[i * 2 + 1]];
        const torso = oracle.warpPointAt(model, BODY_WARP_ID, x, y, tilt);
        expectNear(v[i * 2], torso.x, 0.5);
        expectNear(v[i * 2 + 1], torso.y, 0.5);
      }
    }
  });

  it("rolls the head with the body on BodyAngleZ alone", () => {
    for (const t of [-1, 1]) {
      const tilt = { [P.BodyAngleZ]: 10 * t };
      expectNear(headRoll(model, tilt), -t * BODY.rollDeg, 0.05);
      expect(feetMove(model, tilt)).toBeLessThan(0.1);
    }
  });

  it("is the same rig, translated, on a canvas extended further down", () => {
    const taller = fullBody({ extend: 1800 });
    const a = splitYs(model);
    const b = splitYs(
      rigged(taller.layers, taller.options, taller.canvas).model,
    );
    for (const key of ["placed", "grid"] as const) {
      expect(b[key]).toHaveLength(a[key].length);
      b[key].forEach((y, i) => expect(y - a[key][i]).toBeCloseTo(100, 2));
    }
    expect(b.rest).toEqual(a.rest);

    // The bust's head is the full body's, 800 px lower.
    const bust = character();
    const bustModel = rigged(bust.layers, bust.options, CANVAS).model;
    const head = (m: IkiModel) =>
      splitYs({
        ...m,
        parts: m.parts.filter((p) => p.id !== "body"),
        deformers: m.deformers!.filter((d) => d.parent === "headDeformer"),
      });
    const full = head(model);
    const low = head(bustModel);
    expect(low.placed).toHaveLength(full.placed.length);
    low.placed.forEach((y, i) =>
      expect(full.placed[i] - y).toBeCloseTo(800, 2),
    );
    // A feature lattice's line is snapped to the 0.01 grid, and one sitting
    // on a hundredth's tie can snap either way once moved by 800 (the
    // mouth's does): one grid step, its keyforms unchanged.
    expect(low.grid).toHaveLength(full.grid.length);
    low.grid.forEach((y, i) => expectNear(full.grid[i] - y, 800, 0.01 + 1e-9));
    const parts = (r: unknown) => (r as IkiModel).parts;
    const warps = (r: unknown) => (r as IkiModel).deformers;
    expect(parts(full.rest)).toEqual(parts(low.rest));
    expect(warps(full.rest)).toEqual(warps(low.rest));
  });

  it("is deterministic", () => {
    expect(rigged(layers, options, canvas).model).toEqual(model);
  });
});
