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
        // Shut the interior has no height, on the skin's top edge.
        expect(top).toBeCloseTo(c.seam + c.overlap, 9);
        expect(bottom).toBeCloseTo(c.seam + c.overlap, 9);
        expect(c.seam + c.overlap).toBeLessThanOrEqual(c.seam + c.lineH + 1e-9);
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
        // The top rides w'(1 - v) above the line's bottom, under its ink.
        expect(top - lineBottom).toBeCloseTo(
          0.5 * c.overlap + (o.underLine ? 0.5 : 0),
          9,
        );
        expect(skinTop - bottom).toBeCloseTo(o.skinOverlap ? 0.5 : 0, 9);
        expect(top - bottom).toBeCloseTo(c.H / 2, 9);
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
          const height = c.T + inner(x, c.T, v) - (c.Bb + inner(x, c.Bb, v));
          expect(height).toBeCloseTo(v * c.H, 9);
        }
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

  it("leaves the fold at 1 zero, and the stack there the art widened", () => {
    const c = rig.frame.c;
    for (const role of LIP_ROLES) {
      const fold = part(role).warps!.find(
        (w) =>
          w.parameter === P.MouthOpen &&
          w.keyforms[0].offsets.some((o) => o !== 0),
      )!;
      expect(fold.keyforms[1].value).toBe(1);
      expect(fold.keyforms[1].offsets.every((o) => o === 0)).toBe(true);
      const at = landed(role, { [P.MouthOpen]: 1 });
      rest(role).forEach(([x, y], i) => {
        near(at[i][0], c + AMPLITUDE.mouthOpenWidth * (x - c));
        near(at[i][1], y);
      });
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
      near(upper[i][0], rest("lip_upper")[i][0]);
      near(upper[i][1] - rest("lip_upper")[i][1], col.seam - col.Tu);
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
            lineTop: c.lineTop + upper(col, c.lineTop, v),
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
  ] as LipOptions[]) {
    const label = JSON.stringify(o);
    const shows = compositor(o);

    it(`shows no interior when shut ${label}`, () => {
      expect(shows(0, 0.01)).toEqual([]);
    });

    it(`keeps the interior under the line's top at a small opening ${label}`, () => {
      for (const v of [0.02, 0.05, 0.1]) {
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

  it("accepts the three lip roles", () => {
    expect(parseLayerRoles([...files, ...lipFiles])).toHaveLength(6);
  });
});
