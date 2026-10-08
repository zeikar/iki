import { describe, expect, it } from "vitest";
import { StandardParameter } from "@ikijs/format";

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
      BodyAngleX: "ParamBodyAngleX",
      BodyAngleY: "ParamBodyAngleY",
      BodyAngleZ: "ParamBodyAngleZ",
      Breath: "ParamBreath",
      BrowLeftY: "ParamBrowLY",
      BrowRightY: "ParamBrowRY",
      BrowLeftAngle: "ParamBrowLAngle",
      BrowRightAngle: "ParamBrowRAngle",
      Cheek: "ParamCheek",
      HairSwayX: "ParamHairSwayX",
      HairSwayZ: "ParamHairSwayZ",
      ArmLeft: "ParamArmL",
      ArmRight: "ParamArmR",
      ElbowLeft: "ParamElbowL",
      ElbowRight: "ParamElbowR",
      ArmPoseLeft: "ParamArmPoseL",
      ArmPoseRight: "ParamArmPoseR",
      ArmPoseAngleLeft: "ParamArmPoseAngleL",
      ArmPoseAngleRight: "ParamArmPoseAngleR",
    });
  });
});
