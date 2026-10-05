import { describe, expect, it } from "vitest";
import type {
  IkiDeformer,
  IkiExpression,
  IkiModel,
  IkiMotionClip,
  IkiPhysics,
  IkiPhysicsChain,
} from "@ikijs/format";
import { IDLE_MOTION_GROUP, StandardParameter } from "@ikijs/format";
import { IkiMotion } from "@ikijs/engine";

// --- Fixture ------------------------------------------------------------------

const RIG_OUT = "ParamHairSwayX";
const SEG0_OUT = "ParamLockSeg0";

const PARAMS = [
  { id: StandardParameter.EyeOpenLeft, min: 0, max: 1, default: 1 },
  { id: StandardParameter.EyeOpenRight, min: 0, max: 1, default: 1 },
  { id: StandardParameter.Breath, min: 0, max: 1, default: 0.5 },
  { id: StandardParameter.EyeballX, min: -1, max: 1, default: 0 },
  { id: StandardParameter.EyeballY, min: -1, max: 1, default: 0 },
  { id: StandardParameter.AngleX, min: -30, max: 30, default: 0 },
  { id: StandardParameter.AngleY, min: -30, max: 30, default: 0 },
  { id: StandardParameter.AngleZ, min: -30, max: 30, default: 0 },
  { id: StandardParameter.BrowLeftY, min: -1, max: 1, default: 0 },
  { id: RIG_OUT, min: -20, max: 20, default: 0 },
  { id: SEG0_OUT, min: -60, max: 60, default: 0 },
];

// A matrix deformer with an AngleX→rotate binding, for the chain's anchor
// (copied from iki-motion.test.ts).
const HEAD_DEFORMER: IkiDeformer = {
  kind: "matrix",
  id: "headDeformer",
  pivot: { x: 0, y: 0 },
  transform: { x: 0, y: 0, rotation: 0 },
  bindings: [
    {
      parameter: StandardParameter.AngleX,
      channel: "rotate",
      from: -30,
      to: 30,
    },
  ],
};

function clip(parameter: string, value: number): IkiMotionClip {
  return {
    description: "test clip",
    duration: 1,
    curves: [{ parameter, keys: [[0, value]] }],
  };
}

const SMILE: IkiExpression = {
  id: "smile",
  description: "test expression",
  parameters: [
    { parameter: StandardParameter.EyeOpenLeft, value: 0.5, blend: "multiply" },
    { parameter: StandardParameter.BrowLeftY, value: 0.3 },
  ],
};

const RIG: IkiPhysics = {
  id: "sway",
  input: { parameter: StandardParameter.AngleX, weight: 1 },
  output: { parameter: RIG_OUT, scale: 10 },
  mass: 1,
  stiffness: 80,
  damping: 10,
};

const CHAIN: IkiPhysicsChain = {
  id: "chain",
  anchorDeformer: "headDeformer",
  gravity: { angle: -90, strength: 50 },
  segments: [
    {
      output: { parameter: SEG0_OUT, scale: 1 },
      mass: 1,
      stiffness: 8,
      damping: 5,
    },
  ],
};

/** An Idle group on AngleX, a one-shot "Nod" on AngleY, SMILE, a rig, a chain. */
function animatedModel(): IkiModel {
  return {
    version: 1,
    name: "t",
    canvas: { width: 100, height: 100 },
    parameters: PARAMS,
    parts: [],
    deformers: [HEAD_DEFORMER],
    physics: [RIG],
    physicsChains: [CHAIN],
    expressions: [SMILE],
    motions: {
      [IDLE_MOTION_GROUP]: [clip(StandardParameter.AngleX, 10)],
      Nod: [clip(StandardParameter.AngleY, 5)],
    },
  };
}

// --- Tests ---------------------------------------------------------------------

describe("IkiMotion animations API", () => {
  it("returns false for an undeclared expression or motion group", () => {
    const motion = new IkiMotion(
      animatedModel(),
      () => 0,
      () => {},
    );

    expect(motion.playExpression("nope")).toBe(false);
    expect(motion.playMotion("Nope", 0)).toBe(false);
    // The declared ones are accepted, so the false above is the unknown name.
    expect(motion.playExpression("smile")).toBe(true);
    expect(motion.playMotion("Nod", 0)).toBe(true);
  });

  it("drivenParameterIds = idle minus head and gaze, curves, expressions, rig outputs, chain outputs, deduplicated", () => {
    const motion = new IkiMotion(
      animatedModel(),
      () => 0,
      () => {},
    );

    expect(motion.drivenParameterIds).toEqual([
      // Idle replaces the procedural head and gaze; blink and breath stay.
      StandardParameter.EyeOpenLeft,
      StandardParameter.EyeOpenRight,
      StandardParameter.Breath,
      // Curve parameters, group by group.
      StandardParameter.AngleX,
      StandardParameter.AngleY,
      // Expression parameters; EyeOpenLeft is already listed.
      StandardParameter.BrowLeftY,
      RIG_OUT,
      SEG0_OUT,
    ]);
  });
});
