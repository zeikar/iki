import { describe, expect, it } from "vitest";
import {
  StandardParameter as P,
  type IkiGrid2DWarp,
  type IkiModel,
  type IkiPart,
} from "@ikijs/format";
import {
  PatchError,
  generateIkiFromLayerSet,
  type PatchReport,
  type RigPatch,
  type TurnSolveReport,
} from "@ikijs/editor";
import { X_STOPS, Y_STOPS } from "../src/auto-rig/grid";
import { boxOfLayer, roundTo, type Box } from "../src/auto-rig/layout";
import { applyPatches } from "../src/auto-rig/patches";
import { CANVAS, character } from "./helpers/character";

const { layers, options } = character();
const layerOf = (role: string) => layers.find((l) => l.role === role)!;
/** The unit of `by` and `falloff`. */
const FACE_W = layerOf("face").cropW;
/** Half the rig's rounding of a grid offset (0.1 px) and of a part's (1e-4
 *  of its box): how far a patched offset may sit from old + delta. */
const GRID_TOL = 0.05 + 1e-9;
const PART_TOL = 0.5e-4 + 1e-9;

interface Rigged {
  model: IkiModel;
  turn?: TurnSolveReport;
  patches?: PatchReport[];
}

function rig(patches?: RigPatch[]): Rigged {
  let turn: TurnSolveReport | undefined;
  let applied: PatchReport[] | undefined;
  const model = generateIkiFromLayerSet(layers, CANVAS, {
    ...options,
    patches,
    onTurnSolved: (r) => {
      turn = r;
    },
    onPatchesApplied: (r) => {
      applied = r;
    },
  });
  return { model, turn, patches: applied };
}

const base = rig();

/** A feature grid's rest points and its `warp2d`. */
function gridOf(model: IkiModel, id: string) {
  const d = model.deformers!.find((q) => q.id === id);
  if (d?.kind !== "warp" || d.warp2d === undefined) {
    throw new Error(`${id} is not a feature grid`);
  }
  const points: [number, number][] = [];
  for (let k = 0; k < d.grid.points.length; k += 2) {
    points.push([d.grid.points[k], d.grid.points[k + 1]]);
  }
  return { cols: d.grid.cols, points, warp2d: d.warp2d };
}

/** `warp2d`'s keyform at (`ax`, `ay`). */
const stopOf = (w: IkiGrid2DWarp, ax: number, ay: number) =>
  w.keyforms2d[
    w.valuesY.indexOf(ay) * w.valuesX.length + w.valuesX.indexOf(ax)
  ];

const partOf = (model: IkiModel, id: string): IkiPart =>
  model.parts.find((p) => p.id === id)!;

/** A part's keyform at `param` = `value` (the first, as the applier picks). */
function keyformOf(model: IkiModel, id: string, param: string, value: number) {
  return partOf(model, id)
    .warps!.filter((w) => w.parameter === param)
    .flatMap((w) => w.keyforms)
    .find((k) => k.value === value)!;
}

/** The point indices whose rest position lies in `role`'s rest box over
 *  fractions `x` and `y` (y down), as a region names them. */
function insideRegion(
  points: [number, number][],
  role: string,
  x: [number, number],
  y: [number, number],
): number[] {
  const b = boxOfLayer(layerOf(role));
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  return points.flatMap(([px, py], i) =>
    px >= b.x0 + x[0] * w &&
    px <= b.x0 + x[1] * w &&
    py <= b.y1 - y[0] * h &&
    py >= b.y1 - y[1] * h
      ? [i]
      : [],
  );
}

const R30 = { [P.AngleX]: -30, [P.AngleY]: 0 };
const WHOLE: Pick<RigPatch["region"], "x" | "y"> = { x: [0, 1], y: [0, 1] };

/** The far side of the turn, over the whole right eye: right and a little
 *  up on screen. */
const gridOp: RigPatch = {
  target: "eyeWarp_R",
  at: R30,
  region: { role: "eye_R", ...WHOLE },
  by: { dx: 0.01, dy: -0.005 },
};
const gridInside = insideRegion(
  gridOf(base.model, "eyeWarp_R").points,
  "eye_R",
  [0, 1],
  [0, 1],
);

/** The plate's middle on the turn: right and down on screen. Its edges sit
 *  between the plate's vertex columns and rows. */
const FACE_X: [number, number] = [0.31, 0.69];
const FACE_Y: [number, number] = [0.3, 0.5];
const faceOp: RigPatch = {
  target: "face",
  at: { [P.AngleX]: -30 },
  region: { role: "face", x: FACE_X, y: FACE_Y },
  by: { dx: 0.01, dy: 0.02 },
};
const faceVertices = partOf(base.model, "face").mesh!.vertices;
/** The plate's vertices across its rest box, from the left and the top. */
const faceFractions = Array.from(
  { length: faceVertices.length / 2 },
  (_, i): [number, number] => [
    faceVertices[2 * i] + 0.5,
    0.5 - faceVertices[2 * i + 1],
  ],
);
const faceInside = faceFractions.flatMap(([u, t], i) =>
  u >= FACE_X[0] && u <= FACE_X[1] && t >= FACE_Y[0] && t <= FACE_Y[1]
    ? [i]
    : [],
);

describe("rig patches: replay", () => {
  it("leaves the rig byte-identical without patches, or with none", () => {
    const absent = JSON.stringify(
      generateIkiFromLayerSet(layers, CANVAS, options),
    );
    const empty = rig([]);
    expect(JSON.stringify(base.model)).toBe(absent);
    expect(JSON.stringify(empty.model)).toBe(absent);
    // The echo comes whenever patches are given, an empty list included.
    expect(base.patches).toBeUndefined();
    expect(empty.patches).toEqual([]);
  });

  it("moves a grid's points inside the region at that stop only", () => {
    expect(gridInside.length).toBeGreaterThan(0);
    const { model } = rig([gridOp]);
    const before = gridOf(base.model, "eyeWarp_R");
    const after = gridOf(model, "eyeWarp_R");
    const was = stopOf(before.warp2d, -30, 0).offsets;
    const now = stopOf(after.warp2d, -30, 0).offsets;
    before.points.forEach((_, i) => {
      const dx = now[2 * i] - was[2 * i];
      const dy = now[2 * i + 1] - was[2 * i + 1];
      if (gridInside.includes(i)) {
        expect(Math.abs(dx - 0.01 * FACE_W)).toBeLessThanOrEqual(GRID_TOL);
        // Up on screen is up in the model.
        expect(Math.abs(dy - 0.005 * FACE_W)).toBeLessThanOrEqual(GRID_TOL);
      } else {
        expect([dx, dy]).toEqual([0, 0]);
      }
    });
    expect(stopOf(after.warp2d, 0, 0).offsets.every((o) => o === 0)).toBe(true);
    // With that keyform put back, it is the unpatched rig: no other stop,
    // deformer or part moved.
    const restored = structuredClone(model);
    stopOf(gridOf(restored, "eyeWarp_R").warp2d, -30, 0).offsets = was;
    expect(restored).toEqual(base.model);
  });

  it("eases a falloff op's move past the region and counts what it moved", () => {
    const fall = 0.1 * FACE_W;
    const x: [number, number] = [0.3, 0.7];
    const y: [number, number] = [0.3, 0.7];
    const full = 0.05 * FACE_W;
    const { model, patches } = rig([
      {
        target: "eyeWarp_R",
        at: { [P.AngleX]: 0, [P.AngleY]: 30 },
        region: { role: "eye_R", x, y },
        by: { dx: 0.05, dy: 0 },
        falloff: 0.1,
      },
    ]);
    const { points, warp2d } = gridOf(base.model, "eyeWarp_R");
    const was = stopOf(warp2d, 0, 30).offsets;
    const now = stopOf(gridOf(model, "eyeWarp_R").warp2d, 0, 30).offsets;
    const b = boxOfLayer(layerOf("eye_R"));
    const [x0, x1] = x.map((f) => b.x0 + f * (b.x1 - b.x0));
    const [top, bottom] = y.map((f) => b.y1 - f * (b.y1 - b.y0));
    const past: { d: number; move: number }[] = [];
    let near = 0;
    points.forEach(([px, py], i) => {
      const d = Math.hypot(
        Math.max(x0 - px, 0, px - x1),
        Math.max(bottom - py, 0, py - top),
      );
      const move = now[2 * i] - was[2 * i];
      expect(now[2 * i + 1]).toBe(was[2 * i + 1]);
      if (d === 0) {
        expect(Math.abs(move - full)).toBeLessThanOrEqual(GRID_TOL);
      } else if (d < fall) {
        expect(move).toBeGreaterThanOrEqual(0);
        expect(move).toBeLessThan(full);
        past.push({ d, move });
      } else {
        expect(move).toBe(0);
      }
      if (d < fall) near++;
    });
    // Points past the region moved, the farther the less (each move is
    // rounded to 0.1 px).
    expect(past.length).toBeGreaterThan(0);
    past.sort((p, q) => p.d - q.d);
    for (let k = 1; k < past.length; k++) {
      expect(past[k].move).toBeLessThanOrEqual(past[k - 1].move + 0.1 + 1e-9);
    }
    expect(past[0].move).toBeGreaterThan(past[past.length - 1].move);
    expect(patches![0].moved).toBe(near);
  });

  it("moves a part's vertices inside the region at that keyform only", () => {
    expect(faceInside.length).toBeGreaterThan(0);
    const { model } = rig([faceOp]);
    const face = partOf(base.model, "face");
    const was = keyformOf(base.model, "face", P.AngleX, -30).offsets;
    const now = keyformOf(model, "face", P.AngleX, -30).offsets;
    faceFractions.forEach((_, i) => {
      const dx = now[2 * i] - was[2 * i];
      const dy = now[2 * i + 1] - was[2 * i + 1];
      if (faceInside.includes(i)) {
        // In the part's local units: its box's width and height.
        expect(Math.abs(dx - (0.01 * FACE_W) / face.width)).toBeLessThanOrEqual(
          PART_TOL,
        );
        // Down on screen is down in the model.
        expect(
          Math.abs(dy + (0.02 * FACE_W) / face.height),
        ).toBeLessThanOrEqual(PART_TOL);
      } else {
        expect([dx, dy]).toEqual([0, 0]);
      }
    });
    const rest = keyformOf(model, "face", P.AngleX, 0).offsets;
    expect(rest.every((o) => o === 0)).toBe(true);
    const restored = structuredClone(model);
    keyformOf(restored, "face", P.AngleX, -30).offsets = was;
    expect(restored).toEqual(base.model);
  });

  it("gives the same rig whatever order the ops come in", () => {
    const corner: RigPatch = {
      target: "eyeWarp_R",
      at: R30,
      region: { role: "eye_R", x: [0.5, 1], y: [0, 0.5] },
      by: { dx: -0.013, dy: 0.007 },
      falloff: 0.07,
    };
    expect(JSON.stringify(rig([gridOp, corner]).model)).toBe(
      JSON.stringify(rig([corner, gridOp]).model),
    );
    // Three ops at one point, end to end. On this fixture — a 401 px face,
    // and y offsets of 0 inside the eye at this stop — they add to 20.05 px
    // down, a rounding tie a plain left-to-right sum breaks by order (−20.1
    // here, −20 in the other). A fixture change can lose the tie; the
    // `applyPatches` tests below hold it on numbers of their own.
    const [a, b, c] = [0.012, 0.017, 0.021].map(
      (dy): RigPatch => ({
        target: "eyeWarp_R",
        at: R30,
        region: { role: "eye_R", ...WHOLE },
        by: { dx: 0, dy },
      }),
    );
    expect(JSON.stringify(rig([a, b, c]).model)).toBe(
      JSON.stringify(rig([c, a, b]).model),
    );
  });

  it("echoes what each op moved", () => {
    const { points, cols } = gridOf(base.model, "eyeWarp_R");
    const col = gridInside.map((k) => k % (cols + 1));
    const row = gridInside.map((k) => Math.floor(k / (cols + 1)));
    const px = (dx: number, dy: number) =>
      Math.round(Math.hypot(dx, dy) * FACE_W * 10) / 10;
    expect(rig([gridOp, faceOp]).patches).toEqual([
      {
        index: 0,
        target: "eyeWarp_R",
        at: R30,
        moved: gridInside.length,
        of: points.length,
        cols: [Math.min(...col), Math.max(...col)],
        rows: [Math.min(...row), Math.max(...row)],
        maxPx: px(0.01, -0.005),
      },
      {
        index: 1,
        target: "face",
        at: { [P.AngleX]: -30 },
        moved: faceInside.length,
        of: faceFractions.length,
        maxPx: px(0.01, 0.02),
      },
    ]);
  });

  it("reports the turn of the patched rig", () => {
    // The eyes ride +x at AngleX 30 and −x at −30: each op takes 0.02 face
    // widths (8 px) back toward the axis off one eye at one stop, about 4 px
    // off the pair's mean, 0.015 of the 262 px head half-width.
    const inward = (side: "L" | "R", ax: number, dx: number): RigPatch => ({
      target: `eyeWarp_${side}`,
      at: { [P.AngleX]: ax, [P.AngleY]: 0 },
      region: { role: `eye_${side}`, ...WHOLE },
      by: { dx, dy: 0 },
      falloff: 0.1,
    });
    const { turn } = rig([inward("L", 30, -0.02), inward("R", -30, 0.02)]);
    expect(turn!.achieved.eyeShift).toBeLessThan(
      base.turn!.achieved.eyeShift - 0.01,
    );
  });
});

describe("rig patches: refusals", () => {
  /** The `PatchError` op `patches[0]` is refused with. */
  function refusal(op: unknown): string {
    let thrown: unknown;
    try {
      rig([op as RigPatch]);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(PatchError);
    const { message } = thrown as PatchError;
    expect(message.startsWith("patches[0]")).toBe(true);
    return message;
  }

  it("refuses an unknown target, listing the patchable ones", () => {
    const message = refusal({ ...gridOp, target: "eyeWarp_X" });
    for (const id of ["eyeWarp_L", "eyeWarp_R", "mouthWarp", "face"]) {
      expect(message).toContain(id);
    }
  });

  it("refuses a stop the grid has not, naming its stops", () => {
    expect(
      refusal({ ...gridOp, at: { [P.AngleX]: -15, [P.AngleY]: 0 } }),
    ).toContain("[-30, 0, 30]");
    // A grid's stop names both angles.
    expect(refusal({ ...gridOp, at: { [P.AngleX]: -30 } })).toContain(P.AngleY);
  });

  it("refuses a grid's rest stop, pointing at the ±30 stops", () => {
    expect(
      refusal({ ...gridOp, at: { [P.AngleX]: 0, [P.AngleY]: 0 } }),
    ).toContain("±30");
  });

  it("refuses a part's rest stop, naming its other stops and its grid", () => {
    const message = refusal({
      target: "lash_L",
      at: { [P.EyeOpenLeft]: 1 },
      region: { role: "lash_L", ...WHOLE },
      by: { dx: 0, dy: 0.01 },
    });
    expect(message).toContain(`${P.EyeOpenLeft}@0`);
    expect(message).toContain("eyeWarp_L");
  });

  it("refuses the stop where the rig shuts a part, but not a lash's", () => {
    const shut = (target: string): RigPatch => ({
      target,
      at: { [P.EyeOpenLeft]: 0 },
      region: { role: target, ...WHOLE },
      by: { dx: 0, dy: 0.01 },
    });
    expect(refusal(shut("eye_L"))).toContain("eyeWarp_L");
    expect(rig([shut("lash_L")]).patches![0].moved).toBeGreaterThan(0);
  });

  it("refuses a part's stop that names two parameters, listing its stops", () => {
    expect(
      refusal({ ...faceOp, at: { [P.AngleX]: -30, [P.AngleY]: 30 } }),
    ).toContain(`${P.AngleX}@-30,0,30`);
  });

  it("refuses a role the set has not, listing its roles", () => {
    const message = refusal({
      ...gridOp,
      region: { role: "tail", ...WHOLE },
    });
    expect(message).toContain('"tail"');
    for (const role of ["face", "eye_R", "hair_front"]) {
      expect(message).toContain(role);
    }
  });

  it("refuses a region that catches no point, quoting the target's extent", () => {
    const { points } = gridOf(base.model, "eyeWarp_R");
    const b = boxOfLayer(layerOf("eye_R"));
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const range = (v: number[]) =>
      `[${r2(Math.min(...v))}, ${r2(Math.max(...v))}]`;
    const fx = points.map(([x]) => (x - b.x0) / (b.x1 - b.x0));
    const fy = points.map(([, y]) => (b.y1 - y) / (b.y1 - b.y0));
    expect(
      refusal({ ...gridOp, region: { role: "eye_R", x: [2, 3], y: [0, 1] } }),
    ).toContain(`x ${range(fx)}, y ${range(fy)} of eye_R's box`);
  });

  it("refuses an unknown key, listing the known ones", () => {
    const message = refusal({ ...gridOp, size: 2 });
    expect(message).toContain("patches[0].size");
    expect(message).toContain("falloff");
    expect(refusal({ ...gridOp, by: { dx: 0.01, dy: 0, dz: 1 } })).toContain(
      "patches[0].by.dz is not one of dx, dy",
    );
  });

  it("refuses a number that is not finite", () => {
    expect(
      refusal({ ...gridOp, by: { dx: Number.POSITIVE_INFINITY, dy: 0 } }),
    ).toMatch(/^patches\[0\]\.by\.dx must be a finite number/);
  });
});

describe("applyPatches", () => {
  const BOX: Box = { x0: -1, x1: 1, y0: -1, y1: 1 };

  /** The x offset `dxs` leave on a one-point grid's (−30, 0) keyform, from
   *  0: under a face 1 px wide, each `dx` is a term of exactly that many px. */
  function applied(dxs: number[]): number {
    const keyforms = Array.from({ length: 9 }, () => [0, 0]);
    applyPatches(
      dxs.map((dx) => ({
        target: "g",
        at: R30,
        region: { role: "r", ...WHOLE },
        by: { dx, dy: 0 },
      })),
      {
        grids: new Map([
          [
            "g",
            {
              lattice: { box: BOX, cols: 0, rows: 0, points: [0, 0] },
              keyforms,
            },
          ],
        ]),
        parts: [],
        boxOf: (role) => (role === "r" ? BOX : undefined),
        faceWidth: 1,
        parameters: [],
      },
    );
    return keyforms[
      Y_STOPS.indexOf(0) * X_STOPS.length + X_STOPS.indexOf(-30)
    ][0];
  }

  const orders = (v: number[]): number[][] =>
    v.length <= 1
      ? [v]
      : v.flatMap((x, i) =>
          orders([...v.slice(0, i), ...v.slice(i + 1)]).map((o) => [x, ...o]),
        );
  const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);

  it("sums an offset's terms the same way whatever order the ops come in", () => {
    const terms = [0.1, 0.2, 0.05];
    // They add to 0.35, a tie of the 0.1 px rounding: added left to right,
    // some orders land just above it (0.4) and some just below (0.3).
    const naive = new Set(orders(terms).map((o) => roundTo(sum(o), 0.1)));
    expect([...naive].sort()).toEqual([0.3, 0.4]);
    const sorted = roundTo(sum([...terms].sort((a, b) => a - b)), 0.1);
    for (const o of orders(terms)) expect(applied(o)).toBe(sorted);
  });

  it("rounds an offset once, after summing its terms", () => {
    // Rounded per op, each 0.04 would round away to 0.
    expect(applied([0.04, 0.04])).toBe(0.1);
  });
});
