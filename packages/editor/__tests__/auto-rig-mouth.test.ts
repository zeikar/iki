import { describe, expect, it } from "vitest";
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
  LIP_ROLES,
  MOUTH_KNOT_PX,
  UPPER_SHARE,
  buildMouthRig,
  columnOfKnot,
  mouthAnchor,
  mouthFold,
  mouthFoldWarp,
  mouthKnots,
  mouthMesh,
  mouthOpening,
} from "../src/auto-rig/mouth";
import { LayerGeometryError, type LayerInput } from "../src/auto-rig/types";
import { AMPLITUDE } from "../src/auto-rig/profile";
import { character } from "./helpers/character";
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
      expect(c.overlap).toBe(3);
    }
    expect(op.w).toBe(3);
    const c = op.at(499);
    expect(c.seam).toBeCloseTo(c.T - UPPER_SHARE * c.H, 9);
    // Column 499: top row 592, interior 22 rows and a 2-row band, so
    // T = -92, H = 24 and the seam is 7.2 below the top.
    expect(c.seam).toBeCloseTo(-99.2, 9);
  });

  it("reads a gap column as its left neighbour, which wins a tie", () => {
    const layers = lipSet();
    layers[0] = cut(layers[0], 480, () => true);
    const op = mouthOpening(mapOf(layers));
    const whole = mouthOpening(lips());
    // Columns 479 and 481 differ (the interior is 16 and 17 rows high).
    expect(op.at(480)).toEqual(whole.at(479));
    expect(op.at(480)).not.toEqual(whole.at(481));
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
    expect([c.lineH, op.w, c.overlap]).toEqual([3, 3, 3]);
    expect(c.H).toBe(base.H + 1);
  });

  it("refuses an interior with no opaque pixel", () => {
    const layers = lipSet();
    layers[0] = { ...layers[0], rowRuns: layers[0].rowRuns!.map(() => []) };
    expect(() => mouthOpening(mapOf(layers))).toThrow(LayerGeometryError);
    expect(() => mouthOpening(mapOf(layers))).toThrow(/mouth_inner/);
  });
});

describe("mouth.ts: the fold", () => {
  for (const o of [{}, { underLine: true }] as LipOptions[]) {
    const label = JSON.stringify(o);
    it(`lands every part on the seam at v 0 ${label}`, () => {
      const op = mouthOpening(lips(o));
      const upper = mouthFold("lip_upper", op);
      const lower = mouthFold("lip_lower", op);
      const inner = mouthFold("mouth_inner", op);
      for (const x of COLS) {
        const c = op.at(x);
        expect(c.Tu + upper(x, c.Tu, 0)).toBeCloseTo(c.seam, 9);
        expect(c.Bl + lower(x, c.Bl, 0)).toBeCloseTo(c.seam + c.overlap, 9);
        const top = c.T + inner(x, c.T, 0);
        const bottom = c.Bb + inner(x, c.Bb, 0);
        expect(top).toBeCloseTo(c.seam, 9);
        expect(bottom).toBeCloseTo(c.seam + c.overlap, 9);
        for (const y of [top, bottom]) {
          expect(y).toBeGreaterThanOrEqual(c.seam - 1e-9);
          expect(y).toBeLessThanOrEqual(c.seam + c.lineH + 1e-9);
        }
      }
    });
  }

  it("is the art as drawn at v 1", () => {
    const op = mouthOpening(lips());
    for (const role of LIP_ROLES) {
      for (const x of COLS) {
        expect(mouthFold(role, op)(x, op.at(x).T, 1)).toBe(0);
      }
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
        const top = c.T + inner(x, c.T, 0.5);
        const bottom = c.Bb + inner(x, c.Bb, 0.5);
        const lineBottom = c.Tu + upper(x, c.Tu, 0.5);
        const skinTop = c.Bl + lower(x, c.Bl, 0.5);
        expect(top - lineBottom).toBeCloseTo(o.underLine ? 0.5 : 0, 9);
        expect(skinTop - bottom).toBeCloseTo(o.skinOverlap ? 0.5 : 0, 9);
        expect(top - bottom).toBeCloseTo((c.H - c.overlap) / 2, 9);
      }
    });
  }

  it("crosses zero height at v* = overlap / (H + overlap)", () => {
    for (const o of [{}, { thinLine: true }] as LipOptions[]) {
      const op = mouthOpening(lips(o));
      const inner = mouthFold("mouth_inner", op);
      for (const x of COLS) {
        const c = op.at(x);
        const vStar = c.overlap / (c.H + c.overlap);
        const height = (v: number) =>
          c.T + inner(x, c.T, v) - (c.Bb + inner(x, c.Bb, v));
        expect(height(vStar)).toBeCloseTo(0, 9);
        expect(height(vStar + 0.01)).toBeGreaterThan(0);
        expect(height(vStar - 0.01)).toBeLessThan(0);
      }
    }
    const thin = mouthOpening(lips({ thinLine: true }));
    expect(thin.at(499).overlap).toBe(1);
  });

  it("leaves a hook still and reads the nearest column for the interior", () => {
    const op = mouthOpening(lips());
    const upper = mouthFold("lip_upper", op);
    const lower = mouthFold("lip_lower", op);
    const inner = mouthFold("mouth_inner", op);
    for (const v of [0, 0.3, 0.7, 1]) {
      expect(upper(466, 100, v)).toBe(0);
      expect(lower(466, 100, v)).toBe(0);
      expect(inner(466, op.at(470).T, v)).toBe(inner(470, op.at(470).T, v));
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
      for (const x of [union.x0, union.x1, -30, 30]) expect(k).toContain(x);
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
    expect(grown.knots).toContain(30);
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
    expect(columnOfKnot(30, op, "lip_upper")).toBe(529);
    expect(columnOfKnot(-30, op, "lip_upper")).toBe(470);
    expect(columnOfKnot(-34, op, "lip_upper")).toBeUndefined();
    expect(columnOfKnot(-34, op, "lip_lower")).toBeUndefined();
    expect(columnOfKnot(-34, op, "mouth_inner")).toBe(470);
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
      expect(dy).toBeCloseTo(fold(480, y, 0), 1);
      expect(dy).not.toBeCloseTo(fold(479, y, 0), 1);
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
