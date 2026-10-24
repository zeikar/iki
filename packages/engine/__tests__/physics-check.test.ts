import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { loadIkiModel } from "@ikijs/format";
import { checkPhysics, type PhysicsTarget } from "@ikijs/engine";

function expectNear(actual: number, expected: number, within: number): void {
  expect(Math.abs(actual - expected)).toBeLessThan(within);
}

// --- the shipped hero ---------------------------------------------------------

describe("checkPhysics — examples/playground/public/bob.iki", () => {
  const bob = loadIkiModel(
    fs.readFileSync(
      new URL("../../../examples/playground/public/bob.iki", import.meta.url),
      "utf8",
    ),
  );
  const report = checkPhysics(bob);
  const target = (id: string): PhysicsTarget =>
    report.targets.find((t) => t.rig.id === id)!;

  it("reads both default hair springs as ok", () => {
    expect(report.targets.map((t) => [t.rig, t.kind])).toEqual([
      [{ kind: "spring", id: "hairSway" }, "ok"],
      [{ kind: "spring", id: "hairTilt" }, "ok"],
    ]);
    expect(report.offenders).toEqual([]);
  });

  it("steps hairSway's head turn to its far end and settles at the scaled target", () => {
    const { input, output, step } = target("hairSway");
    expect(input).toEqual(["ParamAngleX"]);
    expect(output).toBe("ParamHairSwayX");
    expect(step.values).toEqual({ ParamAngleX: 30 });
    expectNear(step.peak, 7.02, 0.05);
    expectNear(step.at, 0.58, 0.03);
    expectNear(step.final, 5.0, 0.05);
    expectNear(step.displacementPx, 5.08, 0.1);
  });

  it("steps hairTilt's head roll the same way and overshoots further", () => {
    const { input, output, step } = target("hairTilt");
    expect(input).toEqual(["ParamAngleZ"]);
    expect(output).toBe("ParamHairSwayZ");
    expect(step.values).toEqual({ ParamAngleZ: 30 });
    expectNear(step.peak, 11.53, 0.05);
    expectNear(step.displacementPx, 8.35, 0.1);
  });

  it("finds the two hair parts each spring drives", () => {
    for (const t of report.targets) {
      expect(t.drives).toEqual([
        { kind: "part", id: "hair_back" },
        { kind: "part", id: "hair_front" },
      ]);
    }
  });

  it("reads each output's idle peak as a size, the sway going both ways", () => {
    expectNear(target("hairSway").idle.peak, 0.6, 0.05);
    expectNear(target("hairTilt").idle.peak, 0.3, 0.05);
  });

  it("is deterministic", () => {
    expect(checkPhysics(bob)).toEqual(report);
  });
});
