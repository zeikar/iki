import { describe, expect, it } from "vitest";
import type { IkiDeformer, IkiParameter, IkiWarpGrid } from "@iki/format";
import { ParameterStore } from "@iki/engine";
import { resolveDeformerWorlds } from "../src/deform";
import type { Affine } from "../src/affine";
import {
  applyWarpToChild,
  bindPointToRestGrid,
  resolveWarpGrids,
  sampleWarpGrid,
  type ResolvedWarpGrid,
} from "../src/warp-grid";

// --- helpers ------------------------------------------------------------------

function makeStore(params: IkiParameter[] = []): ParameterStore {
  return new ParameterStore(params);
}

/** Apply a 2D affine to a point [x, y]. Returns [x', y']. */
function applyAffine(m: Affine, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/**
 * Regular 2x2-cell (3x3-point) rest grid spanning x∈[-1,1], y∈[-1,1].
 * Row-major, +y up: row 0 = TOP (y=1), column 0 = LEFT (x=-1).
 */
function makeRestGrid(): IkiWarpGrid {
  // row 0 (y=1):  (-1,1) (0,1) (1,1)
  // row 1 (y=0):  (-1,0) (0,0) (1,0)
  // row 2 (y=-1): (-1,-1)(0,-1)(1,-1)
  return {
    cols: 2,
    rows: 2,
    points: [-1, 1, 0, 1, 1, 1, -1, 0, 0, 0, 1, 0, -1, -1, 0, -1, 1, -1],
  };
}

/** Wrap a rest IkiWarpGrid as a ResolvedWarpGrid (deformed === rest). */
function asResolved(grid: IkiWarpGrid): ResolvedWarpGrid {
  return {
    cols: grid.cols,
    rows: grid.rows,
    points: Float32Array.from(grid.points),
  };
}

const PARAM_ANGLE_X: IkiParameter = {
  id: "ParamAngleX",
  min: -30,
  max: 30,
  default: 0,
};

// --- (a) resolveWarpGrids — no parent, no warps → rest unchanged --------------

describe("resolveWarpGrids — no parent, no warps", () => {
  it("returns the rest points unchanged", () => {
    const rest = makeRestGrid();
    const warp: IkiDeformer = { kind: "warp", id: "w", grid: rest };

    const grids = resolveWarpGrids([warp], makeStore(), new Map());
    const g = grids.get("w")!;

    expect(g.cols).toBe(2);
    expect(g.rows).toBe(2);
    expect(Array.from(g.points)).toEqual(rest.points);
  });
});

// --- (b) resolveWarpGrids — matrix parent rotate, no grid warp ---------------

describe("resolveWarpGrids — matrix parent rotate (no grid warp)", () => {
  it("rotates the rest grid about the matrix deformer's pivot", () => {
    const rest = makeRestGrid();
    // 90° rotation about pivot (0,0).
    const parent: IkiDeformer = {
      id: "head",
      pivot: { x: 0, y: 0 },
      transform: { x: 0, y: 0, rotation: 90, scaleX: 1, scaleY: 1 },
    };
    const warp: IkiDeformer = {
      kind: "warp",
      id: "w",
      parent: "head",
      grid: rest,
    };

    const store = makeStore();
    const worlds = resolveDeformerWorlds([parent, warp], store);
    const grids = resolveWarpGrids([parent, warp], store, worlds);
    const g = grids.get("w")!;

    const m = worlds.get("head")!;
    // Each control point equals parentAffine · restPoint.
    for (let i = 0; i < rest.points.length; i += 2) {
      const [ex, ey] = applyAffine(m, rest.points[i], rest.points[i + 1]);
      expect(g.points[i]).toBeCloseTo(ex);
      expect(g.points[i + 1]).toBeCloseTo(ey);
    }
    // Concrete corner check: top-right rest (1,1) → rotate90 → (-1,1).
    const [tx, ty] = applyAffine(m, 1, 1);
    expect(tx).toBeCloseTo(-1);
    expect(ty).toBeCloseTo(1);
    expect(g.points[4]).toBeCloseTo(-1); // point index 2 → x at offset 4
    expect(g.points[5]).toBeCloseTo(1);
  });
});

// --- (c) resolveWarpGrids — no parent, single grid warp keyform --------------

describe("resolveWarpGrids — no parent, grid keyform offsets", () => {
  it("adds keyform offsets to the rest points (offsets-first, no affine)", () => {
    const rest = makeRestGrid();
    const offsets = new Array(rest.points.length).fill(0);
    offsets[0] = 0.5; // nudge top-left x
    offsets[1] = -0.25; // nudge top-left y
    const warp: IkiDeformer = {
      kind: "warp",
      id: "w",
      grid: rest,
      warps: [{ parameter: "ParamAngleX", keyforms: [{ value: 0, offsets }] }],
    };

    const store = makeStore([PARAM_ANGLE_X]);
    store.set("ParamAngleX", 0);

    const grids = resolveWarpGrids([warp], store, new Map());
    const g = grids.get("w")!;

    expect(g.points[0]).toBeCloseTo(-1 + 0.5);
    expect(g.points[1]).toBeCloseTo(1 - 0.25);
    // Untouched points stay at rest.
    expect(g.points[2]).toBeCloseTo(0);
    expect(g.points[3]).toBeCloseTo(1);
  });
});

// --- (d) resolveWarpGrids — matrix parent + grid keyform (ORDER contract) ----

describe("resolveWarpGrids — parent affine after offsets (coordinate contract)", () => {
  it("computes parentAffine · (rest + offset), NOT parentAffine·rest + offset", () => {
    const rest = makeRestGrid();
    const offsets = new Array(rest.points.length).fill(0);
    // Offset the top-left control point (rest (-1,1)) by (+0.5, +0.3).
    // Asymmetric (ox != oy and ox != -oy) so BOTH components differ between
    // the correct and reversed orders after the 90° rotation.
    offsets[0] = 0.5;
    offsets[1] = 0.3;

    const parent: IkiDeformer = {
      id: "head",
      pivot: { x: 0, y: 0 },
      transform: { x: 0, y: 0, rotation: 90, scaleX: 1, scaleY: 1 },
    };
    const warp: IkiDeformer = {
      kind: "warp",
      id: "w",
      parent: "head",
      grid: rest,
      warps: [{ parameter: "ParamAngleX", keyforms: [{ value: 0, offsets }] }],
    };

    const store = makeStore([PARAM_ANGLE_X]);
    store.set("ParamAngleX", 0);
    const worlds = resolveDeformerWorlds([parent, warp], store);
    const grids = resolveWarpGrids([parent, warp], store, worlds);
    const g = grids.get("w")!;
    const m = worlds.get("head")!;

    // CORRECT order: offset rotates WITH the parent.
    const [correctX, correctY] = applyAffine(m, -1 + 0.5, 1 + 0.3);
    expect(g.points[0]).toBeCloseTo(correctX);
    expect(g.points[1]).toBeCloseTo(correctY);

    // REVERSED order would give parentAffine·rest + offset — must DIFFER.
    const [restRotX, restRotY] = applyAffine(m, -1, 1);
    const reversedX = restRotX + 0.5;
    const reversedY = restRotY + 0.3;
    // correct (≈ -1.3, -0.5) vs reversed (≈ -0.5, -0.7) — genuinely different.
    expect(reversedX).not.toBeCloseTo(correctX);
    expect(reversedY).not.toBeCloseTo(correctY);
  });
});

// --- (e) bindPointToRestGrid — center + out-of-bounds clamp ------------------

describe("bindPointToRestGrid", () => {
  it("binds the grid center to its cell with s,t ≈ 0.5", () => {
    const rest = makeRestGrid();
    // Center of the top-left cell ([-1,0]x[0,1]) is (-0.5, 0.5).
    const b = bindPointToRestGrid(-0.5, 0.5, rest);
    expect(b.cell).toBe(0); // row 0, col 0
    expect(b.s).toBeCloseTo(0.5);
    expect(b.t).toBeCloseTo(0.5);
  });

  it("binds the exact grid center (0,0) to a valid cell, no NaN", () => {
    const rest = makeRestGrid();
    const b = bindPointToRestGrid(0, 0, rest);
    expect(Number.isNaN(b.s)).toBe(false);
    expect(Number.isNaN(b.t)).toBe(false);
    expect(b.s).toBeGreaterThanOrEqual(0);
    expect(b.s).toBeLessThanOrEqual(1);
    expect(b.t).toBeGreaterThanOrEqual(0);
    expect(b.t).toBeLessThanOrEqual(1);
  });

  it("clamps a point outside the bbox to an edge cell with pinned s/t, no NaN", () => {
    const rest = makeRestGrid();
    // Far top-right beyond the grid: x=5 (>1), y=5 (>1).
    const b = bindPointToRestGrid(5, 5, rest);
    expect(b.cell).toBe(1); // row 0 (top), col 1 (right) → 0*2 + 1
    expect(b.s).toBeCloseTo(1); // pinned to right edge
    expect(b.t).toBeCloseTo(0); // pinned to top edge
    expect(Number.isNaN(b.s)).toBe(false);
    expect(Number.isNaN(b.t)).toBe(false);

    // Far bottom-left beyond the grid: x=-5 (<-1), y=-5 (<-1).
    const b2 = bindPointToRestGrid(-5, -5, rest);
    expect(b2.cell).toBe(2); // row 1 (bottom), col 0 (left) → 1*2 + 0
    expect(b2.s).toBeCloseTo(0); // pinned to left edge
    expect(b2.t).toBeCloseTo(1); // pinned to bottom edge
  });
});

// --- (f) sampleWarpGrid — round-trip identity + translation ------------------

describe("sampleWarpGrid", () => {
  it("bind→sample round-trips on the undeformed rest grid (identity)", () => {
    const rest = makeRestGrid();
    const resolved = asResolved(rest);
    const pts: [number, number][] = [
      [-0.5, 0.5],
      [0.3, -0.7],
      [0, 0],
      [0.9, 0.1],
    ];
    for (const [x, y] of pts) {
      const b = bindPointToRestGrid(x, y, rest);
      const [sx, sy] = sampleWarpGrid(resolved, b);
      expect(sx).toBeCloseTo(x, 4);
      expect(sy).toBeCloseTo(y, 4);
    }
  });

  it("sampling a uniformly translated grid shifts the result by the translation", () => {
    const rest = makeRestGrid();
    const dx = 3;
    const dy = -2;
    const translated: ResolvedWarpGrid = {
      cols: rest.cols,
      rows: rest.rows,
      points: Float32Array.from(
        rest.points.map((v, i) => v + (i % 2 === 0 ? dx : dy)),
      ),
    };

    const x = -0.5;
    const y = 0.5;
    const b = bindPointToRestGrid(x, y, rest); // bind against RAW rest grid
    const [sx, sy] = sampleWarpGrid(translated, b);
    expect(sx).toBeCloseTo(x + dx, 4);
    expect(sy).toBeCloseTo(y + dy, 4);
  });
});

// --- (g) applyWarpToChild — pure extraction unit tests -----------------------

/** Identity affine: leaves points unchanged. */
const IDENTITY_AFFINE: Affine = [1, 0, 0, 1, 0, 0];

describe("applyWarpToChild", () => {
  it("(a) identity partAffine + rest as deformed grid → output equals input local verts", () => {
    const rest = makeRestGrid();
    const deformed = asResolved(rest);
    // Interior point well inside the grid.
    const localVerts = new Float32Array([-0.5, 0.5, 0.3, -0.7, 0, 0]);
    const out = new Float32Array(localVerts.length);

    applyWarpToChild(localVerts, IDENTITY_AFFINE, rest, deformed, out);

    for (let i = 0; i < localVerts.length; i++) {
      expect(out[i]).toBeCloseTo(localVerts[i], 4);
    }
  });

  it("(b) translation partAffine + identity deformed grid → output shifted by translation", () => {
    const rest = makeRestGrid();
    const deformed = asResolved(rest);
    const tx = 0.3;
    const ty = -0.2;
    // translate(tx, ty) → [1,0,0,1,tx,ty]
    const translationAffine: Affine = [1, 0, 0, 1, tx, ty];
    // Choose a local vert such that after translation it stays within the grid.
    const localVerts = new Float32Array([-0.5, 0.5]);
    const out = new Float32Array(2);

    applyWarpToChild(localVerts, translationAffine, rest, deformed, out);

    // partAffine transforms local (-0.5, 0.5) → (-0.2, 0.3); then bind+sample
    // the identity grid returns the same point.
    expect(out[0]).toBeCloseTo(-0.5 + tx, 4);
    expect(out[1]).toBeCloseTo(0.5 + ty, 4);
  });

  it("(c) deformed grid with uniform offset → output reflects the grid displacement", () => {
    const rest = makeRestGrid();
    const dx = 2;
    const dy = -1;
    // Uniformly shift every control point of the resolved grid.
    const deformed: ResolvedWarpGrid = {
      cols: rest.cols,
      rows: rest.rows,
      points: Float32Array.from(
        rest.points.map((v, i) => v + (i % 2 === 0 ? dx : dy)),
      ),
    };
    // Use identity partAffine so vertex passes through unchanged to bind/sample.
    const localVerts = new Float32Array([-0.5, 0.5, 0, 0]);
    const out = new Float32Array(localVerts.length);

    applyWarpToChild(localVerts, IDENTITY_AFFINE, rest, deformed, out);

    // Each sampled point should be shifted by (dx, dy).
    for (let v = 0; v < localVerts.length / 2; v++) {
      expect(out[v * 2]).toBeCloseTo(localVerts[v * 2] + dx, 4);
      expect(out[v * 2 + 1]).toBeCloseTo(localVerts[v * 2 + 1] + dy, 4);
    }
  });
});
