import { describe, expect, it } from "vitest";
import { StandardParameter as P, parseIkiModel } from "@ikijs/format";
import {
  generateIkiFromLayerSet,
  parseLayerRoles,
  partIdsOfRole,
} from "@ikijs/editor";
import { solveContext } from "../src/auto-rig/context";
import { buildHeadFrame } from "../src/auto-rig/head";
import {
  gridMesh,
  boxOfLayer,
  bh,
  bw,
  cellsFor,
  cy,
  meshPoints,
  unionBoxes,
} from "../src/auto-rig/layout";
import { mouthForm, mouthFrameOf, mouthWiden } from "../src/auto-rig/drivers";
import {
  END_TAPER,
  END_TAPER_FROM,
  FLICK_PULL,
  FLICK_SQUASH,
  LIP_ROLES,
  MOUTH_KNOT_PX,
  UPPER_SHARE,
  UPPER_THIN,
  buildMouthRig,
  columnOfKnot,
  mouthAnchor,
  mouthFold,
  mouthFoldWarp,
  mouthKnots,
  mouthMesh,
  mouthOpening,
  mouthRestShift,
} from "../src/auto-rig/mouth";
import { LayerGeometryError, type LayerInput } from "../src/auto-rig/types";
import { AMPLITUDE } from "../src/auto-rig/profile";
import { CANVAS, character } from "./helpers/character";
import * as oracle from "./helpers/render-oracle";
import {
  OPENING,
  heightAt,
  lipSet,
  topRow,
  type LipOptions,
} from "./helpers/lips";

const mapOf = (layers: LayerInput[]) => new Map(layers.map((l) => [l.role, l]));
const lips = (o?: LipOptions) => mapOf(lipSet(o));
/** `layer` with column `col` cleared on the rows `rows` of its crop. */
function cut(
  layer: LayerInput,
  col: number,
  rows: (k: number) => boolean,
): LayerInput {
  return {
    ...layer,
    rowRuns: layer.rowRuns!.map((runs, k) => {
      if (!rows(k)) return runs;
      const out: number[] = [];
      for (let i = 0; i < runs.length; i += 2) {
        const [a, b] = [runs[i], runs[i + 1]];
        if (col < a || col >= b) out.push(a, b);
        else {
          if (col > a) out.push(a, col);
          if (col + 1 < b) out.push(col + 1, b);
        }
      }
      return out;
    }),
  };
}

const COLS = Array.from(
  { length: OPENING.x1 - OPENING.x0 + 1 },
  (_, i) => OPENING.x0 + i,
);

describe("mouth.ts: the opening", () => {
  it("reads the opening's columns and each column's boundaries in model y", () => {
    const op = mouthOpening(lips());
    expect([op.x0, op.x1]).toEqual([470, 529]);
    for (const x of COLS) {
      const c = op.at(x);
      const h = heightAt(x);
      expect(c.T).toBe(500 - topRow(x));
      expect(c.Bb).toBe(500 - (topRow(x) + h + 2));
      expect(c.Tu).toBe(c.T);
      expect(c.lineTop).toBe(500 - (topRow(x) - 3));
      expect(c.lineH).toBe(3);
      expect(c.Bl).toBe(c.Bb);
      expect(c.H).toBe(h + 2);
      // The stroke thinned, at the share that puts it at the closed line's
      // top: the whole of it at the centre, less toward the tapered ends.
      expect(c.overlap).toBeCloseTo(
        (UPPER_THIN * 3 * (1 + op.line(x)!.squash)) / 2,
        9,
      );
    }
    expect(op.w).toBe(3);
    expect(op.at(op.centre).overlap).toBeCloseTo(UPPER_THIN * 3, 9);
    expect(op.at(470).overlap).toBeLessThan(op.at(480).overlap);
    expect(op.at(529).overlap).toBeLessThan(op.at(520).overlap);
    // The closing travel is pinned to the drawn line at the end columns and
    // smooth between: the raw per-column travel has the rounding steps of the
    // integer-row reads, which the fit removes.
    const travel = (x: number) => op.at(x).seam - op.at(x).Tu;
    const rawTravel = (x: number) => {
      const r = op.at(x);
      return r.T - UPPER_SHARE * r.H - r.Tu;
    };
    const curvature = (f: (x: number) => number) =>
      Math.max(
        ...COLS.slice(1, -1).map((x) =>
          Math.abs(f(x - 1) - 2 * f(x) + f(x + 1)),
        ),
      );
    expect(travel(470)).toBeCloseTo(0, 9);
    expect(travel(529)).toBeCloseTo(0, 9);
    expect(curvature(travel)).toBeLessThanOrEqual(0.05);
    expect(curvature(rawTravel)).toBeGreaterThanOrEqual(0.25);
    expect(curvature(rawTravel)).toBeGreaterThanOrEqual(5 * curvature(travel));
    const c = op.at(499);
    expect(Math.abs(c.seam - (c.T - UPPER_SHARE * c.H))).toBeLessThan(2);
    // Lower in model y than both ends: the fixture's U is deeper than its ∩.
    expect(c.seam).toBeLessThan(op.at(470).seam);
    expect(c.seam).toBeLessThan(op.at(529).seam);
  });

  it("reads a gap column as its left neighbour, which wins a tie", () => {
    const layers = lipSet();
    layers[0] = cut(layers[0], 480, () => true);
    const op = mouthOpening(mapOf(layers));
    const whole = mouthOpening(lips());
    // Columns 479 and 481 differ (the interior is 16 and 17 rows high).
    const { seam: _a, ...gap } = op.at(480);
    const { seam: _b, ...left } = whole.at(479);
    const { seam: _c, ...right } = whole.at(481);
    expect(gap).toEqual(left);
    expect(gap).not.toEqual(right);
    // Its travel is the curve's own value at 480, not the neighbour's.
    const travel = (o: typeof op, x: number) => o.at(x).seam - o.at(x).Tu;
    expect(Math.abs(travel(op, 480) - travel(whole, 480))).toBeLessThanOrEqual(
      0.05,
    );
    expect(Math.abs(travel(op, 480) - travel(op, 479))).toBeGreaterThan(0.1);
    expect([op.x0, op.x1]).toEqual([470, 529]);
  });

  it("spans several interior runs in one column, first top to last bottom", () => {
    const base = mouthOpening(lips()).at(499);
    const layers = lipSet();
    // Clear one row in the middle of column 499's interior.
    layers[0] = cut(layers[0], 499, (k) => k === 10);
    const c = mouthOpening(mapOf(layers)).at(499);
    expect([c.T, c.Bb, c.H]).toEqual([base.T, base.Bb, base.H]);
  });

  it("reads a column outside the opening as the nearest one", () => {
    const op = mouthOpening(lips());
    expect(op.at(460)).toEqual(op.at(470));
    expect(op.at(540)).toEqual(op.at(529));
  });

  it("reads the skin's overlap and the interior under the line's ink", () => {
    const skin = mouthOpening(lips({ skinOverlap: true })).at(499);
    expect(skin.Bl).toBe(skin.Bb + 1);
    const base = mouthOpening(lips()).at(499);
    const op = mouthOpening(lips({ underLine: true }));
    const c = op.at(499);
    expect(c.T).toBe(c.Tu + 1);
    expect([c.lineH, op.w]).toEqual([3, 3]);
    expect(c.overlap).toBeCloseTo(UPPER_THIN * 3, 9);
    expect(c.H).toBe(base.H + 1);
  });

  it("reads the line at every column of lip_upper, the taper's squash with it", () => {
    const op = mouthOpening(lips());
    const from = END_TAPER_FROM * ((OPENING.x1 - OPENING.x0 + 1) / 2);
    for (const x of COLS) {
      const c = op.at(x);
      const l = op.line(x)!;
      expect([l.bottom, l.top]).toEqual([c.Tu, c.lineTop]);
      if (Math.abs(x - op.centre) <= from) expect(l.squash).toBe(1);
      else {
        expect(l.squash).toBeLessThan(1);
        // The ramp ends at the line's box edge, past the hooks.
        expect(l.squash).toBeGreaterThan(END_TAPER);
      }
    }
    // A hook: its own ink span, rows 590..596, and the flick's squash.
    for (const x of [464, 469, 530, 535]) {
      expect(op.line(x)).toEqual({
        bottom: 500 - 596,
        top: 500 - 590,
        squash: FLICK_SQUASH,
      });
    }
    for (const x of [450, 463, 536]) expect(op.line(x)).toBeUndefined();
    // Without hooks the box edge is the opening's end: the full taper there.
    const bare = mouthOpening(lips({ noHooks: true }));
    expect(bare.line(470)!.squash).toBeCloseTo(END_TAPER, 9);
    expect(bare.line(529)!.squash).toBeCloseTo(END_TAPER, 9);
    expect(bare.line(469)).toBeUndefined();
  });

  it("pins the travel to zero at the end columns whatever the wall under the line", () => {
    const wall = mouthOpening(lips({ grownInner: true }));
    expect([wall.x0, wall.x1]).toEqual([469, 530]);
    for (const x of [469, 530]) {
      const c = wall.at(x);
      expect(c.Tu).toBeLessThan(c.T);
      expect(c.seam - c.Tu).toBeCloseTo(0, 9);
      // The interior's closed point sits under the still wall's ink.
      expect(c.seam + c.overlap).toBeLessThanOrEqual(c.lineTop);
    }
    const under = mouthOpening(lips({ underLine: true }));
    for (const x of [470, 529]) {
      expect(under.at(x).seam - under.at(x).Tu).toBeCloseTo(0, 9);
    }
  });

  it("refuses an interior with no opaque pixel", () => {
    const layers = lipSet();
    layers[0] = { ...layers[0], rowRuns: layers[0].rowRuns!.map(() => []) };
    expect(() => mouthOpening(mapOf(layers))).toThrow(LayerGeometryError);
    expect(() => mouthOpening(mapOf(layers))).toThrow(/mouth_inner/);
  });
});

describe("mouth.ts: the fold", () => {
  // The last: a 6-row wall under a 1-row stroke, where the taper takes more
  // off the wall's closed height than the stroke tucks up.
  for (const o of [
    {},
    { underLine: true },
    { thinLine: true, grownInner: true },
  ] as LipOptions[]) {
    const label = JSON.stringify(o);
    it(`lands every part on the seam at v 0 ${label}`, () => {
      const op = mouthOpening(lips(o));
      const upper = mouthFold("lip_upper", op);
      const lower = mouthFold("lip_lower", op);
      const inner = mouthFold("mouth_inner", op);
      for (const x of COLS) {
        const c = op.at(x);
        // Before the taper's ramp; past it the closed line's bottom rises
        // toward its centre row.
        if (op.line(x)!.squash === 1)
          expect(c.Tu + upper(x, c.Tu, 0)[1]).toBeCloseTo(c.seam, 9);
        expect(c.Bl + lower(x, c.Bl, 0)[1]).toBeCloseTo(c.seam + c.overlap, 9);
        const top = c.T + inner(x, c.T, 0)[1];
        const bottom = c.Bb + inner(x, c.Bb, 0)[1];
        // Shut the interior has no height, on the skin's top edge.
        expect(top).toBeCloseTo(c.seam + c.overlap, 9);
        expect(bottom).toBeCloseTo(c.seam + c.overlap, 9);
        expect(c.seam + c.overlap).toBeLessThanOrEqual(c.seam + c.lineH + 1e-9);
      }
      // The skin's top inside the line's closed ink at every column of the
      // opening, its walls and the taper's ramp included.
      for (let x = op.x0; x <= op.x1; x++) {
        const c = op.at(x);
        const skin = c.Bl + lower(x, c.Bl, 0)[1];
        expect(skin).toBeGreaterThanOrEqual(c.Tu + upper(x, c.Tu, 0)[1] - 1e-9);
        expect(skin).toBeLessThanOrEqual(
          c.lineTop + upper(x, c.lineTop, 0)[1] + 1e-9,
        );
      }
    });
  }

  it("gives the line no travel at a wall end column and folds the rest under it", () => {
    const op = mouthOpening(lips({ grownInner: true }));
    const upper = mouthFold("lip_upper", op);
    const lower = mouthFold("lip_lower", op);
    const inner = mouthFold("mouth_inner", op);
    for (const x of [469, 530]) {
      const c = op.at(x);
      const { squash } = op.line(x)!;
      for (const v of [0, 0.3, 0.7, 1]) {
        // The bottom edge moves by the closed taper alone, toward the
        // thinned line's centre row.
        expect(upper(x, c.Tu, v)[1]).toBeCloseTo(
          ((1 - v) * (1 - squash) * UPPER_THIN * c.lineH) / 2,
          9,
        );
      }
      // The skin lands under the line (the landing contract, not stillness).
      expect(c.Bl + lower(x, c.Bl, 0)[1]).toBeCloseTo(c.seam + c.overlap, 9);
      expect(c.T + inner(x, c.T, 0)[1]).toBeCloseTo(c.seam + c.overlap, 9);
      expect(c.Bb + inner(x, c.Bb, 0)[1]).toBeCloseTo(c.seam + c.overlap, 9);
      expect(c.T + inner(x, c.T, 0.05)[1]).toBeLessThanOrEqual(c.lineTop);
    }
  });

  it("is the art as drawn at v 1 but for the thin", () => {
    for (const o of [{}, { underLine: true }] as LipOptions[]) {
      const op = mouthOpening(lips(o));
      const [upper, lower, inner] = (
        ["lip_upper", "lip_lower", "mouth_inner"] as const
      ).map((r) => mouthFold(r, op));
      for (const x of COLS) {
        const { T, Tu } = op.at(x);
        for (const y of [T, Tu, Tu - 2]) {
          const thin = -(1 - UPPER_THIN) * Math.max(0, y - Tu);
          // The interior: zero at and below the line's bottom, the thin above
          // it (its top on `underLine`, up inside the line's ink).
          expect(inner(x, y, 1)[0]).toBe(0);
          expect(inner(x, y, 1)[1]).toBeCloseTo(thin, 9);
          expect(lower(x, y, 1)[0]).toBe(0);
          expect(lower(x, y, 1)[1]).toBeCloseTo(0, 9);
          // The line's column is squashed toward its bottom as a whole.
          expect(upper(x, y, 1)[0]).toBe(0);
          expect(upper(x, y, 1)[1]).toBeCloseTo(
            -(1 - UPPER_THIN) * (y - Tu),
            9,
          );
        }
      }
    }
  });

  it("thins the stack above the line's bottom at every key", () => {
    const op = mouthOpening(lips());
    const upper = mouthFold("lip_upper", op);
    for (const x of COLS) {
      const c = op.at(x);
      expect(upper(x, c.Tu, 1)[1]).toBeCloseTo(0, 9);
      expect(upper(x, c.lineTop, 1)[1]).toBeCloseTo(
        -(1 - UPPER_THIN) * c.lineH,
        9,
      );
      // Where the closed key does not taper, the line keeps the thinned
      // height at every key.
      if (op.line(x)!.squash < 1) continue;
      for (const v of [0, 0.5]) {
        const height =
          c.lineTop + upper(x, c.lineTop, v)[1] - (c.Tu + upper(x, c.Tu, v)[1]);
        expect(height).toBeCloseTo(UPPER_THIN * c.lineH, 9);
      }
    }
    // The interior tucked up inside the line's ink comes down with it.
    const under = mouthOpening(lips({ underLine: true }));
    const inner = mouthFold("mouth_inner", under);
    const line = mouthFold("lip_upper", under);
    for (const x of COLS) {
      const c = under.at(x);
      const top = c.T + inner(x, c.T, 1)[1];
      expect(top - c.Tu).toBeCloseTo(UPPER_THIN * (c.T - c.Tu), 9);
      expect(top).toBeLessThan(c.lineTop + line(x, c.lineTop, 1)[1]);
    }
  });

  it("shapes the closed line: on the seam inside the taper, tapered at the box edge", () => {
    const op = mouthOpening(lips());
    const upper = mouthFold("lip_upper", op);
    const from = END_TAPER_FROM * ((OPENING.x1 - OPENING.x0 + 1) / 2);
    for (const x of COLS) {
      if (Math.abs(x - op.centre) > from) continue;
      const c = op.at(x);
      expect(c.Tu + upper(x, c.Tu, 0)[1]).toBeCloseTo(c.seam, 9);
    }
    // Without hooks the line's box edge is the opening's end column, where
    // the travel is pinned to zero.
    const bare = mouthOpening(lips({ noHooks: true }));
    const shut = mouthFold("lip_upper", bare);
    for (const x of [470, 529]) {
      const c = bare.at(x);
      const bottom = c.Tu + shut(x, c.Tu, 0)[1];
      const top = c.lineTop + shut(x, c.lineTop, 0)[1];
      expect(top - bottom).toBeCloseTo(END_TAPER * UPPER_THIN * c.lineH, 9);
      expect((top + bottom) / 2).toBeCloseTo(
        c.Tu + (UPPER_THIN * c.lineH) / 2,
        9,
      );
    }
  });

  for (const o of [
    {},
    { skinOverlap: true },
    { underLine: true },
  ] as LipOptions[]) {
    it(`keeps the interior between the lips at v 0.5 ${JSON.stringify(o)}`, () => {
      const op = mouthOpening(lips(o));
      const upper = mouthFold("lip_upper", op);
      const lower = mouthFold("lip_lower", op);
      const inner = mouthFold("mouth_inner", op);
      for (const x of COLS) {
        const c = op.at(x);
        const top = c.T + inner(x, c.T, 0.5)[1];
        const bottom = c.Bb + inner(x, c.Bb, 0.5)[1];
        const lineBottom = c.Tu + upper(x, c.Tu, 0.5)[1];
        const lineTop = c.lineTop + upper(x, c.lineTop, 0.5)[1];
        const skinTop = c.Bl + lower(x, c.Bl, 0.5)[1];
        // The top rides w'(1 - v) above the line's bottom, plus the thinned
        // tuck on `underLine`, under its ink (past the taper's start the
        // line's bottom rises toward its centre row, so only under its ink).
        if (op.line(x)!.squash === 1)
          expect(top - lineBottom).toBeCloseTo(
            0.5 * c.overlap + 0.5 * UPPER_THIN * (c.T - c.Tu),
            9,
          );
        expect(top).toBeLessThan(lineTop);
        expect(skinTop - bottom).toBeCloseTo(o.skinOverlap ? 0.5 : 0, 9);
        expect(top - bottom).toBeCloseTo(
          (c.H - (1 - UPPER_THIN) * (c.T - c.Tu)) / 2,
          9,
        );
      }
    });
  }

  it("scales the interior's height by v, never inverted", () => {
    for (const o of [{}, { thinLine: true }] as LipOptions[]) {
      const op = mouthOpening(lips(o));
      const inner = mouthFold("mouth_inner", op);
      for (const x of COLS) {
        const c = op.at(x);
        for (const v of [0, 0.01, 0.3, 1]) {
          const height =
            c.T + inner(x, c.T, v)[1] - (c.Bb + inner(x, c.Bb, v)[1]);
          expect(height).toBeCloseTo(v * c.H, 9);
        }
      }
    }
    const thin = mouthOpening(lips({ thinLine: true }));
    expect(thin.at(499).overlap).toBeCloseTo(UPPER_THIN, 9);
  });

  it("leaves the lower hook still, shapes the line's flick, reads the nearest column for the interior", () => {
    const op = mouthOpening(lips());
    const upper = mouthFold("lip_upper", op);
    const lower = mouthFold("lip_lower", op);
    const inner = mouthFold("mouth_inner", op);
    for (const v of [0, 0.3, 0.7, 1]) {
      expect(lower(466, -98, v)).toEqual([0, 0]);
      expect(inner(466, op.at(470).T, v)).toEqual(inner(470, op.at(470).T, v));
    }
    // The hooks' ink spans rows 590..596: model y −96 (bottom) to −90 (top).
    const [bottom, top] = [-96, -90];
    // Each hook column with its opening's end boundary, x0 or x1 + 1.
    for (const [x, end] of [
      [466, 470],
      [533, 530],
    ]) {
      // At 1 the thin alone: the top comes down, the bottom stays, no pull.
      const [b1, t1] = [upper(x, bottom, 1), upper(x, top, 1)];
      for (const p of [b1, t1]) expect(p[0]).toBeCloseTo(0, 9);
      expect(b1[1]).toBeCloseTo(0, 9);
      expect(t1[1]).toBeCloseTo(-(1 - UPPER_THIN) * 6, 9);
      // At 0 pulled toward the corner and squashed about its thinned centre
      // row; no travel.
      const [b0, t0] = [upper(x, bottom, 0), upper(x, top, 0)];
      for (const p of [b0, t0])
        expect(p[0]).toBeCloseTo((1 - FLICK_PULL) * (end - x), 9);
      expect(top + t0[1] - (bottom + b0[1])).toBeCloseTo(
        FLICK_SQUASH * UPPER_THIN * 6,
        9,
      );
      expect((top + t0[1] + bottom + b0[1]) / 2).toBeCloseTo(
        bottom + UPPER_THIN * 3,
        9,
      );
    }
    // The line's box margin past its last column moves with the last hook
    // column it shares a cell with.
    const margin = mouthOpening(lips({ grown: true }));
    const grownFold = mouthFold("lip_upper", margin);
    expect(margin.line(536)).toBeUndefined();
    expect(grownFold(536, top, 0)[1]).toBeCloseTo(grownFold(535, top, 0)[1], 9);
  });

  it("rides the teeth on the line and the tongue on the interior's bottom, rigid per column", () => {
    const op = mouthOpening(lips());
    const [upper, inner, teeth, tongue] = (
      ["lip_upper", "mouth_inner", "mouth_teeth", "mouth_tongue"] as const
    ).map((r) => mouthFold(r, op));
    for (const x of COLS) {
      const c = op.at(x);
      for (const v of [0, 0.3, 0.7, 1]) {
        // The line's travel alone at its bottom edge: lip_upper's own move
        // there wherever the closed key does not taper it.
        expect(teeth(x, c.Tu, v)[1]).toBeCloseTo((c.seam - c.Tu) * (1 - v), 9);
        if (op.line(x)!.squash === 1)
          expect(teeth(x, c.Tu, v)[1]).toBeCloseTo(upper(x, c.Tu, v)[1], 9);
        // Rigid below the line's bottom: one number down the column.
        for (const y of [c.Tu - 1, c.Tu - 5, c.Bb])
          expect(teeth(x, y, v)).toEqual(teeth(x, c.Tu, v));
        // The interior's bottom edge's travel, at any row.
        expect(tongue(x, c.Bb, v)[1]).toBeCloseTo(inner(x, c.Bb, v)[1], 9);
        expect(tongue(x, c.Tu - 3, v)).toEqual(tongue(x, c.Bb, v));
        expect(teeth(x, c.Tu, v)[0]).toBe(0);
        expect(tongue(x, c.Bb, v)[0]).toBe(0);
      }
      // At 1 nothing moves at or below the line's bottom; above it the
      // stack's thin, which the tongue never reaches.
      for (const y of [c.Tu, c.Tu - 2, c.Bb]) {
        expect(teeth(x, y, 1)[1]).toBeCloseTo(0, 9);
        expect(tongue(x, y, 1)[1]).toBeCloseTo(0, 9);
      }
      expect(teeth(x, c.Tu + 2, 1)[1]).toBeCloseTo(-(1 - UPPER_THIN) * 2, 9);
    }
    // Off the opening, the nearest column.
    for (const v of [0, 0.5, 1]) {
      const [a, b] = [op.at(470), op.at(529)];
      expect(teeth(466, a.Tu + 1, v)).toEqual(teeth(470, a.Tu + 1, v));
      expect(teeth(533, b.Tu + 1, v)).toEqual(teeth(529, b.Tu + 1, v));
      expect(tongue(466, a.Bb, v)).toEqual(tongue(470, a.Bb, v));
      expect(tongue(533, b.Bb, v)).toEqual(tongue(529, b.Bb, v));
    }
    // The teeth from the interior's top, up inside the line's ink: their top
    // lands where the interior's does at 1, and rides the line's bottom by
    // that thinned height at every key.
    const under = mouthOpening(lips({ underLine: true, inside: true }));
    const [line, cavity, top] = (
      ["lip_upper", "mouth_inner", "mouth_teeth"] as const
    ).map((r) => mouthFold(r, under));
    for (const x of COLS) {
      const c = under.at(x);
      expect(c.T).toBe(c.Tu + 1);
      expect(c.T + top(x, c.T, 1)[1]).toBeCloseTo(
        c.T + cavity(x, c.T, 1)[1],
        9,
      );
      if (under.line(x)!.squash < 1) continue;
      for (const v of [0, 0.5])
        expect(
          c.T + top(x, c.T, v)[1] - (c.Tu + line(x, c.Tu, v)[1]),
        ).toBeCloseTo(UPPER_THIN * (c.T - c.Tu), 9);
    }
  });
});

describe("drivers.ts: the shared mouth frame", () => {
  const box = { x0: -30, x1: 30, y0: -10, y1: 8 };
  const mesh = gridMesh(6, 2);
  it("defaults to the part's own box, as the legacy mouth had it", () => {
    // The corner (x1, row 0) at Form 1 and at full open, from the formulas.
    const corner = 6;
    const form = mouthForm(mesh, box).keyforms.find((f) => f.value === 1)!;
    expect(form.offsets[2 * corner] * bw(box)).toBeCloseTo(0.05 * 30, 3);
    expect(form.offsets[2 * corner + 1] * bh(box)).toBeCloseTo(
      0.3 * bh(box) * (1 - 0.3),
      3,
    );
    const widen = mouthWiden(mesh, box).keyforms.find((f) => f.value === 1)!;
    expect(widen.offsets[2 * corner] * bw(box)).toBeCloseTo(
      (AMPLITUDE.mouthOpenWidth - 1) * 30,
      3,
    );
    expect(mouthForm(mesh, box)).toEqual(
      mouthForm(mesh, box, mouthFrameOf(box)),
    );
    expect(mouthWiden(mesh, box)).toEqual(
      mouthWiden(mesh, box, mouthFrameOf(box)),
    );
  });

  it("moves a vertex at the same x the same, whatever the box", () => {
    const frame = { c: 5, half: 35, amp: 4 };
    const other = { x0: -10, x1: 40, y0: -20, y1: 10 };
    const offsets = (b: typeof box, m: typeof mesh, make: typeof mouthForm) => {
      const i = meshPoints(m, b).findIndex(([x]) => Math.abs(x - 10) < 1e-3);
      const k = make(m, b, frame).keyforms.find((f) => f.value === 1)!.offsets;
      return [k[2 * i] * bw(b), k[2 * i + 1] * bh(b)];
    };
    for (const make of [mouthForm, mouthWiden]) {
      const a = offsets(box, mesh, make);
      const b = offsets(other, gridMesh(5, 2), make);
      expect(a[0]).toBeCloseTo(b[0], 2);
      expect(a[1]).toBeCloseTo(b[1], 2);
    }
  });
});

describe("mouth.ts: knots and meshes", () => {
  const map = lips();
  const rig = buildMouthRig(map);

  it("cuts shared integer knots over the union, with the opening's boundaries", () => {
    const k = rig.knots.map((x) => x + 500);
    expect(k[0]).toBe(464);
    expect(k[k.length - 1]).toBe(536);
    expect(k).toContain(470);
    expect(k).toContain(529);
    expect(k).toContain(530);
    k.forEach((c, i) => {
      expect(Number.isInteger(c)).toBe(true);
      if (i > 0) {
        expect(c - k[i - 1]).toBeGreaterThan(0);
        // A width one past a multiple of the pitch leaves a last cell of 5.
        expect(c - k[i - 1]).toBeLessThanOrEqual(MOUTH_KNOT_PX + 1);
      }
    });
    expect(rig.union).toEqual(
      unionBoxes(LIP_ROLES.map((r) => boxOfLayer(map.get(r)!))),
    );
  });

  it("keeps the union's edges and the opening's boundaries as knots", () => {
    const op = rig.opening;
    // Boundaries 1 px inside the edges, and a width one past a multiple of 4.
    for (const union of [
      { x0: -31, x1: 31, y0: 0, y1: 1 },
      { x0: -36, x1: 37, y0: 0, y1: 1 },
      // The last grid knot is 28, so 30 sits next to the edge 31.
      { x0: -36, x1: 31, y0: 0, y1: 1 },
    ]) {
      const k = mouthKnots(union, op);
      for (const x of [union.x0, union.x1, -30, 29, 30]) expect(k).toContain(x);
      k.forEach((x, i) => {
        if (i > 0) expect(x - k[i - 1]).toBeLessThanOrEqual(MOUTH_KNOT_PX + 1);
      });
    }
    // A one-column opening: the second boundary keeps the first.
    const one = { ...op, x0: 500, x1: 500 };
    for (const x0 of [-3, -4]) {
      // At −4 the first boundary, 0, is already a grid knot.
      const k = mouthKnots({ x0, x1: 10, y0: 0, y1: 1 }, one);
      for (const x of [x0, 0, 1, 10]) expect(k).toContain(x);
    }
    const grown = buildMouthRig(lips({ grown: true }));
    expect(grown.knots[0]).toBe(grown.union.x0);
    expect(grown.knots[grown.knots.length - 1]).toBe(grown.union.x1);
    expect(grown.knots).toContain(-30);
    expect(grown.knots).toContain(29);
    expect(grown.knots).toContain(30);
  });

  it("samples the pinned ends through the warp", () => {
    for (const o of [{}, { grownInner: true }] as LipOptions[]) {
      const set = lips(o);
      const r = buildMouthRig(set);
      const { x0, x1 } = r.opening;
      const pinned = [x0 - 500, x1 - 500, x1 + 1 - 500];
      for (const role of ["lip_upper", "lip_lower"] as const) {
        const box = boxOfLayer(set.get(role)!);
        const { mesh, xs } = mouthMesh(box, r.knots);
        const warp = mouthFoldWarp(role, mesh, xs, box, r.opening);
        const at = (j: number): [number, number] => {
          const o = warp.keyforms[0].offsets;
          return [o[2 * j] * bw(box), o[2 * j + 1] * bh(box)];
        };
        const fold = mouthFold(role, r.opening);
        const y = meshPoints(mesh, box)[0][1];
        xs.forEach((x, j) => {
          const col = x + 500;
          // The knots on x1 and x1 + 1 both sample the last column.
          const c = col === x1 + 1 ? x1 : col;
          expect(at(j)[0]).toBeCloseTo(fold(c, y, 0)[0], 2);
          expect(at(j)[1]).toBeCloseTo(fold(c, y, 0)[1], 2);
          if (role === "lip_lower" && (col < x0 || col > x1 + 1))
            expect(at(j)[1]).toBeCloseTo(0, 9);
        });
        // The travel is pinned at the end columns, so the line's ends there
        // move by the taper and the thin alone.
        for (const c of [x0, x1])
          expect(r.opening.at(c).seam - r.opening.at(c).Tu).toBeCloseTo(0, 9);
        expect(xs).toEqual(
          expect.arrayContaining(
            pinned.filter((k) => k > box.x0 && k < box.x1),
          ),
        );
      }
    }
  });

  it("mouthRestShift is the warp's field at the pixel centres", () => {
    // The bust's own lip set: the rendered field, through the render oracle.
    const { layers, options } = character({ lips: true });
    const model = generateIkiFromLayerSet(layers, CANVAS, options);
    const set = mapOf(layers);
    const shift = mouthRestShift(set);
    for (const role of ["lip_upper", "lip_lower"] as const) {
      const box = boxOfLayer(set.get(role)!);
      const land = oracle.landerFor(model, role);
      let inside = 0;
      for (let c = 455; c < 545; c++) {
        for (let row = 585; row < 625; row++) {
          const [x, y] = [c + 0.5 - 500, 500 - row - 0.5];
          if (x < box.x0 || x > box.x1 || y < box.y0 || y > box.y1) {
            expect(shift(role, c, row)).toBeUndefined();
            continue;
          }
          inside++;
          // Within the mesh's own rounding: its vertices are stored to 1e-5
          // of the part (7e-4 px across this box), the cell is cut on the
          // knots themselves.
          expect(shift(role, c, row)).toBeCloseTo(land(x, y).y - y, 2);
        }
      }
      expect(inside).toBe(bw(box) * bh(box));
    }
    // The line's bottom edge at the centre column lands on the seam: read at
    // the centre's knot (x 0) and y = Tu, the fractional pixel centred there.
    const opening = buildMouthRig(set).opening;
    const { centre } = opening;
    const c = opening.at(centre);
    expect(
      Math.abs(
        shift("lip_upper", centre - 0.5, 500 - c.Tu - 0.5)! - (c.seam - c.Tu),
      ),
    ).toBeLessThan(1e-3);

    // The lower lip's fold carries integer-row steps that no per-column rule
    // reproduces: the mesh interpolates across them, over a pixel off. The
    // upper lip's smooth travel keeps it within one, though its thin and
    // taper pivot on the line's integer-row reads too.
    const gapOf = (role: "lip_upper" | "lip_lower") => {
      const fold = mouthFold(role, opening);
      return Math.max(
        ...COLS.map((col) => {
          // The pixel just above the line's bottom, or just below the skin's
          // top: inside the part's ink.
          const { Tu, Bl } = opening.at(col);
          const y = role === "lip_upper" ? Tu + 0.5 : Bl - 0.5;
          return Math.abs(
            shift(role, col, 500 - y - 0.5)! - fold(col, y, 0)[1],
          );
        }),
      );
    };
    expect(gapOf("lip_lower")).toBeGreaterThan(1);
    expect(gapOf("lip_upper")).toBeLessThan(1);
  });

  it("meshes each part on the knots inside its box", () => {
    for (const role of LIP_ROLES) {
      const box = boxOfLayer(map.get(role)!);
      const { mesh, xs } = mouthMesh(box, rig.knots);
      expect(xs).toEqual([
        box.x0,
        ...rig.knots.filter((x) => x > box.x0 && x < box.x1),
        box.x1,
      ]);
      const rows = cellsFor(bh(box), MOUTH_KNOT_PX, 2, 40);
      expect(mesh.vertices.length / 2).toBe(xs.length * (rows + 1));
      const pts = meshPoints(mesh, box);
      xs.forEach((x, i) => expect(pts[i][0]).toBeCloseTo(x, 3));
    }
  });

  it("maps a knot to one column by one rule", () => {
    const op = rig.opening;
    expect(columnOfKnot(29, op)).toBe(529);
    expect(columnOfKnot(30, op)).toBe(529);
    expect(columnOfKnot(-30, op)).toBe(470);
    // Outside the opening every part reads the knot's own column; the fold
    // decides what moves there.
    expect(columnOfKnot(-34, op)).toBe(466);
    expect(columnOfKnot(32, op)).toBe(532);
  });

  it("samples the same column on every part for one knot", () => {
    for (const role of LIP_ROLES) {
      const box = boxOfLayer(map.get(role)!);
      const { mesh, xs } = mouthMesh(box, rig.knots);
      const warp = mouthFoldWarp(role, mesh, xs, box, rig.opening);
      const n = xs.length;
      const j = xs.indexOf(-20);
      expect(j).toBeGreaterThanOrEqual(0);
      const i = n + j;
      const y = meshPoints(mesh, box)[i][1];
      const dy = warp.keyforms[0].offsets[2 * i + 1] * bh(box);
      const fold = mouthFold(role, rig.opening);
      expect(dy).toBeCloseTo(fold(480, y, 0)[1], 1);
      expect(Math.abs(dy - fold(479, y, 0)[1])).toBeGreaterThan(0.1);
    }
  });

  it("anchors the lip set at the seam and the legacy mouth at its centre", () => {
    const a = mouthAnchor(map);
    expect(a.at.y).toBeCloseTo(rig.opening.at(500).seam, 9);
    expect(a.at.x).toBeCloseTo(0, 9);
    expect(a.box).toEqual(rig.union);

    const legacy = mapOf(character().layers);
    const mouth = boxOfLayer(legacy.get("mouth")!);
    const open = boxOfLayer(legacy.get("mouth_open")!);
    const b = mouthAnchor(legacy);
    expect(b.at.y).toBe(cy(mouth));
    expect(b.box).toEqual(unionBoxes([mouth, open]));
    legacy.delete("mouth_open");
    expect(mouthAnchor(legacy).box).toEqual(mouth);
  });
});

describe("the lip set on the bust", () => {
  const { layers, options } = character({ lips: true });
  const model = generateIkiFromLayerSet(layers, CANVAS, options);
  const byRole = mapOf(layers);
  const rig = buildMouthRig(byRole);
  const part = (id: string) => model.parts.find((p) => p.id === id)!;
  const boxOf = (role: string) => boxOfLayer(byRole.get(role)!);
  /** A part's rest vertices, model space. */
  const rest = (role: string) => meshPoints(part(role).mesh!, boxOf(role));
  const landed = (role: string, params: oracle.ParamValues) => {
    const v = oracle.landVertices(model, role, params);
    return rest(role).map((_, i): [number, number] => [v[2 * i], v[2 * i + 1]]);
  };
  /** The vertices of `role` on the knot column at model x 0 (canvas 500),
   *  top to bottom, as indices. */
  const column = (role: string) => {
    const pts = rest(role);
    return pts
      .flatMap((p, i) => (Math.abs(p[0]) < 1e-6 ? [i] : []))
      .sort((a, b) => pts[b][1] - pts[a][1]);
  };
  const col = rig.opening.at(rig.opening.centre);
  const legacyModel = generateIkiFromLayerSet(
    character().layers,
    CANVAS,
    character().options,
  );
  /** Within 1e-2 px. */
  const near = (a: number, b: number) =>
    expect(Math.abs(a - b)).toBeLessThan(1e-2);

  it("replaces mouth and mouth_open with the three parts, back to front", () => {
    const expected = legacyModel.parts.flatMap((p) =>
      p.id === "mouth" ? [...LIP_ROLES] : p.id === "mouth_open" ? [] : [p.id],
    );
    expect(model.parts.map((p) => p.id)).toEqual(expected);
    expect(() => parseIkiModel(model)).not.toThrow();
  });

  it("puts all three on mouthWarp, each its own role's part", () => {
    for (const role of LIP_ROLES) {
      expect(part(role).deformer).toBe("mouthWarp");
      expect(partIdsOfRole(role)).toEqual([role]);
    }
  });

  it("declares MouthOpen and MouthForm and keeps the mouth expressions", () => {
    const ids = model.parameters.map((p) => p.id);
    expect(ids).toContain(P.MouthOpen);
    expect(ids).toContain(P.MouthForm);
    const terms = (m: typeof model, id: string) =>
      m.expressions!.find((e) => e.id === id)!.parameters;
    for (const id of ["laugh", "surprised"]) {
      expect(terms(model, id)).toEqual(terms(legacyModel, id));
      expect(terms(model, id).map((t) => t.parameter)).toContain(P.MouthOpen);
    }
  });

  it("leaves the fold at 1 the thin alone, and the stack there the art widened and thinned", () => {
    const c = rig.frame.c;
    const op = rig.opening;
    /** A vertex's thin at its knot's column: the line's whole column toward
     *  its bottom (the box's margin past the last hook reads the hook), the
     *  interior's rows above `Tu`, the skin none. */
    const thinOf = (role: string, x: number, y: number) => {
      const col = Math.round(x + 500);
      if (role === "lip_lower") return 0;
      if (role === "mouth_inner") {
        const { Tu } = op.at(col);
        return -(1 - UPPER_THIN) * Math.max(0, y - Tu);
      }
      const line =
        op.line(col === op.x1 + 1 ? op.x1 : col) ?? op.line(col - 1)!;
      return -(1 - UPPER_THIN) * (y - line.bottom);
    };
    for (const role of LIP_ROLES) {
      const fold = part(role).warps!.find(
        (w) =>
          w.parameter === P.MouthOpen &&
          w.keyforms[0].offsets.some((o) => o !== 0),
      )!;
      expect(fold.keyforms[1].value).toBe(1);
      const box = boxOf(role);
      const one = fold.keyforms[1].offsets;
      const at = landed(role, { [P.MouthOpen]: 1 });
      let moved = 0;
      rest(role).forEach(([x, y], i) => {
        const thin = thinOf(role, x, y);
        if (thin !== 0) moved++;
        expect(one[2 * i]).toBe(0);
        near(one[2 * i + 1] * bh(box), thin);
        near(at[i][0], c + AMPLITUDE.mouthOpenWidth * (x - c));
        near(at[i][1], y + thin);
      });
      // The line's rows off its bottom, the interior's top row where it
      // stands above a lower column's `Tu`; never the skin.
      if (role === "lip_lower") expect(moved).toBe(0);
      else expect(moved).toBeGreaterThan(0);
    }
  });

  it("folds shut onto the seam on the opening's centre column", () => {
    const inner = column("mouth_inner");
    const shut = landed("mouth_inner", { [P.MouthOpen]: 0 });
    const r = rest("mouth_inner");
    expect(r[inner[0]][1]).toBeCloseTo(col.T, 6);
    expect(r[inner[inner.length - 1]][1]).toBeCloseTo(col.Bb, 6);
    near(shut[inner[0]][1], col.seam + col.overlap);
    near(shut[inner[inner.length - 1]][1], col.seam + col.overlap);
    const upper = landed("lip_upper", { [P.MouthOpen]: 0 });
    const lower = landed("lip_lower", { [P.MouthOpen]: 0 });
    expect(column("lip_upper").length).toBeGreaterThan(1);
    expect(column("lip_lower").length).toBeGreaterThan(1);
    for (const i of column("lip_upper")) {
      const [x, y] = rest("lip_upper")[i];
      near(upper[i][0], x);
      // The column thinned toward the line's bottom, then carried by the
      // travel (no taper at the centre).
      near(
        upper[i][1] - y,
        col.seam - col.Tu - (1 - UPPER_THIN) * (y - col.Tu),
      );
    }
    for (const i of column("lip_lower")) {
      near(lower[i][0], rest("lip_lower")[i][0]);
      near(
        lower[i][1] - rest("lip_lower")[i][1],
        col.seam + col.overlap - col.Bl,
      );
    }
  });

  it("keeps the skin's top on the interior's bottom half way open", () => {
    const params = { [P.MouthOpen]: 0.5 };
    const skin = landed("lip_lower", params);
    const r = rest("lip_lower");
    const idx = column("lip_lower");
    const j = idx.findIndex((i, k) => k > 0 && r[i][1] <= col.Bl);
    const [a, b] = [idx[j - 1], idx[j]];
    const t = (r[a][1] - col.Bl) / (r[a][1] - r[b][1]);
    const skinTop = skin[a][1] + t * (skin[b][1] - skin[a][1]);
    const inner = landed("mouth_inner", params);
    const bottom = column("mouth_inner").slice(-1)[0];
    expect(Math.abs(skinTop - inner[bottom][1])).toBeLessThan(0.1);
  });

  it("moves the three parts alike under MouthForm", () => {
    for (const form of [-1, 1]) {
      const deltas = LIP_ROLES.flatMap((role) => {
        const a = landed(role, { [P.MouthOpen]: 1, [P.MouthForm]: form });
        const b = landed(role, { [P.MouthOpen]: 1 });
        return column(role).map((i) => [a[i][0] - b[i][0], a[i][1] - b[i][1]]);
      });
      expect(Math.abs(deltas[0][1])).toBeGreaterThan(0.1);
      for (const d of deltas) {
        near(d[0], deltas[0][0]);
        near(d[1], deltas[0][1]);
      }
    }
  });

  it("meshes the interior on a column every few pixels", () => {
    const xs = new Set(rest("mouth_inner").map((p) => p[0]));
    expect(xs.size).toBeGreaterThanOrEqual(
      Math.ceil((OPENING.x1 - OPENING.x0 + 1) / MOUTH_KNOT_PX),
    );
  });
});

describe("the lip set's inside parts on the bust", () => {
  const { layers, options } = character({ lips: "inside" });
  const model = generateIkiFromLayerSet(layers, CANVAS, options);
  const byRole = mapOf(layers);
  const rig = buildMouthRig(byRole);
  const op = rig.opening;
  const part = (id: string) => model.parts.find((p) => p.id === id)!;
  const boxOf = (role: string) => boxOfLayer(byRole.get(role)!);
  const INSIDE = ["mouth_tongue", "mouth_teeth"] as const;
  /** A part's warp on `parameter` whose `value` keyform moves something, in
   *  px per vertex. */
  const keyform = (role: string, parameter: string, value: number) => {
    const w = part(role).warps!.find(
      (w) =>
        w.parameter === parameter &&
        w.keyforms.some((k) => k.offsets.some((o) => o !== 0)),
    )!;
    const box = boxOf(role);
    const o = w.keyforms.find((k) => k.value === value)!.offsets;
    return meshPoints(part(role).mesh!, box).map((_, i): [number, number] => [
      o[2 * i] * bw(box),
      o[2 * i + 1] * bh(box),
    ]);
  };

  it("draws the tongue and the teeth between the interior and the skin, clipped to the interior", () => {
    const ids = model.parts.map((p) => p.id);
    const at = ids.indexOf("mouth_inner");
    expect(ids.slice(at, at + 5)).toEqual([
      "mouth_inner",
      "mouth_tongue",
      "mouth_teeth",
      "lip_lower",
      "lip_upper",
    ]);
    for (const role of INSIDE) {
      expect(part(role).deformer).toBe("mouthWarp");
      expect(part(role).clip).toEqual({ masks: ["mouth_inner"] });
      expect(partIdsOfRole(role)).toEqual([role]);
    }
    expect(part("mouth_inner").clip).toBeUndefined();
    expect(rig.union).toEqual(
      unionBoxes(LIP_ROLES.map((r) => boxOfLayer(byRole.get(r)!))),
    );
    expect(() => parseIkiModel(model)).not.toThrow();
  });

  it("meshes them on the knots and moves them with the interior under MouthForm", () => {
    const innerPts = meshPoints(
      part("mouth_inner").mesh!,
      boxOf("mouth_inner"),
    );
    for (const role of INSIDE) {
      expect(part(role).mesh).toEqual(mouthMesh(boxOf(role), rig.knots).mesh);
      const pts = meshPoints(part(role).mesh!, boxOf(role));
      for (const form of [-1, 1]) {
        const mine = keyform(role, P.MouthForm, form);
        const theirs = keyform("mouth_inner", P.MouthForm, form);
        let shared = 0;
        pts.forEach(([x], i) => {
          const j = innerPts.findIndex(([ix]) => Math.abs(ix - x) < 1e-3);
          if (j < 0) return;
          shared++;
          expect(Math.abs(mine[i][0] - theirs[j][0])).toBeLessThan(1e-2);
          expect(Math.abs(mine[i][1] - theirs[j][1])).toBeLessThan(1e-2);
        });
        expect(shared).toBeGreaterThan(0);
      }
    }
  });

  it("leaves MouthOpen at 1 the thin alone and closes each column by one travel", () => {
    for (const role of INSIDE) {
      const { xs } = mouthMesh(boxOf(role), rig.knots);
      const pts = meshPoints(part(role).mesh!, boxOf(role));
      const one = keyform(role, P.MouthOpen, 1);
      const zero = keyform(role, P.MouthOpen, 0);
      const box = boxOf(role);
      let moved = 0;
      pts.forEach(([, y], i) => {
        const c = op.at(columnOfKnot(xs[i % xs.length], op));
        const thin = -(1 - UPPER_THIN) * Math.max(0, y - c.Tu);
        expect(one[i][0]).toBe(0);
        expect(Math.abs(one[i][1] - thin)).toBeLessThan(1e-2);
        if (thin !== 0) {
          moved++;
          // Only the teeth's top row stands above a lower column's line.
          expect(role).toBe("mouth_teeth");
          expect(y).toBeCloseTo(box.y1, 6);
        }
        const travel =
          role === "mouth_teeth" ? c.seam - c.Tu : c.seam + c.overlap - c.Bb;
        expect(zero[i][0]).toBe(0);
        expect(Math.abs(zero[i][1] - one[i][1] - travel)).toBeLessThan(1e-2);
      });
      if (role === "mouth_teeth") expect(moved).toBeGreaterThan(0);
      else expect(moved).toBe(0);
    }
  });
});

describe("the lip set on the bust: what the mouth shows composited", () => {
  const { layers, options } = character({ lips: true });
  type Tri = { rest: [number, number][]; at: [number, number][] };

  /** The interior's weight in the final colour at a model point: its alpha
   *  after the skin and the line over it, each bilinearly filtered. */
  function compositor(lipOpts: LipOptions) {
    const byRole = lips(lipOpts);
    const model = generateIkiFromLayerSet(
      layers.map((l) => byRole.get(l.role) ?? l),
      CANVAS,
      options,
    );
    const trisOf = (role: string, v: number): Tri[] => {
      const mesh = model.parts.find((p) => p.id === role)!.mesh!;
      const rest = meshPoints(mesh, boxOfLayer(byRole.get(role)!));
      const l = oracle.landVertices(model, role, { [P.MouthOpen]: v });
      const at = rest.map((_, i): [number, number] => [l[2 * i], l[2 * i + 1]]);
      return Array.from({ length: mesh.indices.length / 3 }, (_, t) => {
        const ix = mesh.indices.slice(3 * t, 3 * t + 3);
        return { rest: ix.map((i) => rest[i]), at: ix.map((i) => at[i]) };
      });
    };
    /** Linear filtering of the crop's alpha, texel centres at +0.5. */
    const alpha = (role: string, [x, y]: [number, number]): number => {
      const l = byRole.get(role)!;
      const px = x + 500 - l.bbox.x - 0.5;
      const py = 500 - y - l.bbox.y - 0.5;
      const [i, j] = [Math.floor(px), Math.floor(py)];
      const texel = (ti: number, tj: number): number => {
        const c = l.bbox.x + Math.min(l.bbox.w - 1, Math.max(0, ti));
        const runs = l.rowRuns![Math.min(l.bbox.h - 1, Math.max(0, tj))];
        for (let k = 0; k < runs.length; k += 2)
          if (c >= runs[k] && c < runs[k + 1]) return 1;
        return 0;
      };
      const [fx, fy] = [px - i, py - j];
      return (
        texel(i, j) * (1 - fx) * (1 - fy) +
        texel(i + 1, j) * fx * (1 - fy) +
        texel(i, j + 1) * (1 - fx) * fy +
        texel(i + 1, j + 1) * fx * fy
      );
    };
    const bary = (p: [number, number], a: [number, number][]) => {
      const d =
        (a[1][1] - a[2][1]) * (a[0][0] - a[2][0]) +
        (a[2][0] - a[1][0]) * (a[0][1] - a[2][1]);
      if (Math.abs(d) < 0.05) return undefined;
      const w0 =
        ((a[1][1] - a[2][1]) * (p[0] - a[2][0]) +
          (a[2][0] - a[1][0]) * (p[1] - a[2][1])) /
        d;
      const w1 =
        ((a[2][1] - a[0][1]) * (p[0] - a[2][0]) +
          (a[0][0] - a[2][0]) * (p[1] - a[2][1])) /
        d;
      const w = [w0, w1, 1 - w0 - w1];
      return w.every((x) => x >= -1e-9) ? w : undefined;
    };
    const drawn = (role: string, tris: Tri[], p: [number, number]) =>
      Math.max(
        0,
        ...tris.map((t) => {
          const w = bary(p, t.at);
          if (w === undefined) return 0;
          return alpha(role, [
            w[0] * t.rest[0][0] + w[1] * t.rest[1][0] + w[2] * t.rest[2][0],
            w[0] * t.rest[0][1] + w[1] * t.rest[1][1] + w[2] * t.rest[2][1],
          ]);
        }),
      );
    const opening = mouthOpening(byRole);
    const upper = mouthFold("lip_upper", opening);
    /** Every sample (0.25 px grid, off the knots' lines) whose interior weight exceeds `eps`, with
     *  its column's landed line top. */
    return (v: number, eps: number) => {
      const [tIn, tLo, tUp] = [
        trisOf("mouth_inner", v),
        trisOf("lip_lower", v),
        trisOf("lip_upper", v),
      ];
      const out: { at: [number, number]; weight: number; lineTop: number }[] =
        [];
      for (let x = -33.07; x <= 33; x += 0.25)
        for (let y = -112.05; y <= -85; y += 0.25) {
          const p: [number, number] = [x, y];
          const a = drawn("mouth_inner", tIn, p);
          if (a === 0) continue;
          const weight =
            a *
            (1 - drawn("lip_lower", tLo, p)) *
            (1 - drawn("lip_upper", tUp, p));
          if (weight <= eps) continue;
          const col = Math.min(
            opening.x1,
            Math.max(opening.x0, Math.floor(x + 500)),
          );
          const c = opening.at(col);
          out.push({
            at: p,
            weight,
            lineTop: c.lineTop + upper(col, c.lineTop, v)[1],
          });
        }
      return out;
    };
  }

  // A drawn edge steps a row between columns and the knots interpolate it
  // linearly: up to a row, and a texel of filtering, off the line's top.
  const SLACK = 1.5;
  for (const o of [
    { grown: true },
    { grown: true, thinLine: true },
    { grown: true, underLine: true },
    { grown: true, grownInner: true },
  ] as LipOptions[]) {
    const label = JSON.stringify(o);
    const shows = compositor(o);

    it(`shows no interior when shut ${label}`, () => {
      expect(shows(0, 0.01)).toEqual([]);
    });

    it(`keeps the interior under the line's thinned top, nearly shut to open ${label}`, () => {
      for (const v of [0.02, 0.05, 0.1, 0.5, 1]) {
        for (const s of shows(v, 0.25)) {
          expect(s.at[1]).toBeLessThanOrEqual(s.lineTop + SLACK);
        }
      }
    });
  }
});

describe("the anchor", () => {
  it("reads the legacy mouth's centre and box, the lip set's seam and union", () => {
    const legacy = character();
    const map = mapOf(legacy.layers);
    const mouth = boxOfLayer(map.get("mouth")!);
    const frame = buildHeadFrame(legacy.layers, legacy.options);
    expect(frame.mouthY).toBe(cy(mouth));
    // Rows 590..611, centre 600.5; model y = 500 − 600.5.
    expect(frame.mouthY).toBe(-100.5);
    const ctx = solveContext(frame, map, legacy.options, true);
    expect(ctx.mouthBox).toEqual(
      unionBoxes([mouth, boxOfLayer(map.get("mouth_open")!)]),
    );

    const lipped = character({ lips: true });
    const lmap = mapOf(lipped.layers);
    const lframe = buildHeadFrame(lipped.layers, lipped.options);
    expect(lframe.mouthY).toBeCloseTo(
      mouthOpening(lmap).at(mouthOpening(lmap).centre).seam,
      9,
    );
    const lctx = solveContext(lframe, lmap, lipped.options, true);
    expect(lctx.mouthBox).toEqual(
      unionBoxes(LIP_ROLES.map((r) => boxOfLayer(lmap.get(r)!))),
    );

    // Without a measured jaw stroke the chin is an estimate off the mouth:
    // the two sets differ in it only through `mouthY`. The formula is
    // `head.ts`'s: mouthY − 0.55 · (eyeY − mouthY).
    const chin = (layers: LayerInput[], mouthY: number) => {
      const m = mapOf(layers);
      const eyeY =
        (cy(boxOfLayer(m.get("iris_L")!)) + cy(boxOfLayer(m.get("iris_R")!))) /
        2;
      return mouthY - 0.55 * (eyeY - mouthY);
    };
    expect(frame.chinY).toBeCloseTo(chin(legacy.layers, frame.mouthY), 9);
    expect(lframe.chinY).toBeCloseTo(chin(lipped.layers, lframe.mouthY), 9);
    expect(lframe.chinY).not.toBeCloseTo(frame.chinY, 1);
  });
});

describe("refusals", () => {
  const files = ["face.png", "eye_L.png", "eye_R.png"];
  const lipFiles = ["mouth_inner.png", "lip_lower.png", "lip_upper.png"];
  const without = (role: string) =>
    character({ lips: true }).layers.filter((l) => l.role !== role);
  const gen = (layers: LayerInput[]) =>
    generateIkiFromLayerSet(layers, CANVAS, character().options);

  it("refuses a partial lip set", () => {
    expect(() => parseLayerRoles([...files, ...lipFiles.slice(0, 2)])).toThrow(
      /lip_upper/,
    );
    expect(() => gen(without("lip_lower"))).toThrow(/lip_lower/);
  });

  it("refuses a lip set mixed with mouth or mouth_open", () => {
    for (const role of ["mouth", "mouth_open"]) {
      const extra = character().layers.find((l) => l.role === role)!;
      expect(() =>
        parseLayerRoles([...files, ...lipFiles, `${role}.png`]),
      ).toThrow(new RegExp(`cannot be mixed with ${role}\\b`));
      expect(() => gen([...character({ lips: true }).layers, extra])).toThrow(
        new RegExp(`cannot be mixed with ${role}\\b`),
      );
    }
  });

  it("refuses no mouth at all", () => {
    const re = /missing required role mouth \(or the lip set/;
    expect(() => parseLayerRoles(files)).toThrow(re);
    expect(() =>
      gen(character().layers.filter((l) => !l.role.startsWith("mouth"))),
    ).toThrow(re);
  });

  it("asks a lip layer for its rowRuns", () => {
    const layers = [
      ...character({ lips: true }).layers.filter(
        (l) => !(LIP_ROLES as readonly string[]).includes(l.role),
      ),
      ...lipSet({ noRuns: true }),
    ];
    expect(() => gen(layers)).toThrow(/rowRuns/);
  });

  it("refuses an inside part without the whole lip set", () => {
    const re =
      /mouth_teeth needs the lip set mouth_inner, lip_lower, lip_upper \(it is cut from the interior and clipped to it\)/;
    const legacy = character().layers;
    const teeth = character({ lips: "inside" }).layers.find(
      (l) => l.role === "mouth_teeth",
    )!;
    // Beside mouth and mouth_open, and alone.
    expect(() =>
      parseLayerRoles([
        ...files,
        "mouth.png",
        "mouth_open.png",
        "mouth_teeth.png",
      ]),
    ).toThrow(re);
    expect(() => gen([...legacy, teeth])).toThrow(re);
    expect(() => parseLayerRoles([...files, "mouth_teeth.png"])).toThrow(re);
    expect(() =>
      gen([...legacy.filter((l) => !l.role.startsWith("mouth")), teeth]),
    ).toThrow(re);
    // A partial set with one is still partial.
    expect(() =>
      parseLayerRoles([...files, ...lipFiles.slice(0, 2), "mouth_tongue.png"]),
    ).toThrow(/the lip set is partial: missing lip_upper/);
  });

  it("accepts the three lip roles, with or without the inside parts", () => {
    expect(parseLayerRoles([...files, ...lipFiles])).toHaveLength(6);
    expect(
      parseLayerRoles([
        ...files,
        ...lipFiles,
        "mouth_tongue.png",
        "mouth_teeth.png",
      ]),
    ).toHaveLength(8);
  });
});
