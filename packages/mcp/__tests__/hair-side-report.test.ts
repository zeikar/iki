import { describe, expect, it } from "vitest";
import { formatHairSideReport } from "../src/hair-side-report";

const CANVAS = { width: 1100, height: 1100 };

describe("formatHairSideReport", () => {
  it("prints nothing without a side lock", () => {
    expect(formatHairSideReport(undefined, CANVAS)).toEqual([]);
  });

  it("prints a signed line per metric, naming each lock by its role", () => {
    expect(
      formatHairSideReport(
        {
          left: {
            role: "hair_side_R",
            cover: { deg: -30, px: -2.34, y: 189.5, rest: 5.06 },
            tail: {
              deg: -30,
              eyeToLock: -6.2,
              lashToLock: 3,
              eyeToPlate: 12.04,
            },
          },
          right: {
            role: "hair_side_L",
            cover: { deg: 30, px: 0, y: 40, rest: 0 },
          },
        },
        CANVAS,
      ),
    ).toEqual([
      "HAIRSIDE cover hair_side_R: the lock's outer edge -2.3 model px outside the head's edge at ParamAngleX=-30, +5.1 at rest (least over the rows it covers at rest, at model y 189.5, row 360 model px from the top; negative: the turn bares cheek the lock hides at rest)",
      "HAIRSIDE tail hair_side_R: eye -6.2 model px / lash +3.0 model px from the lock's face-side edge at ParamAngleX=-30 (negative: under the lock, intended), corner +12.0 model px from the head's edge (positive: inside it; negative: past it)",
      "HAIRSIDE cover hair_side_L: the lock's outer edge +0.0 model px outside the head's edge at ParamAngleX=30, +0.0 at rest (least over the rows it covers at rest, at model y 40.0, row 510 model px from the top; negative: the turn bares cheek the lock hides at rest)",
    ]);
  });

  it("never prints a negative zero", () => {
    const [line] = formatHairSideReport(
      {
        left: {
          role: "hair_side_R",
          cover: { deg: -15, px: -0.04, y: 0, rest: 1 },
        },
      },
      CANVAS,
    );
    expect(line).toContain("edge +0.0 model px");
  });

  it("leaves out the lash without a lash layer", () => {
    expect(
      formatHairSideReport(
        {
          left: {
            role: "hair_side_R",
            tail: { deg: -15, eyeToLock: 1, eyeToPlate: 2 },
          },
        },
        CANVAS,
      ),
    ).toEqual([
      "HAIRSIDE tail hair_side_R: eye +1.0 model px from the lock's face-side edge at ParamAngleX=-15 (negative: under the lock, intended), corner +2.0 model px from the head's edge (positive: inside it; negative: past it)",
    ]);
  });

  it("prints a lock with no rowRuns as unavailable and a lock with neither metric as such", () => {
    expect(
      formatHairSideReport(
        {
          left: { role: "hair_side_R", unavailable: "no rowRuns" },
          right: { role: "hair_side_L" },
        },
        CANVAS,
      ),
    ).toEqual([
      "HAIRSIDE hair_side_R: unavailable — no rowRuns",
      "HAIRSIDE hair_side_L: no cover or tail row",
    ]);
  });
});
