import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { loadIkiModel } from "@ikijs/format";
import type {
  IkiDeformer,
  IkiGridKeyform,
  IkiMatrixDeformer,
  IkiModel,
  IkiParameter,
  IkiPart,
  IkiWarpGrid,
} from "@ikijs/format";
import {
  checkFolds,
  foldPoses,
  type FoldPose,
  type FoldTarget,
} from "@ikijs/engine";

// --- helpers ------------------------------------------------------------------

/**
 * Regular 2x2-cell (3x3-point) rest grid spanning x∈[-1,1], y∈[-1,1].
 * Row-major, +y up: row 0 = TOP (y=1), column 0 = LEFT (x=-1).
 */
function makeRestGrid(): IkiWarpGrid {
  return {
    cols: 2,
    rows: 2,
    points: [-1, 1, 0, 1, 1, 1, -1, 0, 0, 0, 1, 0, -1, -1, 0, -1, 1, -1],
  };
}

/** (-1, 1): a corner of cell (0, 0) only. */
const TOP_LEFT = 0;
/** (0, 0): a corner of every cell. */
const CENTER = 4;
/** (1, -1): a corner of cell (1, 1) only. */
const BOTTOM_RIGHT = 8;

const ZEROS = new Array<number>(18).fill(0);

/** Grid offsets moving control point `point` by (dx, dy). */
function move(point: number, dx: number, dy: number): number[] {
  const offsets = [...ZEROS];
  offsets[point * 2] = dx;
  offsets[point * 2 + 1] = dy;
  return offsets;
}

const ANGLE_X: IkiParameter = {
  id: "ParamAngleX",
  min: -30,
  max: 30,
  default: 0,
};
const ANGLE_Y: IkiParameter = { ...ANGLE_X, id: "ParamAngleY" };
const ANGLE_Z: IkiParameter = { ...ANGLE_X, id: "ParamAngleZ" };
const EYE_L: IkiParameter = {
  id: "ParamEyeLOpen",
  min: 0,
  max: 1,
  default: 1,
};
const EYE_R: IkiParameter = { ...EYE_L, id: "ParamEyeROpen" };
const MOUTH: IkiParameter = {
  id: "ParamMouthOpenY",
  min: 0,
  max: 1,
  default: 0,
};

function model(
  parameters: IkiParameter[],
  deformers: IkiDeformer[] = [],
  parts: IkiPart[] = [],
): IkiModel {
  return {
    version: 1,
    name: "t",
    canvas: { width: 100, height: 100 },
    parameters,
    parts,
    deformers,
  };
}

/**
 * A 1×1 mesh part at the origin unless `more` moves it, so its part-local
 * `vertices` are offsets from its model position.
 */
function meshPart(
  id: string,
  vertices: number[],
  indices: number[],
  more: Partial<IkiPart> = {},
): IkiPart {
  return {
    id,
    color: [1, 1, 1, 1],
    width: 1,
    height: 1,
    transform: { x: 0, y: 0 },
    order: 0,
    mesh: { vertices, uvs: vertices.map(() => 0), indices },
    ...more,
  };
}

/** One counter-clockwise right triangle: corner (-0.5, -0.5), legs of 1. */
const TRIANGLE = [-0.5, -0.5, 0.5, -0.5, -0.5, 0.5];

/** One warp deformer "w" on the rest grid with one 1D warp on ParamAngleX. */
function angleXWarp(keyforms: IkiGridKeyform[]): IkiModel {
  return model(
    [ANGLE_X],
    [
      {
        kind: "warp",
        id: "w",
        grid: makeRestGrid(),
        warps: [{ parameter: "ParamAngleX", keyforms }],
      },
    ],
  );
}

/** Parses a pose name back into its values. */
function parseName(name: string): Record<string, number> {
  if (name === "rest") return {};
  return Object.fromEntries(
    name.split(" ").map((pair) => {
      const [id, value] = pair.split("=");
      return [id, Number(value)];
    }),
  );
}

// --- checkFolds over warp grids ----------------------------------------------

describe("checkFolds — warp grid cells", () => {
  it("(a) small offsets: every target ok, no offenders", () => {
    const m = angleXWarp([
      { value: -30, offsets: move(TOP_LEFT, -0.1, 0.05) },
      { value: 0, offsets: ZEROS },
      { value: 30, offsets: move(CENTER, 0.1, -0.1) },
    ]);
    const report = checkFolds(m);

    expect(report.poses).toBe(foldPoses(m).length);
    expect(report.thresholds).toEqual({ flip: 0, collapse: 0.1 });
    expect(report.targets).toHaveLength(1);
    expect(report.targets[0].target).toEqual({ kind: "deformer", id: "w" });
    expect(report.targets[0].kind).toBe("ok");
    expect(report.targets[0].worst!.ratio).toBeGreaterThan(0.5);
    expect(report.targets[0].expected).toBeUndefined();
    expect(report.offenders).toEqual([]);
  });

  it("(b) a corner triangle under 0.1 of its rest area is a collapse at that cell and pose", () => {
    // The top-left point drops to y = 1/16: its cell's triangles at the
    // bottom-left and top-left corners keep 1/16 of their area.
    const m = angleXWarp([
      { value: 0, offsets: ZEROS },
      { value: 30, offsets: move(TOP_LEFT, 0, -0.9375) },
    ]);
    const report = checkFolds(m);
    const [target] = report.targets;

    expect(target.kind).toBe("collapse");
    expect(target.worst!.ratio).toBeCloseTo(0.0625, 6);
    expect(target.worst!.where).toEqual({ col: 0, row: 0 });
    expect(target.worst!.pose).toEqual({
      name: "ParamAngleX=30",
      values: { ParamAngleX: 30 },
    });
    expect(target.worst!.rest).toEqual({ x: -0.5, y: 0.5 });
    expect(report.offenders).toEqual([target]);
  });

  it("(c) a point pushed past its neighbour is a flip at the named pose", () => {
    const m = angleXWarp([
      { value: 0, offsets: ZEROS },
      { value: 30, offsets: move(TOP_LEFT, 0, -1.5) },
    ]);
    const [target] = checkFolds(m).targets;

    expect(target.kind).toBe("flip");
    expect(target.worst!.ratio).toBeLessThanOrEqual(0);
    expect(target.worst!.ratio).toBeCloseTo(-0.5, 6);
    expect(target.worst!.where).toEqual({ col: 0, row: 0 });
    expect(target.worst!.pose.name).toBe("ParamAngleX=30");
  });

  it("(d) the same flip authored as a warp2d keyform is found at its corner pose", () => {
    const m = model(
      [ANGLE_X, ANGLE_Y],
      [
        {
          kind: "warp",
          id: "w",
          grid: makeRestGrid(),
          warp2d: {
            parameter: "ParamAngleX",
            parameterY: "ParamAngleY",
            valuesX: [-30, 30],
            valuesY: [-30, 30],
            // k(1, 1) = (AngleX 30, AngleY 30) carries the flip.
            keyforms2d: [
              { offsets: ZEROS },
              { offsets: ZEROS },
              { offsets: ZEROS },
              { offsets: move(TOP_LEFT, 0, -1.5) },
            ],
          },
        },
      ],
    );
    const [target] = checkFolds(m).targets;

    expect(target.kind).toBe("flip");
    expect(target.worst!.ratio).toBeCloseTo(-0.5, 6);
    expect(target.worst!.where).toEqual({ col: 0, row: 0 });
    expect(target.worst!.pose.name).toBe("ParamAngleX=30 ParamAngleY=30");
  });

  it("(e) a fold at the parameter's min is found by the min single", () => {
    const m = angleXWarp([
      { value: -30, offsets: move(TOP_LEFT, 0, -1.5) },
      { value: 0, offsets: ZEROS },
      { value: 30, offsets: move(TOP_LEFT, 0, 0.25) },
    ]);
    const [target] = checkFolds(m).targets;

    expect(target.kind).toBe("flip");
    expect(target.worst!.pose).toEqual({
      name: "ParamAngleX=-30",
      values: { ParamAngleX: -30 },
    });
  });

  describe("(f) the expected predicate reads each pose's effective values", () => {
    /**
     * The mouth's warp shuts cell (0, 0) to nothing while ParamMouthOpenY is
     * 0, its default; `angleXCollapse` drops cell (1, 1) to 0.05 at
     * ParamAngleX 30 whatever the mouth does.
     */
    function mouthModel(angleXCollapse: boolean): IkiModel {
      return model(
        [ANGLE_X, MOUTH],
        [
          {
            kind: "warp",
            id: "w",
            grid: makeRestGrid(),
            warps: [
              {
                parameter: "ParamMouthOpenY",
                keyforms: [
                  { value: 0, offsets: move(TOP_LEFT, 0, -1) },
                  { value: 1, offsets: ZEROS },
                ],
              },
              {
                parameter: "ParamAngleX",
                keyforms: [
                  { value: 0, offsets: ZEROS },
                  {
                    value: 30,
                    offsets: angleXCollapse
                      ? move(BOTTOM_RIGHT, -0.95, 0)
                      : ZEROS,
                  },
                ],
              },
            ],
          },
        ],
      );
    }

    function shutPredicate(shut: Set<string>) {
      return (
        target: FoldTarget["target"],
        pose: FoldPose,
        value: (id: string) => number,
      ) => {
        expect(target).toEqual({ kind: "deformer", id: "w" });
        const isShut = value("ParamMouthOpenY") === 0;
        if (isShut) shut.add(pose.name);
        return isShut;
      };
    }

    it("splits the shut closure into expected and keeps the open-pose collapse in worst", () => {
      const shut = new Set<string>();
      const report = checkFolds(mouthModel(true), {
        expected: shutPredicate(shut),
      });
      const [target] = report.targets;

      // Only the effective value sees rest and the AngleX singles as shut:
      // none of them sets ParamMouthOpenY.
      expect(shut).toContain("rest");
      expect(shut).toContain("ParamAngleX=-30");
      expect(shut).toContain("ParamAngleX=30");
      expect(shut).not.toContain("ParamMouthOpenY=1");

      expect(target.expected!.ratio).toBeCloseTo(0, 6);
      expect(target.expected!.where).toEqual({ col: 0, row: 0 });
      expect(target.expected!.pose.name).toBe("rest");

      expect(target.worst!.ratio).toBeCloseTo(0.05, 6);
      expect(target.worst!.where).toEqual({ col: 1, row: 1 });
      expect(target.worst!.pose.name).toBe("ParamAngleX=30 ParamMouthOpenY=1");
      expect(target.kind).toBe("collapse");
      expect(report.offenders).toEqual([target]);
    });

    it("is ok when only the shut poses fold", () => {
      const report = checkFolds(mouthModel(false), {
        expected: shutPredicate(new Set()),
      });
      const [target] = report.targets;

      expect(target.kind).toBe("ok");
      expect(target.worst!.ratio).toBeCloseTo(1, 6);
      expect(target.expected!.ratio).toBeCloseTo(0, 6);
      expect(report.offenders).toEqual([]);
    });

    it("without a predicate the closure itself is the worst", () => {
      const [target] = checkFolds(mouthModel(false)).targets;

      expect(target.kind).toBe("flip");
      expect(target.worst!.pose.name).toBe("rest");
      expect(target.expected).toBeUndefined();
    });
  });

  it("(g) a parent matrix's scale is no fold; the rest point is scaled by it", () => {
    const m = model(
      [ANGLE_X],
      [
        {
          id: "head",
          pivot: { x: 0, y: 0 },
          transform: { x: 0, y: 0, scaleX: 0.05 },
        },
        {
          kind: "warp",
          id: "w",
          parent: "head",
          grid: makeRestGrid(),
          warps: [
            {
              parameter: "ParamAngleX",
              keyforms: [{ value: 0, offsets: ZEROS }],
            },
          ],
        },
      ],
    );
    const report = checkFolds(m);

    expect(report.targets).toHaveLength(1);
    const [target] = report.targets;
    expect(target.kind).toBe("ok");
    expect(target.worst!.ratio).toBe(1);
    expect(target.worst!.where).toEqual({ col: 0, row: 0 });
    expect(target.worst!.rest.x).toBeCloseTo(-0.025, 9);
    expect(target.worst!.rest.y).toBeCloseTo(0.5, 9);
  });

  it("(g) a parent scale bound to a parameter is no fold either; rest stays on the static chain", () => {
    // Bindings add onto the base scale 1: ParamAngleX 30 squashes the parent to 0.05.
    const m = model(
      [ANGLE_X],
      [
        {
          id: "head",
          pivot: { x: 0, y: 0 },
          bindings: [
            {
              parameter: "ParamAngleX",
              channel: "scaleX",
              from: 0,
              to: -0.95,
            },
          ],
        },
        { kind: "warp", id: "w", parent: "head", grid: makeRestGrid() },
      ],
    );
    const report = checkFolds(m, {
      poses: [{ name: "ParamAngleX=30", values: { ParamAngleX: 30 } }],
    });
    const [target] = report.targets;

    expect(target.kind).toBe("ok");
    expect(target.worst!.ratio).toBe(1);
    expect(target.worst!.pose.name).toBe("ParamAngleX=30");
    expect(target.worst!.rest).toEqual({ x: -0.5, y: 0.5 });
  });

  it("lists targets in model order and offenders worst first", () => {
    const warp = (id: string, offsets: number[]): IkiDeformer => ({
      kind: "warp",
      id,
      grid: makeRestGrid(),
      warps: [
        {
          parameter: "ParamAngleX",
          keyforms: [
            { value: 0, offsets: ZEROS },
            { value: 30, offsets },
          ],
        },
      ],
    });
    const report = checkFolds(
      model(
        [ANGLE_X],
        [
          warp("collapses", move(TOP_LEFT, 0, -0.9375)),
          warp("clean", ZEROS),
          warp("flips", move(TOP_LEFT, 0, -1.5)),
        ],
      ),
    );

    expect(report.targets.map((t) => t.target.id)).toEqual([
      "collapses",
      "clean",
      "flips",
    ]);
    expect(report.offenders.map((t) => [t.target.id, t.kind])).toEqual([
      ["flips", "flip"],
      ["collapses", "collapse"],
    ]);
  });

  it("checks only the poses it is given", () => {
    const m = angleXWarp([
      { value: 0, offsets: ZEROS },
      { value: 30, offsets: move(TOP_LEFT, 0, -1.5) },
    ]);
    const report = checkFolds(m, { poses: [{ name: "rest", values: {} }] });

    expect(report.poses).toBe(1);
    expect(report.targets[0].kind).toBe("ok");
  });
});

// --- checkFolds over part meshes ---------------------------------------------

describe("checkFolds — part mesh triangles", () => {
  /** One ParamAngleX warp on a three-vertex mesh: rest at 0, `offsets` at 30. */
  function angleXMeshWarp(offsets: number[]): IkiPart["warps"] {
    return [
      {
        parameter: "ParamAngleX",
        keyforms: [
          { value: 0, offsets: [0, 0, 0, 0, 0, 0] },
          { value: 30, offsets },
        ],
      },
    ];
  }

  const quad: IkiPart = {
    id: "quad",
    color: [1, 1, 1, 1],
    width: 1,
    height: 1,
    transform: { x: 0, y: 0 },
    order: 0,
  };

  it("(a) a keyform mirroring a vertex across its opposite edge is a flip at that extreme; a quad is no target", () => {
    const m = model(
      [ANGLE_X],
      [],
      [
        quad,
        // At 30 the top vertex lands mirrored below the bottom edge y = -0.5.
        meshPart("p", TRIANGLE, [0, 1, 2], {
          warps: angleXMeshWarp([0, 0, 0, 0, 0, -2]),
        }),
      ],
    );
    const report = checkFolds(m);

    expect(report.targets).toHaveLength(1);
    const [target] = report.targets;
    expect(target.target).toEqual({ kind: "part", id: "p" });
    expect(target.kind).toBe("flip");
    expect(target.worst!.ratio).toBeCloseTo(-1, 6);
    expect(target.worst!.where).toEqual({ triangle: 0 });
    expect(target.worst!.pose.name).toBe("ParamAngleX=30");
    expect(target.worst!.rest.x).toBeCloseTo(-1 / 6, 9);
    expect(target.worst!.rest.y).toBeCloseTo(-1 / 6, 9);
    expect(report.offenders).toEqual([target]);
  });

  it("(b) a warp child's own keyform squashing its triangle to 5 % is a collapse at triangle 0", () => {
    const m = model(
      [ANGLE_X],
      [{ kind: "warp", id: "w", grid: makeRestGrid() }],
      [
        meshPart("p", TRIANGLE, [0, 1, 2], {
          deformer: "w",
          warps: angleXMeshWarp([0, 0, 0, 0, 0, -0.95]),
        }),
      ],
    );
    const report = checkFolds(m);

    // Parts follow the deformers.
    expect(report.targets.map((t) => t.target)).toEqual([
      { kind: "deformer", id: "w" },
      { kind: "part", id: "p" },
    ]);
    const target = report.targets[1];
    expect(target.kind).toBe("collapse");
    expect(target.worst!.ratio).toBeCloseTo(0.05, 6);
    expect(target.worst!.where).toEqual({ triangle: 0 });
    expect(target.worst!.pose.name).toBe("ParamAngleX=30");
    expect(report.offenders).toEqual([target]);
  });

  it("a warp child folds with its grid: the warp's own keyform flips the triangle it carries", () => {
    // At 30 the centre point lands at (-1.5, 0), past its left neighbour
    // (-1, 0), dragging cell (0, 0)'s bottom-right corner, which the triangle
    // (-0.9, 0.1), (-0.1, 0.1), (-0.1, 0.9) hugs, over its other two.
    const m = model(
      [ANGLE_X],
      [
        {
          kind: "warp",
          id: "w",
          grid: makeRestGrid(),
          warps: [
            {
              parameter: "ParamAngleX",
              keyforms: [
                { value: 0, offsets: ZEROS },
                { value: 30, offsets: move(CENTER, -1.5, 0) },
              ],
            },
          ],
        },
      ],
      [
        meshPart("p", [-0.4, -0.4, 0.4, -0.4, 0.4, 0.4], [0, 1, 2], {
          deformer: "w",
          transform: { x: -0.5, y: 0.5 },
        }),
      ],
    );
    const target = checkFolds(m).targets[1];

    expect(target.target).toEqual({ kind: "part", id: "p" });
    expect(target.kind).toBe("flip");
    // Doubled area 0.64 at rest, -0.224 once bilinear-sampled at 30.
    expect(target.worst!.ratio).toBeCloseTo(-0.35, 5);
    expect(target.worst!.where).toEqual({ triangle: 0 });
    expect(target.worst!.pose.name).toBe("ParamAngleX=30");
  });

  describe("under a matrix deformer", () => {
    /** The triangle hung from matrix deformer "head", pivoted off the origin. */
    function underHead(
      head: Pick<IkiMatrixDeformer, "transform" | "bindings">,
    ): IkiModel {
      return model(
        [ANGLE_X],
        [{ id: "head", pivot: { x: 0.25, y: 0.5 }, ...head }],
        [meshPart("p", TRIANGLE, [0, 1, 2], { deformer: "head" })],
      );
    }

    it("(c) a static scale is in both baselines: ok, ratio 1, rest scaled by it", () => {
      const report = checkFolds(
        underHead({ transform: { x: 0, y: 0, scaleX: 0.05 } }),
      );

      expect(report.targets).toHaveLength(1);
      const [target] = report.targets;
      expect(target.kind).toBe("ok");
      expect(target.worst!.ratio).toBeCloseTo(1, 6);
      expect(target.worst!.rest.x).toBeCloseTo(
        0.25 + 0.05 * (-1 / 6 - 0.25),
        9,
      );
      expect(target.worst!.rest.y).toBeCloseTo(-1 / 6, 9);
    });

    it("(d) a static reflection is in both baselines: ok, ratio 1", () => {
      const [target] = checkFolds(
        underHead({ transform: { x: 0, y: 0, scaleX: -1 } }),
      ).targets;

      expect(target.kind).toBe("ok");
      expect(target.worst!.ratio).toBeCloseTo(1, 6);
    });

    it("(e) a bound scale counts: from 0 to -0.5 adds onto 1, ratio 0.5 at the max", () => {
      const [target] = checkFolds(
        underHead({
          bindings: [
            {
              parameter: "ParamAngleX",
              channel: "scaleX",
              from: 0,
              to: -0.5,
            },
          ],
        }),
      ).targets;

      expect(target.kind).toBe("ok");
      expect(target.worst!.ratio).toBeCloseTo(0.5, 6);
      expect(target.worst!.pose.name).toBe("ParamAngleX=30");
    });
  });

  it("a part's own bound scale counts too: scaleY down to 0.05 is a collapse", () => {
    const m = model(
      [ANGLE_X],
      [],
      [
        meshPart("p", TRIANGLE, [0, 1, 2], {
          bindings: [
            {
              parameter: "ParamAngleX",
              channel: "scaleY",
              from: 0,
              to: -0.95,
            },
          ],
        }),
      ],
    );
    const [target] = checkFolds(m).targets;

    expect(target.kind).toBe("collapse");
    expect(target.worst!.ratio).toBeCloseTo(0.05, 6);
    expect(target.worst!.pose.name).toBe("ParamAngleX=30");
  });

  it("(f) a triangle degenerate at rest is not reported, whatever its pose", () => {
    // Triangle 0 runs (-0.5, -0.5), (0, -0.5), (0.5, -0.5): a line, which the
    // keyform opens clockwise at 30. Triangle 1 is TRIANGLE, left alone.
    const m = model(
      [ANGLE_X],
      [],
      [
        meshPart("p", [...TRIANGLE, 0, -0.5], [0, 3, 1, 0, 1, 2], {
          warps: [
            {
              parameter: "ParamAngleX",
              keyforms: [
                { value: 0, offsets: new Array<number>(8).fill(0) },
                { value: 30, offsets: [0, 0, 0, 0, 0, 0, 0, 0.5] },
              ],
            },
          ],
        }),
      ],
    );
    const report = checkFolds(m);
    const [target] = report.targets;

    expect(target.kind).toBe("ok");
    expect(target.worst!.where).toEqual({ triangle: 1 });
    expect(target.worst!.ratio).toBeCloseTo(1, 6);
    expect(report.offenders).toEqual([]);
  });

  describe("(g) a warp child inside a clean, undeformed grid", () => {
    it("is ok with ratio 1 at rest", () => {
      const report = checkFolds(
        model(
          [],
          [{ kind: "warp", id: "w", grid: makeRestGrid() }],
          [meshPart("p", TRIANGLE, [0, 1, 2], { deformer: "w" })],
        ),
      );
      const target = report.targets[1];

      expect(target.target).toEqual({ kind: "part", id: "p" });
      expect(target.kind).toBe("ok");
      expect(target.worst!.ratio).toBeCloseTo(1, 6);
      expect(target.worst!.pose.name).toBe("rest");
    });

    it("stays ratio 1 under a scaled parent: the warp's parent world is in the baseline", () => {
      const report = checkFolds(
        model(
          [],
          [
            {
              id: "head",
              pivot: { x: 0, y: 0 },
              transform: { x: 0, y: 0, scaleX: 0.5 },
            },
            { kind: "warp", id: "w", parent: "head", grid: makeRestGrid() },
          ],
          [meshPart("p", TRIANGLE, [0, 1, 2], { deformer: "w" })],
        ),
      );
      const target = report.targets[1];

      expect(target.kind).toBe("ok");
      expect(target.worst!.ratio).toBeCloseTo(1, 6);
      expect(target.worst!.rest.x).toBeCloseTo(-1 / 12, 9);
      expect(target.worst!.rest.y).toBeCloseTo(-1 / 6, 9);
    });
  });

  it("(h) a vertex pinned to the rest grid's edge folds already at rest: flat beyond it, thinner across it", () => {
    const m = model(
      [],
      [{ kind: "warp", id: "w", grid: makeRestGrid() }],
      [
        // (1.25, 0), (1.75, 0), (1.25, 0.25): wholly right of the edge x = 1.
        meshPart("beyond", [-0.25, 0, 0.25, 0, -0.25, 0.25], [0, 1, 2], {
          deformer: "w",
          transform: { x: 1.5, y: 0 },
        }),
        // (0.5, 0), (1.5, 0), (0.5, 0.5): only (1.5, 0) lies past the edge.
        meshPart("straddles", [-0.5, 0, 0.5, 0, -0.5, 0.5], [0, 1, 2], {
          deformer: "w",
          transform: { x: 1, y: 0 },
        }),
      ],
    );
    const report = checkFolds(m);
    const [, beyond, straddles] = report.targets;

    expect(beyond.target).toEqual({ kind: "part", id: "beyond" });
    expect(beyond.kind).toBe("flip");
    expect(beyond.worst!.ratio).toBeCloseTo(0, 9);
    expect(beyond.worst!.pose.name).toBe("rest");
    // The baseline is not pinned: its centroid stays past the edge.
    expect(beyond.worst!.rest.x).toBeCloseTo(4.25 / 3, 9);

    expect(straddles.target).toEqual({ kind: "part", id: "straddles" });
    expect(straddles.worst!.ratio).toBeLessThan(1);
    expect(straddles.worst!.ratio).toBeCloseTo(0.5, 6);
    expect(straddles.kind).toBe("ok");
    expect(report.offenders).toEqual([beyond]);
  });

  it("the expected predicate sees the part as its target", () => {
    const m = model(
      [ANGLE_X],
      [],
      [
        meshPart("p", TRIANGLE, [0, 1, 2], {
          warps: angleXMeshWarp([0, 0, 0, 0, 0, -2]),
        }),
      ],
    );
    const report = checkFolds(m, {
      expected: (target, _pose, value) =>
        target.kind === "part" &&
        target.id === "p" &&
        value("ParamAngleX") === 30,
    });
    const [target] = report.targets;

    expect(target.kind).toBe("ok");
    expect(target.expected!.ratio).toBeCloseTo(-1, 6);
    expect(target.expected!.pose.name).toBe("ParamAngleX=30");
    expect(target.worst!.ratio).toBeCloseTo(1, 6);
  });
});

// --- foldPoses ---------------------------------------------------------------

describe("foldPoses", () => {
  const BODY = ["ParamBodyAngleX", "ParamBodyAngleY", "ParamBodyAngleZ"].map(
    (id): IkiParameter => ({ id, min: -10, max: 10, default: 0 }),
  );
  const ARMS = ["ParamArmL", "ParamArmR", "ParamElbowL", "ParamElbowR"].map(
    (id): IkiParameter => ({ id, min: -10, max: 90, default: 0 }),
  );
  const HEAD = [ANGLE_X, ANGLE_Y, ANGLE_Z, EYE_L, EYE_R, MOUTH];
  const crosses = (poses: FoldPose[]) =>
    poses.filter((p) => Object.keys(p.values).length > 1);

  it("a model with no parameters yields exactly rest", () => {
    expect(foldPoses(model([]))).toEqual([{ name: "rest", values: {} }]);
  });

  it("head angles, eyes and mouth: rest, the singles, then 8 angle corners alone and × 8 crosses", () => {
    const poses = foldPoses(model(HEAD));
    const names = poses.map((p) => p.name);

    expect(poses[0]).toEqual({ name: "rest", values: {} });
    expect(new Set(names).size).toBe(names.length);
    expect(
      poses.slice(1, 13).every((p) => Object.keys(p.values).length === 1),
    ).toBe(true);
    expect(crosses(poses)).toHaveLength(8 + 8 * 8);
    expect(poses).toHaveLength(1 + HEAD.length * 2 + 8 + 8 * 8);
    // The angle corners come alone, the other parameters at their defaults.
    expect(names).toContain("ParamAngleX=30 ParamAngleY=30 ParamAngleZ=30");
    expect(names).toContain(
      "ParamAngleX=-30 ParamAngleY=30 ParamAngleZ=-30 ParamEyeLOpen=0 ParamEyeROpen=0 ParamMouthOpenY=1",
    );
    // Each eye takes its own end, so a wink meets a turn.
    expect(names).toContain(
      "ParamAngleX=30 ParamAngleY=-30 ParamAngleZ=-30 ParamEyeLOpen=0 ParamEyeROpen=1 ParamMouthOpenY=0",
    );
  });

  it("body angles and arms widen the corner poses to at most 2112", () => {
    const poses = foldPoses(model([...HEAD, ...BODY, ...ARMS]));
    const names = poses.map((p) => p.name);

    expect(new Set(names).size).toBe(names.length);
    expect(crosses(poses)).toHaveLength(64 + 64 * 32);
    expect(
      crosses(poses).every(
        (p) =>
          p.values.ParamArmL === p.values.ParamArmR &&
          p.values.ParamElbowL === p.values.ParamElbowR,
      ),
    ).toBe(true);
  });

  it("every name round-trips to its values", () => {
    for (const pose of foldPoses(model([...HEAD, ...BODY, ...ARMS]))) {
      expect(parseName(pose.name)).toEqual(pose.values);
    }
  });

  it("no angle parameter: rest and the singles only; a fixed parameter has none", () => {
    const fixed: IkiParameter = { id: "Fixed", min: 2, max: 2, default: 2 };
    const poses = foldPoses(model([EYE_L, EYE_R, MOUTH, ...ARMS, fixed]));

    expect(poses).toHaveLength(1 + 7 * 2);
    expect(crosses(poses)).toEqual([]);
    expect(poses.some((p) => "Fixed" in p.values)).toBe(false);
  });
});

// --- the shipped hero ---------------------------------------------------------

describe("checkFolds — examples/playground/public/hero.iki", () => {
  const hero = loadIkiModel(
    fs.readFileSync(
      new URL("../../../examples/playground/public/hero.iki", import.meta.url),
      "utf8",
    ),
  );
  const report = checkFolds(hero);

  it("checks every foldPoses pose and gives every warp deformer and mesh part a target", () => {
    expect(report.poses).toBe(foldPoses(hero).length);
    const ids = new Set(report.targets.map((t) => t.target.id));
    for (const d of hero.deformers ?? []) {
      if (d.kind === "warp") expect(ids).toContain(d.id);
    }
    for (const p of hero.parts) {
      if (p.mesh) expect(ids).toContain(p.id);
    }
  });

  it("folds only where the eyes close", () => {
    // Without a predicate the closures read as offenders; the predicate that
    // classes them as by design lives in @ikijs/mcp.
    expect(report.offenders.map((t) => t.target.id).sort()).toEqual([
      "eye_L",
      "eye_R",
      "lash_lower_L",
      "lash_lower_R",
    ]);
    for (const t of report.offenders) {
      expect(t.kind).not.toBe("ok");
      expect(t.worst!.pose.values.ParamEyeLOpen).toBe(0);
      expect(t.worst!.pose.values.ParamEyeROpen).toBe(0);
      expect(Math.abs(t.worst!.ratio)).toBeLessThan(1e-3);
    }
  });

  it("keeps the mouth clear of the collapse threshold", () => {
    const mouth = report.targets.find((t) => t.target.id === "mouth_open")!;
    expect(mouth.kind).toBe("ok");
    expect(mouth.worst!.ratio).toBeGreaterThan(0.1);
  });
});
