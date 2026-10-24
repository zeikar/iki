import { describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  loadIkiModel,
  type IkiModel,
  type IkiParameter,
  type IkiPart,
} from "@ikijs/format";
import {
  foldPoses,
  type FoldHit,
  type FoldReport,
  type FoldTarget,
} from "@ikijs/engine";
import {
  checkModelFolds,
  foldPose,
  formatFoldReport,
} from "../src/fold-report";

// --- formatFoldReport ---------------------------------------------------------

const CANVAS = { width: 1100, height: 1100 };

function hit(
  ratio: number,
  where: FoldHit["where"],
  name: string,
  rest: { x: number; y: number },
): FoldHit {
  return { ratio, where, pose: { name, values: {} }, rest };
}

function report(targets: FoldTarget[]): FoldReport {
  return {
    poses: 64,
    thresholds: { flip: 0, collapse: 0.1 },
    targets,
    offenders: targets
      .filter((t) => t.kind !== "ok")
      .sort((a, b) => a.worst!.ratio - b.worst!.ratio),
  };
}

describe("formatFoldReport", () => {
  it("prints each offender on its own FOLD line, worst first, its rest point in model space and in model px from the top-left", () => {
    const cell: FoldTarget = {
      target: { kind: "deformer", id: "face_warp" },
      kind: "flip",
      worst: hit(
        -0.123,
        { col: 2, row: 3 },
        "ParamAngleX=30 ParamMouthOpenY=1",
        { x: 12.34, y: -45.66 },
      ),
    };
    // A hair under 0: still a flip, so it must not read -0.00.
    const sliver: FoldTarget = {
      target: { kind: "part", id: "brow_L" },
      kind: "flip",
      worst: hit(-0.0000123, { triangle: 2 }, "rest", { x: 0, y: 0 }),
    };
    const triangle: FoldTarget = {
      target: { kind: "part", id: "hair_front" },
      kind: "collapse",
      worst: hit(0.0549, { triangle: 7 }, "ParamAngleY=-30", {
        x: -100,
        y: 200,
      }),
    };
    const fine: FoldTarget = {
      target: { kind: "part", id: "face" },
      kind: "ok",
      worst: hit(0.8, { triangle: 0 }, "rest", { x: 0, y: 0 }),
    };

    expect(
      formatFoldReport(report([triangle, fine, sliver, cell]), CANVAS),
    ).toEqual([
      "FOLD flip deformer face_warp cell (2,3) ratio -0.12 pose [ParamAngleX=30 ParamMouthOpenY=1] rest at (12.3, -45.7) model space, (562, 596) model px from the top-left",
      "FOLD flip part brow_L triangle 2 ratio -1.2e-5 pose [rest] rest at (0.0, 0.0) model space, (550, 550) model px from the top-left",
      "FOLD collapse part hair_front triangle 7 ratio 0.05 pose [ParamAngleY=-30] rest at (-100.0, 200.0) model space, (450, 350) model px from the top-left",
    ]);
  });

  it("prints FOLDS: none with the pose count, then each by-design closure that folds by id, ratio and the parameter that shuts it", () => {
    const eye: FoldTarget = {
      target: { kind: "part", id: "eye_L" },
      kind: "ok",
      worst: hit(0.9, { triangle: 1 }, "rest", { x: 0, y: 0 }),
      expected: hit(0, { triangle: 4 }, "ParamEyeLOpen=0", { x: 60, y: 40 }),
    };
    const lip: FoldTarget = {
      target: { kind: "part", id: "lip_upper" },
      kind: "ok",
      worst: hit(0.7, { triangle: 0 }, "ParamMouthOpenY=1", { x: 0, y: 0 }),
      expected: hit(0.08, { triangle: 2 }, "ParamMouthForm=-1", {
        x: 0,
        y: -150,
      }),
    };
    // Set apart as expected but never near a fold: no closure to list.
    const teeth: FoldTarget = {
      target: { kind: "part", id: "mouth_teeth" },
      kind: "ok",
      worst: hit(1, { triangle: 0 }, "ParamMouthOpenY=1", { x: 0, y: 0 }),
      expected: hit(0.9, { triangle: 0 }, "rest", { x: 0, y: -150 }),
    };

    expect(formatFoldReport(report([eye, lip, teeth]), CANVAS)).toEqual([
      "FOLDS: none over 64 poses",
      "FOLDS expected: by-design closures, not findings — " +
        "eye_L 0 at ParamEyeLOpen=0, lip_upper 0.08 at ParamMouthOpenY=0",
    ]);
  });

  it("prints an offender's own FOLD line beside its expected closure, and a closure another predicate set apart without a parameter", () => {
    const lip: FoldTarget = {
      target: { kind: "part", id: "lip_upper" },
      kind: "collapse",
      worst: hit(0.05, { triangle: 0 }, "ParamAngleX=30 ParamMouthOpenY=1", {
        x: 0,
        y: 0,
      }),
      expected: hit(-3e-7, { triangle: 0 }, "rest", { x: 0, y: 0 }),
    };
    const custom: FoldTarget = {
      target: { kind: "deformer", id: "w" },
      kind: "ok",
      worst: hit(1, { col: 0, row: 0 }, "rest", { x: 0, y: 0 }),
      expected: hit(0.02, { col: 1, row: 0 }, "ParamAngleX=30", { x: 0, y: 0 }),
    };

    const lines = formatFoldReport(report([lip, custom]), CANVAS);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^FOLD collapse part lip_upper triangle 0 ratio 0\.05 pose \[ParamAngleX=30 ParamMouthOpenY=1\] /,
    );
    expect(lines[1]).toBe(
      "FOLDS expected: by-design closures, not findings — " +
        "lip_upper -3.0e-7 at ParamMouthOpenY=0, w 0.02",
    );
  });
});

// --- checkModelFolds ----------------------------------------------------------

const ANGLE_X: IkiParameter = {
  id: "ParamAngleX",
  min: -30,
  max: 30,
  default: 0,
};
const MOUTH: IkiParameter = {
  id: "ParamMouthOpenY",
  min: 0,
  max: 1,
  default: 0,
};
const EYE_L: IkiParameter = {
  id: "ParamEyeLOpen",
  min: 0,
  max: 1,
  default: 1,
};
const EYE_R: IkiParameter = { ...EYE_L, id: "ParamEyeROpen" };

/** One counter-clockwise right triangle: corner (-0.5, -0.5), legs of 1. */
const TRIANGLE = [-0.5, -0.5, 0.5, -0.5, -0.5, 0.5];
const STILL = [0, 0, 0, 0, 0, 0];
/** The top vertex dropped onto the base: the triangle flattened to nothing. */
const FLAT = [0, 0, 0, 0, 0, -1];

function triangle(id: string, warps: IkiPart["warps"]): IkiPart {
  return {
    id,
    color: [1, 1, 1, 1],
    width: 1,
    height: 1,
    transform: { x: 0, y: 0 },
    order: 0,
    mesh: { vertices: TRIANGLE, uvs: STILL, indices: [0, 1, 2] },
    warps,
  };
}

function model(parameters: IkiParameter[], parts: IkiPart[]): IkiModel {
  return {
    version: 1,
    name: "t",
    canvas: { width: 100, height: 100 },
    parameters,
    parts,
  };
}

const byId = (report: FoldReport, id: string) =>
  report.targets.find((t) => t.target.id === id)!;

describe("checkModelFolds", () => {
  it("sets a lip part's shut fold apart through the mouth's default, and keeps its open-mouth collapse actionable", () => {
    // Shut (the default) the triangle is flat; at ParamAngleX 30 its base
    // shrinks to 5 %, which only shows with the mouth open.
    const m = model(
      [ANGLE_X, MOUTH],
      [
        triangle("lip_upper", [
          {
            parameter: "ParamMouthOpenY",
            keyforms: [
              { value: 0, offsets: FLAT },
              { value: 1, offsets: STILL },
            ],
          },
          {
            parameter: "ParamAngleX",
            keyforms: [
              { value: 0, offsets: STILL },
              { value: 30, offsets: [0, 0, -0.95, 0, 0, 0] },
            ],
          },
        ]),
      ],
    );
    const report = checkModelFolds(m);
    const lip = byId(report, "lip_upper");

    expect(lip.expected!.pose.name).toBe("rest");
    expect(lip.expected!.ratio).toBeCloseTo(0, 6);
    expect(lip.kind).toBe("collapse");
    expect(lip.worst!.pose.name).toBe("ParamAngleX=30 ParamMouthOpenY=1");
    expect(lip.worst!.ratio).toBeCloseTo(0.05, 5);
    expect(report.offenders).toEqual([lip]);
  });

  it("keys each eye part to its own side: a closed left eye is expected, a right eye folding with it is not", () => {
    const closesWithLeft: IkiPart["warps"] = [
      {
        parameter: "ParamEyeLOpen",
        keyforms: [
          { value: 0, offsets: FLAT },
          { value: 1, offsets: STILL },
        ],
      },
    ];
    const m = model(
      [EYE_L, EYE_R],
      [
        triangle("eye_L", closesWithLeft),
        triangle("lash_lower_L", closesWithLeft),
        triangle("eye_R", closesWithLeft),
        triangle("lash_lower_R", closesWithLeft),
      ],
    );
    const report = checkModelFolds(m);

    for (const id of ["eye_L", "lash_lower_L"]) {
      const t = byId(report, id);
      expect(t.kind, id).toBe("ok");
      expect(t.expected!.pose.name, id).toBe("ParamEyeLOpen=0");
    }
    for (const id of ["eye_R", "lash_lower_R"]) {
      const t = byId(report, id);
      expect(t.kind, id).toBe("flip");
      expect(t.worst!.pose.name, id).toBe("ParamEyeLOpen=0");
      // Only its own lid's closure is set apart, and it stays open there.
      expect(t.expected!.pose.name, id).toBe("ParamEyeROpen=0");
      expect(t.expected!.ratio, id).toBeCloseTo(1, 6);
    }
    expect(report.offenders.map((t) => t.target.id).sort()).toEqual([
      "eye_R",
      "lash_lower_R",
    ]);
  });

  it("counts no closure for a part whose shutting parameter the model does not declare", () => {
    const m = model(
      [ANGLE_X],
      [
        triangle("eye_R", [
          {
            parameter: "ParamAngleX",
            keyforms: [
              { value: 0, offsets: STILL },
              { value: 30, offsets: FLAT },
            ],
          },
        ]),
      ],
    );
    const [target] = checkModelFolds(m).offenders;

    expect(target.target.id).toBe("eye_R");
    expect(target.kind).toBe("flip");
    expect(target.expected).toBeUndefined();
  });

  it("leaves a fold on a part outside the closures actionable at the same pose", () => {
    const m = model(
      [MOUTH],
      [
        triangle("mouth_open", [
          {
            parameter: "ParamMouthOpenY",
            keyforms: [
              { value: 0, offsets: FLAT },
              { value: 1, offsets: STILL },
            ],
          },
        ]),
      ],
    );
    const [target] = checkModelFolds(m).offenders;

    expect(target.target).toEqual({ kind: "part", id: "mouth_open" });
    expect(target.worst!.pose.name).toBe("rest");
    expect(target.expected).toBeUndefined();
  });

  // Flat only at ParamAngleX -15, which no default pose reaches.
  const flatAtMinus15 = () =>
    triangle("face", [
      {
        parameter: "ParamAngleX",
        keyforms: [
          { value: -30, offsets: STILL },
          { value: -15, offsets: FLAT },
          { value: 0, offsets: STILL },
          { value: 30, offsets: STILL },
        ],
      },
    ]);

  it("sweeps an extra value set after the engine's own poses and names its fold by the settings, not a caller's name", () => {
    const m = model([ANGLE_X], [flatAtMinus15()]);
    const plain = checkModelFolds(m);
    expect(plain.offenders).toEqual([]);

    // All renderPoses hands over for a pose it writes as rest.png: its values.
    const report = checkModelFolds(m, [{ ParamAngleX: -15 }]);

    expect(report.poses).toBe(plain.poses + 1);
    const [face] = report.offenders;
    expect(face.target.id).toBe("face");
    expect(face.kind).toBe("flip");
    expect(face.worst!.pose).toEqual({
      name: "ParamAngleX=-15",
      values: { ParamAngleX: -15 },
    });
    const lines = formatFoldReport(report, m.canvas);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/ pose \[ParamAngleX=-15\] /);
    expect(lines[0]).not.toContain("[rest]");
  });

  it("appends a set equal to a default pose without merging it, and names a set of several by its sorted pairs", () => {
    const m = model([ANGLE_X, MOUTH], [flatAtMinus15()]);
    const plain = checkModelFolds(m);

    const report = checkModelFolds(m, [
      {},
      { ParamMouthOpenY: 1, ParamAngleX: -15 },
    ]);

    expect(report.poses).toBe(plain.poses + 2);
    expect(report.offenders[0].worst!.pose.name).toBe(
      "ParamAngleX=-15 ParamMouthOpenY=1",
    );
    // The default `rest` pose ties it first, so the report cannot show it.
    expect(foldPose({}).name).toBe("rest");
  });

  it("names an extra value set exactly as the engine names the same default pose", () => {
    // Angle corners crossed with the mouth: rest, singles and two-id sets.
    const m = model([ANGLE_X, MOUTH], [flatAtMinus15()]);
    const defaults = foldPoses(m);
    expect(defaults.map((p) => p.name)).toContain(
      "ParamAngleX=30 ParamMouthOpenY=1",
    );

    for (const pose of defaults) {
      // Shuffled key order: the name must not follow it.
      const values = Object.fromEntries(Object.entries(pose.values).reverse());
      expect(foldPose(values).name).toBe(pose.name);
    }
  });

  it("finds no offender on the playground hero: its eye and mouth closures are all expected", () => {
    const hero = loadIkiModel(
      fs.readFileSync(
        new URL(
          "../../../examples/playground/public/hero.iki",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const report = checkModelFolds(hero);

    expect(report.offenders).toEqual([]);
    const closures = report.targets.filter(
      (t) => t.expected !== undefined && t.expected.ratio < 0.1,
    );
    expect(closures.map((t) => t.target.id).sort()).toEqual([
      "eye_L",
      "eye_R",
      "lash_lower_L",
      "lash_lower_R",
      "lip_upper",
      "mouth_inner",
    ]);
  });
});
