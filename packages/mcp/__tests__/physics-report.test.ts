import { describe, expect, it } from "vitest";
import type { PhysicsReport, PhysicsTarget } from "@ikijs/engine";
import { formatPhysicsReport } from "../src/physics-report";

function report(targets: PhysicsTarget[]): PhysicsReport {
  return {
    thresholds: { displacementPx: 1, pinnedFrames: 60 },
    targets,
    offenders: [
      ...targets.filter((t) => t.kind === "unstable"),
      ...targets.filter((t) => t.kind === "frozen"),
    ],
  };
}

const hairSway: PhysicsTarget = {
  rig: { kind: "spring", id: "hairSway" },
  input: ["ParamAngleX"],
  output: "ParamHairSwayX",
  drives: [
    { kind: "part", id: "hair_back" },
    { kind: "part", id: "hair_front" },
  ],
  kind: "ok",
  step: {
    values: { ParamAngleX: 30 },
    peak: 7.0213,
    at: 0.5833,
    final: 4.9991,
    displacementPx: 5.06,
  },
  idle: { peak: 0.5962, at: 16.9, displacementPx: 0.43 },
};

describe("formatPhysicsReport", () => {
  it("prints one PHYSICS line per target in the report's order, a why only on a flagged one", () => {
    // A rig scaled to 0: its input has a range, it drives the face, but it
    // moves nothing. The px floor keeps 0.96 from reading 1.0.
    const still: PhysicsTarget = {
      rig: { kind: "spring", id: "faceSway" },
      input: ["ParamAngleY"],
      output: "ParamFaceSway",
      drives: [{ kind: "deformer", id: "faceWarp" }],
      kind: "frozen",
      why: "moves 0.9 model px over the step",
      step: {
        values: { ParamAngleY: -30 },
        peak: -0.004,
        at: 0.25,
        final: 0,
        displacementPx: 0.96,
      },
      idle: { peak: 0, at: 0, displacementPx: 0 },
    };
    const lock: PhysicsTarget = {
      rig: { kind: "chain", id: "lockL", segment: 1 },
      input: ["ParamAngleX", "ParamAngleZ"],
      output: "ParamLockL1",
      drives: [{ kind: "part", id: "lockL_band2" }],
      kind: "unstable",
      why: "pinned at ParamLockL1 min -0.1 for 299 frames of the step ParamAngleZ=-30",
      step: {
        values: { ParamAngleX: 30 },
        peak: 12.3456,
        at: 1.2,
        final: 3,
        displacementPx: 12.34,
      },
      idle: { peak: 2.5, at: 3.456, displacementPx: 4 },
    };

    expect(formatPhysicsReport(report([hairSway, still, lock]))).toEqual([
      "PHYSICS ok hairSway ParamAngleX -> ParamHairSwayX: step ParamAngleX=30 peak 7.02 at 0.58 s, final 5.00, moves 5.0 model px (hair_back, hair_front); idle peak 0.60 at 16.90 s, 0.4 model px",
      "PHYSICS frozen faceSway ParamAngleY -> ParamFaceSway: step ParamAngleY=-30 peak -0.00 at 0.25 s, final 0.00, moves 0.9 model px (faceWarp); idle peak 0.00 at 0.00 s, 0.0 model px — moves 0.9 model px over the step",
      "PHYSICS unstable lockL/1 [ParamAngleX, ParamAngleZ] -> ParamLockL1: step ParamAngleX=30 peak 12.35 at 1.20 s, final 3.00, moves 12.3 model px (lockL_band2); idle peak 2.50 at 3.46 s, 4.0 model px — pinned at ParamLockL1 min -0.1 for 299 frames of the step ParamAngleZ=-30",
    ]);
  });

  it("names an unexcited step rest and leaves out the drives when the output drives nothing", () => {
    const orphan: PhysicsTarget = {
      rig: { kind: "chain", id: "lockR", segment: 0 },
      input: [],
      output: "ParamLockR0",
      drives: [],
      kind: "frozen",
      why: "drives nothing",
      step: { values: {}, peak: 0, at: 0, final: 0, displacementPx: 0 },
      idle: { peak: 0, at: 0, displacementPx: 0 },
    };

    expect(formatPhysicsReport(report([orphan]))).toEqual([
      "PHYSICS frozen lockR/0 [] -> ParamLockR0: step rest peak 0.00 at 0.00 s, final 0.00, moves 0.0 model px; idle peak 0.00 at 0.00 s, 0.0 model px — drives nothing",
    ]);
  });

  it("prints PHYSICS: no rigs for a model without physics", () => {
    expect(formatPhysicsReport(report([]))).toEqual(["PHYSICS: no rigs"]);
  });
});
