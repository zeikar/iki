import { describe, expect, it } from "vitest";
import { StandardParameter } from "@iki/format";

describe("StandardParameter", () => {
  it("locks the Live2D-style ids hosts rely on for per-model wiring", () => {
    expect(StandardParameter).toEqual({
      MouthOpen: "ParamMouthOpenY",
      MouthForm: "ParamMouthForm",
      EyeOpenLeft: "ParamEyeLOpen",
      EyeOpenRight: "ParamEyeROpen",
      EyeballX: "ParamEyeBallX",
      EyeballY: "ParamEyeBallY",
      AngleX: "ParamAngleX",
      AngleY: "ParamAngleY",
      AngleZ: "ParamAngleZ",
      Breath: "ParamBreath",
    });
  });
});
