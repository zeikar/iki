import { describe, expect, it } from "vitest";
import type {
  IkiDeformer,
  IkiParameter,
  IkiWarpDeformer,
  IkiWarpGrid,
} from "@ikijs/format";
import { ParameterStore } from "@ikijs/engine";
import { evaluateTransform, resolveDeformers } from "../src/deform";
import type { Affine } from "../src/affine";

// --- helpers ------------------------------------------------------------------

function makeStore(params: IkiParameter[] = []): ParameterStore {
  return new ParameterStore(params);
}

/** Apply a 2D affine to a point [x, y]. Returns [x', y']. */
function applyAffine(m: Affine, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

// --- (a) evaluateTransform with bindings -------------------------------------

describe("evaluateTransform — base + binding", () => {
  it("applies a translateX binding at mid-range", () => {
    const params: IkiParameter[] = [{ id: "p", min: 0, max: 1, default: 0 }];
    const store = makeStore(params);
    store.set("p", 0.5); // normalized = 0.5

    const result = evaluateTransform(
      { x: 10, y: 20, rotation: 0 },
      [{ parameter: "p", channel: "translateX", from: 0, to: 40 }],
      store,
    );

    // 0.5 of [0..40] = 20 added to base x=10 → 30
    expect(result.x).toBeCloseTo(30);
    expect(result.y).toBeCloseTo(20);
    expect(result.rotation).toBeCloseTo(0);
    expect(result.scaleX).toBeCloseTo(1);
    expect(result.scaleY).toBeCloseTo(1);
    expect(result.opacity).toBeCloseTo(1);
  });

  it("applies a translateY binding at full range", () => {
    const params: IkiParameter[] = [{ id: "q", min: 0, max: 1, default: 0 }];
    const store = makeStore(params);
    store.set("q", 1); // normalized = 1

    const result = evaluateTransform(
      { x: 0, y: 5 },
      [{ parameter: "q", channel: "translateY", from: 0, to: 10 }],
      store,
    );

    expect(result.y).toBeCloseTo(15); // 5 + 10
  });

  it("applies a rotate binding and accumulates onto base rotation", () => {
    const params: IkiParameter[] = [{ id: "r", min: 0, max: 1, default: 0 }];
    const store = makeStore(params);
    store.set("r", 1); // normalized = 1

    const result = evaluateTransform(
      { x: 0, y: 0, rotation: 10 },
      [{ parameter: "r", channel: "rotate", from: 0, to: 90 }],
      store,
    );

    expect(result.rotation).toBeCloseTo(100); // 10 + 90
  });

  it("applies a scaleX binding summed onto base scaleX", () => {
    const params: IkiParameter[] = [{ id: "sx", min: 0, max: 1, default: 0 }];
    const store = makeStore(params);
    store.set("sx", 0.5); // normalized = 0.5

    const result = evaluateTransform(
      { x: 0, y: 0, scaleX: 1 },
      [{ parameter: "sx", channel: "scaleX", from: 0, to: 2 }],
      store,
    );

    expect(result.scaleX).toBeCloseTo(2); // 1 + 0.5*2
  });

  it("applies a scaleY binding summed onto base scaleY", () => {
    const params: IkiParameter[] = [{ id: "sy", min: 0, max: 1, default: 0 }];
    const store = makeStore(params);
    store.set("sy", 1); // normalized = 1

    const result = evaluateTransform(
      { x: 0, y: 0, scaleY: 2 },
      [{ parameter: "sy", channel: "scaleY", from: 0, to: 3 }],
      store,
    );

    expect(result.scaleY).toBeCloseTo(5); // 2 + 3
  });
});

// --- (b) 2-level parent→child deformer chain ---------------------------------

describe("resolveDeformers — parent→child composition + pivot", () => {
  it("root deformer: 90° rotation about pivot (10,0) maps (10,10) to (0,0)", () => {
    // A point at (10, 10) relative to a pivot of (10, 0):
    // In pivot-local space: offset = (0, 10).
    // After 90° CCW rotation: the local offset becomes (-10, 0).
    // Back in world space (add pivot): (-10 + 10, 0 + 0) = (0, 0).
    const deformer: IkiDeformer = {
      id: "root",
      pivot: { x: 10, y: 0 },
      transform: { x: 0, y: 0, rotation: 90, scaleX: 1, scaleY: 1 },
    };

    const { worlds } = resolveDeformers([deformer], makeStore());
    const m = worlds.get("root")!;

    const [rx, ry] = applyAffine(m, 10, 10);
    expect(rx).toBeCloseTo(0);
    expect(ry).toBeCloseTo(0);
  });

  it("child deformer world = parentWorld · childLocal", () => {
    // Parent: translate by (5, 0), no rotation, pivot at origin
    // Child: 90° rotation about pivot (0, 0), pivot at origin
    // Expected child world: translate(5,0) · rotate(90)
    // Point (1, 0) → rotate(90) → (0, 1) → translate(5,0) → (5, 1)
    const parent: IkiDeformer = {
      id: "parent",
      pivot: { x: 0, y: 0 },
      transform: { x: 5, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
    };
    const child: IkiDeformer = {
      id: "child",
      parent: "parent",
      pivot: { x: 0, y: 0 },
      transform: { x: 0, y: 0, rotation: 90, scaleX: 1, scaleY: 1 },
    };

    const { worlds } = resolveDeformers([parent, child], makeStore());
    const m = worlds.get("child")!;

    // (1, 0) → rotate(90) gives (0, 1); translate(5,0) gives (5, 1)
    const [rx, ry] = applyAffine(m, 1, 0);
    expect(rx).toBeCloseTo(5);
    expect(ry).toBeCloseTo(1);
  });

  it("2-level chain: 90° parent about pivot (10,0) then child translates: point maps correctly", () => {
    // Parent: 90° rotation about pivot (10, 0)
    //   → (20, 0) in world becomes (10, -10) after parent rotation
    //   Check: (20-10, 0-0)=(10,0) in pivot-local space.
    //   rotate 90°: (10,0) → (0, 10). Back to world: (10, 10).
    // Child: translate (3, 0), no rotation, pivot (0,0)
    //   Child world = parentWorld · childLocal
    //   childLocal maps (0,0) → (3, 0).
    //   Total: (0,0) under childWorld → parentWorld(childLocal(0,0)) = parentWorld(3,0)
    //   parentWorld(3,0): (3-10, 0-0)=(-7,0) in pivot-local → rotate90 → (0, -7) → world (10, -7)
    const parent: IkiDeformer = {
      id: "p",
      pivot: { x: 10, y: 0 },
      transform: { x: 0, y: 0, rotation: 90, scaleX: 1, scaleY: 1 },
    };
    const child: IkiDeformer = {
      id: "c",
      parent: "p",
      pivot: { x: 0, y: 0 },
      transform: { x: 3, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
    };

    const { worlds } = resolveDeformers([parent, child], makeStore());

    // Verify parent independently first: apply parentWorld to (20, 0)
    // pivot-local (20-10=10, 0) → rotate90 → (0, 10) → world (0+10, 10+0) = (10, 10)
    const pm = worlds.get("p")!;
    const [px, py] = applyAffine(pm, 20, 0);
    expect(px).toBeCloseTo(10);
    expect(py).toBeCloseTo(10);

    // Now verify child: childWorld(0, 0) should → (10, -7)
    const cm = worlds.get("c")!;
    const [cx, cy] = applyAffine(cm, 0, 0);
    expect(cx).toBeCloseTo(10);
    expect(cy).toBeCloseTo(-7);
  });

  it("resolves correctly when child is listed before its parent in the array", () => {
    // Same geometry as "child deformer world" test above, but array order reversed.
    // Child is listed first — a valid model the validator permits.
    const child: IkiDeformer = {
      id: "child",
      parent: "parent",
      pivot: { x: 0, y: 0 },
      transform: { x: 0, y: 0, rotation: 90, scaleX: 1, scaleY: 1 },
    };
    const parent: IkiDeformer = {
      id: "parent",
      pivot: { x: 0, y: 0 },
      transform: { x: 5, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
    };

    // [child, parent] — child appears first; must still resolve correctly.
    const { worlds } = resolveDeformers([child, parent], makeStore());
    const m = worlds.get("child")!;

    // Same expected result: (1, 0) → (5, 1)
    const [rx, ry] = applyAffine(m, 1, 0);
    expect(rx).toBeCloseTo(5);
    expect(ry).toBeCloseTo(1);
  });
});

// --- (c) deformer-less path: identity / no-op --------------------------------

describe("evaluateTransform — identity / no-op cases", () => {
  it("undefined transform + no bindings → identity result", () => {
    const result = evaluateTransform(undefined, undefined, makeStore());
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
    expect(result.rotation).toBe(0);
    expect(result.scaleX).toBe(1);
    expect(result.scaleY).toBe(1);
    expect(result.opacity).toBe(1);
  });

  it("identity transform + empty bindings → same as identity", () => {
    const result = evaluateTransform(
      { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
      [],
      makeStore(),
    );
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
    expect(result.rotation).toBe(0);
    expect(result.scaleX).toBe(1);
    expect(result.scaleY).toBe(1);
    expect(result.opacity).toBe(1);
  });
});

// --- (d) opacity preserved on part path --------------------------------------

describe("evaluateTransform — opacity on part path", () => {
  it("returns explicit opacity from base transform", () => {
    const result = evaluateTransform(
      { x: 0, y: 0, opacity: 0.5 },
      undefined,
      makeStore(),
    );
    expect(result.opacity).toBeCloseTo(0.5);
  });

  it("multiplies opacity binding onto base opacity", () => {
    const params: IkiParameter[] = [{ id: "fade", min: 0, max: 1, default: 0 }];
    const store = makeStore(params);
    store.set("fade", 1); // normalized = 1

    const result = evaluateTransform(
      { x: 0, y: 0, opacity: 0.8 },
      [{ parameter: "fade", channel: "opacity", from: 0, to: 0.5 }],
      store,
    );

    // opacity: 0.8 * 0.5 = 0.4
    expect(result.opacity).toBeCloseTo(0.4);
  });
});

// --- resolveDeformers — error on unresolved parent --------------------------

describe("resolveDeformers — error handling", () => {
  it("throws when a parent id is not resolved (defense-in-depth)", () => {
    const orphan: IkiDeformer = {
      id: "child",
      parent: "missing",
      pivot: { x: 0, y: 0 },
    };
    expect(() => resolveDeformers([orphan], makeStore())).toThrow(
      /unresolved deformer parent "missing"/,
    );
  });
});

// --- resolveDeformers — matrix child of a warp ------------------------------

describe("resolveDeformers — matrix child of a warp", () => {
  const W: IkiParameter = { id: "W", min: 0, max: 1, default: 0 };

  /** W at its max, where `warpTo`'s keyform is fully applied. */
  function storeAtMax(): ParameterStore {
    const store = makeStore([W]);
    store.set("W", 1);
    return store;
  }

  /** 2×2-cell rest grid over x, y ∈ [−half, half], row 0 on top. */
  function squareGrid(half: number): IkiWarpGrid {
    const points: number[] = [];
    for (const y of [half, 0, -half]) {
      for (const x of [-half, 0, half]) points.push(x, y);
    }
    return { cols: 2, rows: 2, points };
  }

  /** A root warp whose keyform at W's max moves every rest point p to f(p). */
  function warpTo(
    id: string,
    grid: IkiWarpGrid,
    f: (x: number, y: number) => [number, number],
  ): IkiWarpDeformer {
    const offsets: number[] = [];
    for (let i = 0; i < grid.points.length; i += 2) {
      const [x, y] = f(grid.points[i], grid.points[i + 1]);
      offsets.push(x - grid.points[i], y - grid.points[i + 1]);
    }
    return {
      kind: "warp",
      id,
      grid,
      warps: [
        {
          parameter: "W",
          keyforms: [
            { value: 0, offsets: offsets.map(() => 0) },
            { value: 1, offsets },
          ],
        },
      ],
    };
  }

  it("(a) a rest warp between two matrices is a no-op for the ancestor affine", () => {
    const root: IkiDeformer = {
      id: "root",
      pivot: { x: 10, y: 0 },
      transform: { x: 0, y: 0, rotation: 90, scaleX: 2 },
    };
    const w: IkiDeformer = {
      kind: "warp",
      id: "w",
      parent: "root",
      grid: { cols: 1, rows: 1, points: [0, 10, 20, 10, 0, -10, 20, -10] },
    };
    const child: IkiDeformer = {
      id: "child",
      parent: "w",
      pivot: { x: 12, y: 3 },
      transform: { x: 1, y: 2 },
    };
    const childDirect: IkiDeformer = {
      ...child,
      id: "childDirect",
      parent: "root",
    };

    const { worlds } = resolveDeformers(
      [root, w, child, childDirect],
      makeStore(),
    );
    const viaWarp = worlds.get("child")!;
    const direct = worlds.get("childDirect")!;
    for (let i = 0; i < 6; i++) expect(viaWarp[i]).toBeCloseTo(direct[i]);
  });

  it("(b) the pivot rides the warp's keyform", () => {
    const w = warpTo("w", squareGrid(1), (x, y) => [x + 5, y]);
    const child: IkiDeformer = {
      id: "child",
      parent: "w",
      pivot: { x: 0.5, y: 0.25 },
    };

    const m = resolveDeformers([w, child], storeAtMax()).worlds.get("child")!;
    const [px, py] = applyAffine(m, 0.5, 0.25);
    expect(px).toBeCloseTo(5.5);
    expect(py).toBeCloseTo(0.25);
    const [qx, qy] = applyAffine(m, 1.5, 0.25);
    expect(qx).toBeCloseTo(6.5);
    expect(qy).toBeCloseTo(0.25);
  });

  it("(c) the child turns with the warp's local rotation", () => {
    const w = warpTo("w", squareGrid(1), (x, y) => [-y, x]);
    const child: IkiDeformer = {
      id: "child",
      parent: "w",
      pivot: { x: 0, y: 0 },
    };

    const m = resolveDeformers([w, child], storeAtMax()).worlds.get("child")!;
    const [x, y] = applyAffine(m, 1, 0);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(1);
  });

  it("(d) a narrowing warp moves the child without squashing it", () => {
    const w = warpTo("w", squareGrid(1), (x, y) => [x * 0.5, y]);
    const child: IkiDeformer = {
      id: "child",
      parent: "w",
      pivot: { x: 0.5, y: 0 },
    };

    const m = resolveDeformers([w, child], storeAtMax()).worlds.get("child")!;
    // The pivot lands at 0.25; the unit offset is carried whole, not halved.
    const [x, y] = applyAffine(m, 1.5, 0);
    expect(x).toBeCloseTo(1.25);
    expect(y).toBeCloseTo(0);
  });

  it("(e) root → warp → matrix → warp: the lower grid takes the upper keyform, then the root's turn", () => {
    // root turns 90° about the origin: the right order, root · frame, sends
    // a w2 point (x, y) to (−y, x + 5); frame · root would give (−y + 5, x).
    const root: IkiDeformer = {
      id: "root",
      pivot: { x: 0, y: 0 },
      transform: { x: 0, y: 0, rotation: 90 },
    };
    const w1: IkiDeformer = {
      ...warpTo("w1", squareGrid(1), (x, y) => [x + 5, y]),
      parent: "root",
    };
    const mid: IkiDeformer = {
      id: "mid",
      parent: "w1",
      pivot: { x: 0.5, y: -0.5 },
    };
    const w2Grid = squareGrid(3);
    const w2: IkiDeformer = {
      kind: "warp",
      id: "w2",
      parent: "mid",
      grid: w2Grid,
    };

    const g = resolveDeformers([root, w1, mid, w2], storeAtMax()).grids.get(
      "w2",
    )!;
    for (let i = 0; i < w2Grid.points.length; i += 2) {
      expect(g.points[i]).toBeCloseTo(-w2Grid.points[i + 1]);
      expect(g.points[i + 1]).toBeCloseTo(w2Grid.points[i] + 5);
    }
  });

  it("(f) resolves identical worlds and grids whatever the array order", () => {
    const model: IkiDeformer[] = [
      {
        id: "root",
        pivot: { x: 1, y: 0 },
        transform: { x: 2, y: -1, rotation: 30 },
      },
      {
        ...warpTo("w1", squareGrid(1), (x, y) => [x + 0.3 * y, y - 0.2 * x]),
        parent: "root",
      },
      {
        id: "mid",
        parent: "w1",
        pivot: { x: 0.5, y: 0.5 },
        transform: { x: 0, y: 0, rotation: 10 },
      },
      {
        ...warpTo("w2", squareGrid(2), (x, y) => [x + 1, y]),
        parent: "mid",
      },
      {
        id: "leaf",
        parent: "w2",
        pivot: { x: -1, y: 1 },
        transform: { x: 0, y: 0, scaleX: 2 },
      },
    ];

    const forward = resolveDeformers(model, storeAtMax());
    const reversed = resolveDeformers([...model].reverse(), storeAtMax());
    expect([...forward.worlds.keys()].sort()).toEqual(["leaf", "mid", "root"]);
    expect([...forward.grids.keys()].sort()).toEqual(["w1", "w2"]);
    expect(Object.fromEntries(reversed.worlds)).toEqual(
      Object.fromEntries(forward.worlds),
    );
    expect(Object.fromEntries(reversed.grids)).toEqual(
      Object.fromEntries(forward.grids),
    );
  });

  it("(g) a warp hung from a warp throws", () => {
    const w1: IkiDeformer = { kind: "warp", id: "w1", grid: squareGrid(1) };
    const w2: IkiDeformer = {
      kind: "warp",
      id: "w2",
      parent: "w1",
      grid: squareGrid(1),
    };
    expect(() => resolveDeformers([w1, w2], makeStore())).toThrow(
      /warp deformer "w2" hangs from warp "w1"/,
    );
  });
});
