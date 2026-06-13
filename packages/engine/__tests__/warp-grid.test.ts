import { describe, expect, it } from "vitest";
import type {
  IkiDeformer,
  IkiGrid2DKeyform,
  IkiParameter,
  IkiWarpGrid,
} from "@iki/format";
import { ParameterStore } from "@iki/engine";
import { accumulate2DKeyformOffsets } from "../src/warp";
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

// --- (h) accumulate2DKeyformOffsets — 2D parameter bilinear ------------------

/**
 * Build a flat IkiGrid2DKeyform[] for a valuesX.length × valuesY.length lattice.
 * Each entry's offsets are all set to a unique scalar so we can verify exact
 * corner selection or bilinear results.
 *
 * offsets[n] = scalar for every n in [0, pointCount).
 */
function makeKeyforms2d(
  nX: number,
  nY: number,
  pointCount: number,
  scalar: (ix: number, iy: number) => number,
): IkiGrid2DKeyform[] {
  const kf: IkiGrid2DKeyform[] = [];
  for (let iy = 0; iy < nY; iy++) {
    for (let ix = 0; ix < nX; ix++) {
      const v = scalar(ix, iy);
      kf.push({ offsets: Array.from({ length: pointCount }, () => v) });
    }
  }
  return kf;
}

describe("accumulate2DKeyformOffsets — lattice exactness 3×3", () => {
  // valuesX = [-30, 0, 30], valuesY = [-30, 0, 30], 9 distinct keyforms.
  // Each keyform has uniform offsets equal to its flat index k(i,j) = j*3 + i.
  const valuesX = [-30, 0, 30];
  const valuesY = [-30, 0, 30];
  const pointCount = 4; // arbitrary, just needs to be > 0
  const keyforms2d = makeKeyforms2d(3, 3, pointCount, (ix, iy) => iy * 3 + ix);

  it("returns each of the 9 exact keyform values at the lattice nodes", () => {
    for (let iy = 0; iy < 3; iy++) {
      for (let ix = 0; ix < 3; ix++) {
        const out = new Float32Array(pointCount); // zero-initialized (out +=)
        accumulate2DKeyformOffsets(
          valuesX,
          valuesY,
          keyforms2d,
          valuesX[ix],
          valuesY[iy],
          out,
        );
        const expected = iy * 3 + ix;
        for (let n = 0; n < pointCount; n++) {
          expect(out[n]).toBeCloseTo(expected, 5);
        }
      }
    }
  });
});

describe("accumulate2DKeyformOffsets — lattice exactness 2×2 (minimal)", () => {
  // Minimal valid lattice: 2×2 nodes, 4 distinct keyforms.
  const valuesX = [-1, 1];
  const valuesY = [-1, 1];
  const pointCount = 2;
  // k(0,0)=0, k(1,0)=1, k(0,1)=2, k(1,1)=3
  const keyforms2d = makeKeyforms2d(2, 2, pointCount, (ix, iy) => iy * 2 + ix);

  it("returns each of the 4 exact keyform values at the lattice nodes", () => {
    const cases: [number, number, number][] = [
      [-1, -1, 0], // k(0,0)
      [1, -1, 1], // k(1,0)
      [-1, 1, 2], // k(0,1)
      [1, 1, 3], // k(1,1)
    ];
    for (const [vx, vy, expected] of cases) {
      const out = new Float32Array(pointCount);
      accumulate2DKeyformOffsets(valuesX, valuesY, keyforms2d, vx, vy, out);
      for (let n = 0; n < pointCount; n++) {
        expect(out[n]).toBeCloseTo(expected, 5);
      }
    }
  });
});

describe("accumulate2DKeyformOffsets — upper-corner clamp (Blocker-1)", () => {
  // 2×2 lattice with unique scalars; upper clamp must select k(last, last), NOT k(last-1, last-1).
  const valuesX = [0, 10];
  const valuesY = [0, 10];
  const pointCount = 2;
  const keyforms2d = makeKeyforms2d(2, 2, pointCount, (ix, iy) => iy * 2 + ix);
  // k(1,1) = 3 (the true last column+row)

  it("vx >= valuesX[last] AND vy >= valuesY[last] returns the LAST keyform exactly", () => {
    // Well above last.
    const out = new Float32Array(pointCount);
    accumulate2DKeyformOffsets(valuesX, valuesY, keyforms2d, 99, 99, out);
    for (let n = 0; n < pointCount; n++) {
      expect(out[n]).toBeCloseTo(3, 5); // k(1,1) = 3, NOT k(0,0)=0
    }
    // Exact boundary.
    const out2 = new Float32Array(pointCount);
    accumulate2DKeyformOffsets(valuesX, valuesY, keyforms2d, 10, 10, out2);
    for (let n = 0; n < pointCount; n++) {
      expect(out2[n]).toBeCloseTo(3, 5);
    }
  });
});

describe("accumulate2DKeyformOffsets — lower-corner clamp", () => {
  const valuesX = [0, 10];
  const valuesY = [0, 10];
  const pointCount = 2;
  const keyforms2d = makeKeyforms2d(2, 2, pointCount, (ix, iy) => iy * 2 + ix);
  // k(0,0) = 0

  it("vx <= valuesX[0] AND vy <= valuesY[0] returns the FIRST keyform exactly", () => {
    const out = new Float32Array(pointCount);
    accumulate2DKeyformOffsets(valuesX, valuesY, keyforms2d, -99, -99, out);
    for (let n = 0; n < pointCount; n++) {
      expect(out[n]).toBeCloseTo(0, 5); // k(0,0) = 0
    }
  });
});

describe("accumulate2DKeyformOffsets — center-entry zero", () => {
  // 3×3 lattice, center k(1,1) all-zero; (vx=0, vy=0) must accumulate zero.
  const valuesX = [-30, 0, 30];
  const valuesY = [-30, 0, 30];
  const pointCount = 3;
  const keyforms2d = makeKeyforms2d(3, 3, pointCount, (ix, iy) => {
    // Center entry is 0; give all others non-zero so a wrong bracket is visible.
    return ix === 1 && iy === 1 ? 0 : 100;
  });

  it("(vx=0, vy=0) accumulates the center-entry zero offsets", () => {
    const out = new Float32Array(pointCount);
    accumulate2DKeyformOffsets(valuesX, valuesY, keyforms2d, 0, 0, out);
    for (let n = 0; n < pointCount; n++) {
      expect(out[n]).toBeCloseTo(0, 5);
    }
  });
});

describe("accumulate2DKeyformOffsets — per-axis edge clamp", () => {
  // 3×3 lattice; clamp on X pins to an entire COLUMN regardless of vy.
  // valuesX=[-30,0,30], valuesY=[-30,0,30]; the leftmost column ix=0 has offsets=ix=0.
  const valuesX = [-30, 0, 30];
  const valuesY = [-30, 0, 30];
  const pointCount = 2;
  const keyforms2d = makeKeyforms2d(3, 3, pointCount, (ix, _iy) => ix * 10);
  // Column ix=0 → 0, ix=1 → 10, ix=2 → 20.
  // Clamping vx below first: any vy should blend between k(0,iy) and k(0,iy+1) = 0 and 0 → 0.

  it("vx below valuesX[0] pins to column ix=0 regardless of vy", () => {
    for (const vy of [-30, 0, 30]) {
      const out = new Float32Array(pointCount);
      accumulate2DKeyformOffsets(valuesX, valuesY, keyforms2d, -99, vy, out);
      for (let n = 0; n < pointCount; n++) {
        // All column-0 entries have offset 0, so result is 0 for any vy.
        expect(out[n]).toBeCloseTo(0, 5);
      }
    }
  });

  it("vx above valuesX[last] pins to column ix=last (=2) regardless of vy", () => {
    for (const vy of [-30, 0, 30]) {
      const out = new Float32Array(pointCount);
      accumulate2DKeyformOffsets(valuesX, valuesY, keyforms2d, 99, vy, out);
      for (let n = 0; n < pointCount; n++) {
        // All column-2 entries have offset 20.
        expect(out[n]).toBeCloseTo(20, 5);
      }
    }
  });
});

describe("accumulate2DKeyformOffsets — diagonal interior blend", () => {
  // Asymmetric by design: tx=0.25 != ty=0.75 AND c10 != c01, so a tx/ty swap
  // or a c10/c01 transpose yields 12.5 instead of 17.5 — the bug is detectable.
  //
  // valuesX=[0,4], vx=1 → tx=(1-0)/(4-0)=0.25
  // valuesY=[0,4], vy=3 → ty=(3-0)/(4-0)=0.75
  // k(0,0)=c00=0, k(1,0)=c10=10, k(0,1)=c01=20, k(1,1)=c11=30
  // top = 0 + (10-0)*0.25 = 2.5
  // bot = 20 + (30-20)*0.25 = 22.5
  // result = 2.5 + (22.5-2.5)*0.75 = 17.5
  const valuesX = [0, 4];
  const valuesY = [0, 4];
  const pointCount = 2;
  const offsets: [number, number, number, number] = [0, 10, 20, 30];
  const keyforms2d: IkiGrid2DKeyform[] = offsets.map((v) => ({
    offsets: Array.from({ length: pointCount }, () => v),
  }));

  it("asymmetric (vx=1→tx=0.25, vy=3→ty=0.75) gives the hand-computed bilinear result 17.5", () => {
    const out = new Float32Array(pointCount);
    accumulate2DKeyformOffsets(valuesX, valuesY, keyforms2d, 1, 3, out);
    for (let n = 0; n < pointCount; n++) {
      expect(out[n]).toBeCloseTo(17.5, 5);
    }
  });

  it("accumulates on top of existing out values (out +=, not out =)", () => {
    const out = new Float32Array(pointCount).fill(100); // pre-seeded
    accumulate2DKeyformOffsets(valuesX, valuesY, keyforms2d, 1, 3, out);
    for (let n = 0; n < pointCount; n++) {
      expect(out[n]).toBeCloseTo(117.5, 5); // 100 + 17.5
    }
  });
});

describe("resolveWarpGrids — warp2d applies 2D keyform offsets", () => {
  // Warp deformer with a 2×2 2D grid warp.  All rest points at zero so the
  // accumulated offsets are the full result.  k(0,0)=1, k(1,0)=2, k(0,1)=3, k(1,1)=4.
  // Drive vx=5 (midpoint of [0,10]) and vy=5 → tx=0.5, ty=0.5 → bilinear = 2.5.
  const PARAM_X: IkiParameter = {
    id: "px",
    min: 0,
    max: 10,
    default: 5,
  };
  const PARAM_Y: IkiParameter = {
    id: "py",
    min: 0,
    max: 10,
    default: 5,
  };
  const pointCount = 4; // (cols+1)*(rows+1) for a 1×1-cell grid
  const restGrid: IkiWarpGrid = {
    cols: 1,
    rows: 1,
    // 2×2 control points; row-major, +y up: row0=(large y), col0=(small x).
    points: [-1, 1, 1, 1, -1, -1, 1, -1],
  };
  const keyforms2d: IkiGrid2DKeyform[] = [
    { offsets: Array.from({ length: pointCount * 2 }, () => 1) }, // k(0,0)
    { offsets: Array.from({ length: pointCount * 2 }, () => 2) }, // k(1,0)
    { offsets: Array.from({ length: pointCount * 2 }, () => 3) }, // k(0,1)
    { offsets: Array.from({ length: pointCount * 2 }, () => 4) }, // k(1,1)
  ];
  const warpDef: IkiDeformer = {
    kind: "warp",
    id: "wd",
    grid: restGrid,
    warp2d: {
      parameter: "px",
      parameterY: "py",
      valuesX: [0, 10],
      valuesY: [0, 10],
      keyforms2d,
    },
  };

  it("blends 2D keyforms into the grid control points via resolveWarpGrids", () => {
    const store = new ParameterStore([PARAM_X, PARAM_Y]);
    store.set("px", 5);
    store.set("py", 5);
    const grids = resolveWarpGrids([warpDef], store, new Map());
    const g = grids.get("wd")!;
    // Expected: rest + 2.5 on every component.
    for (let i = 0; i < restGrid.points.length; i++) {
      expect(g.points[i]).toBeCloseTo(restGrid.points[i] + 2.5, 5);
    }
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
