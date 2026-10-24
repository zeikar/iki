import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { loadIkiModel, parseIkiModel } from "@ikijs/format";
import type {
  IkiDeformer,
  IkiModel,
  IkiParameter,
  IkiPart,
  IkiPhysics,
  IkiPhysicsChain,
  IkiPhysicsChainSegment,
  IkiWarp,
} from "@ikijs/format";
import { checkPhysics, type PhysicsTarget } from "@ikijs/engine";

function expectNear(actual: number, expected: number, within: number): void {
  expect(Math.abs(actual - expected)).toBeLessThan(within);
}

// --- the shipped hero ---------------------------------------------------------

describe("checkPhysics — examples/playground/public/hero.iki", () => {
  const bob = loadIkiModel(
    fs.readFileSync(
      new URL("../../../examples/playground/public/hero.iki", import.meta.url),
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

  it("steps each of hairSway's inputs and reports the lagging head turn: a peak at its bound at once, then rest", () => {
    const { input, output, step } = target("hairSway");
    expect(input).toEqual(["ParamAngleX", "ParamAmbientSway"]);
    expect(output).toBe("ParamHairSwayX");
    expect(step.values).toEqual({ ParamAngleX: 30 });
    // The bound −scale·weight = −14, less one sub-step.
    expectNear(step.peak, -13.7, 0.05);
    expectNear(step.at, 0.02, 0.03);
    expectNear(step.final, 0, 0.05);
    expectNear(step.displacementPx, 9.92, 0.1);
  });

  it("steps hairTilt's head roll, which lags the same way", () => {
    const { input, output, step } = target("hairTilt");
    expect(input).toEqual(["ParamAngleZ"]);
    expect(output).toBe("ParamHairSwayZ");
    expect(step.values).toEqual({ ParamAngleZ: 30 });
    expectNear(step.peak, -8.81, 0.05);
    expectNear(step.final, 0, 0.05);
    expectNear(step.displacementPx, 6.38, 0.1);
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
    // The ambient sway drives hairSway in idle; hairTilt lags the idle's slow
    // roll alone, so it barely stirs.
    expectNear(target("hairSway").idle.peak, 3.68, 0.05);
    expectNear(target("hairTilt").idle.peak, 0.02, 0.05);
  });

  it("is deterministic", () => {
    expect(checkPhysics(bob)).toEqual(report);
  });
});

// --- synthetic rigs -----------------------------------------------------------

const ANGLE_X: IkiParameter = {
  id: "ParamAngleX",
  min: -30,
  max: 30,
  default: 0,
};
const ANGLE_Y: IkiParameter = { ...ANGLE_X, id: "ParamAngleY" };
const ANGLE_Z: IkiParameter = { ...ANGLE_X, id: "ParamAngleZ" };
/** A parameter the procedural idle never moves. */
const LEVER: IkiParameter = { ...ANGLE_X, id: "ParamLever" };
const SWAY_X: IkiParameter = {
  id: "ParamHairSwayX",
  min: -20,
  max: 20,
  default: 0,
};
const SWAY_Z: IkiParameter = { ...SWAY_X, id: "ParamHairSwayZ" };

/** The auto-rig's hairSway: a head turn lagged onto the hair. */
function hairSway(more: Partial<IkiPhysics> = {}): IkiPhysics {
  return {
    id: "hairSway",
    input: { parameter: ANGLE_X.id, weight: 1 },
    output: { parameter: SWAY_X.id, scale: 5 },
    mass: 1,
    stiffness: 30,
    damping: 3,
    ...more,
  };
}

/** The auto-rig's hairTilt: a head roll lagged onto the hair. */
const HAIR_TILT: IkiPhysics = {
  id: "hairTilt",
  input: { parameter: ANGLE_Z.id, weight: 1 },
  output: { parameter: SWAY_Z.id, scale: 8 },
  mass: 1,
  stiffness: 25,
  damping: 2.5,
};

/** Validated, so every fixture is a model the format accepts. */
function model(fields: Partial<IkiModel>): IkiModel {
  return parseIkiModel({
    version: 1,
    name: "t",
    canvas: { width: 200, height: 200 },
    parameters: [],
    parts: [],
    ...fields,
  });
}

const QUAD = [-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5];

/** A 100 × 100 two-triangle mesh part at the origin unless `more` moves it. */
function quad(id: string, more: Partial<IkiPart> = {}): IkiPart {
  return {
    id,
    color: [1, 1, 1, 1],
    width: 100,
    height: 100,
    transform: { x: 0, y: 0 },
    order: 0,
    mesh: {
      vertices: QUAD,
      uvs: QUAD.map((v) => v + 0.5),
      indices: [0, 1, 2, 1, 3, 2],
    },
    ...more,
  };
}

/**
 * A part warp on `param` shifting every vertex `dx` part widths right at its
 * max and as far left at its min.
 */
function shift(param: IkiParameter, dx: number): IkiWarp {
  const by = (d: number) => QUAD.map((_, i) => (i % 2 === 0 ? d : 0));
  return {
    parameter: param.id,
    keyforms: [
      { value: param.min, offsets: by(-dx) },
      { value: param.max, offsets: by(dx) },
    ],
  };
}

const HEAD: IkiDeformer = { kind: "matrix", id: "head", pivot: { x: 0, y: 0 } };

/**
 * One rig and one hair part, hung from a matrix deformer, that its output
 * shifts `dx` part widths at either end: 30 model px by default.
 */
function swayModel(
  rig: IkiPhysics = hairSway(),
  {
    input = ANGLE_X,
    output = SWAY_X,
    dx = 0.3,
  }: { input?: IkiParameter; output?: IkiParameter; dx?: number } = {},
): IkiModel {
  return model({
    parameters: [input, output],
    deformers: [HEAD],
    parts: [quad("hair", { deformer: "head", warps: [shift(output, dx)] })],
    physics: [rig],
  });
}

/** The report's one target. */
const only = (m: IkiModel): PhysicsTarget => {
  const { targets } = checkPhysics(m);
  expect(targets).toHaveLength(1);
  return targets[0];
};

describe("checkPhysics — springs that move the parts", () => {
  it("reads the auto-rig's two default springs as ok", () => {
    const report = checkPhysics(
      model({
        parameters: [ANGLE_X, ANGLE_Z, SWAY_X, SWAY_Z],
        deformers: [HEAD],
        parts: [
          quad("hair_back", { deformer: "head", warps: [shift(SWAY_X, 0.3)] }),
          quad("hair_front", { deformer: "head", warps: [shift(SWAY_Z, 0.3)] }),
        ],
        physics: [hairSway(), HAIR_TILT],
      }),
    );
    expect(report.targets.map((t) => [t.rig.id, t.kind, t.why])).toEqual([
      ["hairSway", "ok", undefined],
      ["hairTilt", "ok", undefined],
    ]);
    expect(report.offenders).toEqual([]);
    expect(report.thresholds).toEqual({ displacementPx: 1, pinnedFrames: 60 });
  });

  it("steps the input to its far end and lands the part at every value the output reached", () => {
    const t = only(swayModel());
    expect(t.kind).toBe("ok");
    expect(t.rig).toEqual({ kind: "spring", id: "hairSway" });
    expect(t.input).toEqual(["ParamAngleX"]);
    expect(t.output).toBe("ParamHairSwayX");
    expect(t.drives).toEqual([{ kind: "part", id: "hair" }]);
    expect(t.step.values).toEqual({ ParamAngleX: 30 });
    expectNear(t.step.peak, 7.02, 0.05);
    expectNear(t.step.final, 5.0, 0.05);
    // 30 px at the output's max, so 1.5 px per unit at its 7.02 peak.
    expectNear(t.step.displacementPx, 1.5 * t.step.peak, 1e-3);
    expect(t.idle.peak).toBeGreaterThan(0);
    expectNear(t.idle.displacementPx, 1.5 * t.idle.peak, 0.01);
  });

  it("steps an input resting at its max to its min", () => {
    const t = only(
      swayModel(hairSway({ input: { parameter: LEVER.id, weight: 1 } }), {
        input: { ...LEVER, min: 0, max: 1, default: 1 },
      }),
    );
    expect(t.step.values).toEqual({ ParamLever: 0 });
    expectNear(t.step.peak, -7.02, 0.05);
    expect(t.kind).toBe("ok");
  });

  it("lands a part without a mesh as the unit quad it draws", () => {
    const t = only(
      model({
        parameters: [ANGLE_X, SWAY_X],
        parts: [
          {
            id: "bow",
            color: [1, 1, 1, 1],
            width: 10,
            height: 10,
            transform: { x: 0, y: 0 },
            order: 0,
            bindings: [
              {
                parameter: SWAY_X.id,
                channel: "translateX",
                from: -20,
                to: 20,
              },
            ],
          },
        ],
        physics: [hairSway()],
      }),
    );
    expect(t.kind).toBe("ok");
    // The binding moves the part one model px per unit of output.
    expectNear(t.step.displacementPx, t.step.peak, 1e-3);
  });

  it("lands every value the step emitted, not the output's ends", () => {
    // squash's scaleX is t, the bead's x is 10·(1 − t), t the output's
    // normalised value: the bead sits at 10·t·(1 − t), at rest at both ends
    // of the output and 2.5 px out halfway, with no keyform stop anywhere.
    const bend: IkiParameter = { id: "ParamBend", min: 0, max: 20, default: 0 };
    const t = only(
      model({
        parameters: [LEVER, bend],
        deformers: [
          {
            kind: "matrix",
            id: "squash",
            pivot: { x: 0, y: 0 },
            bindings: [
              { parameter: bend.id, channel: "scaleX", from: -1, to: 0 },
            ],
          },
        ],
        parts: [
          quad("bead", {
            width: 0.01,
            height: 0.01,
            deformer: "squash",
            bindings: [
              { parameter: bend.id, channel: "translateX", from: 10, to: 0 },
            ],
          }),
        ],
        // Settles at 10, halfway, over a 14 overshoot.
        physics: [
          hairSway({
            input: { parameter: LEVER.id, weight: 1 },
            output: { parameter: bend.id, scale: 10 },
          }),
        ],
      }),
    );
    expect(t.kind).toBe("ok");
    expectNear(t.step.displacementPx, 2.5, 0.01);
  });

  it("reads a slow spring still climbing at the window's end as ok", () => {
    // Its step-map radius is 0.9998: under 1, so it converges, only slowly.
    const t = only(swayModel(hairSway({ mass: 100, stiffness: 1 }), { dx: 1 }));
    expect(t.kind).toBe("ok");
    expect(t.step.at).toBeCloseTo(5);
    expect(t.step.final).toBe(t.step.peak);
  });

  it("reads the default rig's overshoot clipped by a ±6 output as ok, no pin", () => {
    const narrow = { ...SWAY_X, min: -6, max: 6 };
    const t = only(swayModel(hairSway(), { output: narrow }));
    expect(t.kind).toBe("ok");
    expect(t.step.peak).toBe(6);
    expectNear(t.step.final, 5.0, 0.05);
  });

  it("is empty for a model with no physics", () => {
    const report = checkPhysics(model({ parameters: [ANGLE_X] }));
    expect(report.targets).toEqual([]);
    expect(report.offenders).toEqual([]);
  });
});

describe("checkPhysics — frozen springs", () => {
  it("reads an output nothing reads as frozen", () => {
    const t = only(
      model({
        parameters: [ANGLE_X, SWAY_X],
        parts: [quad("hair")],
        physics: [hairSway()],
      }),
    );
    expect(t.kind).toBe("frozen");
    expect(t.why).toBe("drives nothing");
    expect(t.drives).toEqual([]);
  });

  it("reads a zero scale as frozen, moving nothing", () => {
    const t = only(
      swayModel(hairSway({ output: { parameter: SWAY_X.id, scale: 0 } })),
    );
    expect(t.kind).toBe("frozen");
    expect(t.why).toBe("moves 0.0 model px over the step");
    expect(t.step.peak).toBe(0);
    expect(t.step.displacementPx).toBe(0);
  });

  it("reads a warp moving under 1 px as frozen, at the default rig's peak", () => {
    // 0.5 px at the output's ends.
    const t = only(swayModel(hairSway(), { dx: 0.005 }));
    expect(t.kind).toBe("frozen");
    expect(t.why).toBe("moves 0.1 model px over the step");
    expectNear(t.step.peak, 7.02, 0.05);
  });

  it("reads an input with no range as frozen, naming it", () => {
    const t = only(
      swayModel(hairSway(), { input: { ...ANGLE_X, min: 0, max: 0 } }),
    );
    expect(t.kind).toBe("frozen");
    expect(t.why).toBe("ParamAngleX has no range");
    expect(t.step.values).toEqual({});
  });

  it("measures from the rendered rest, not the authored mesh", () => {
    // The hair moves, under 1 px; the mouth rests shut, 40 px off its
    // authored mesh: measured from that mesh, every landing would read as
    // 40 px of motion and the rig as ok.
    const mouthOpen: IkiParameter = {
      id: "ParamMouthOpenY",
      min: 0,
      max: 1,
      default: 0,
    };
    const shut = QUAD.map((_, i) => (i % 2 === 0 ? 0.4 : 0));
    const t = only(
      model({
        parameters: [ANGLE_X, SWAY_X, mouthOpen],
        parts: [
          quad("hair", { warps: [shift(SWAY_X, 0.005)] }),
          quad("mouth", {
            warps: [
              {
                parameter: mouthOpen.id,
                keyforms: [
                  { value: 0, offsets: shut },
                  { value: 1, offsets: QUAD.map(() => 0) },
                ],
              },
            ],
          }),
        ],
        physics: [hairSway()],
      }),
    );
    expect(t.kind).toBe("frozen");
    expect(t.why).toBe("moves 0.1 model px over the step");
    expectNear(t.step.peak, 7.02, 0.05);
    expect(t.idle.displacementPx).toBeLessThan(1);
  });
});

describe("checkPhysics — unstable springs", () => {
  it("reads a step map with a radius over 1 as unstable, naming it", () => {
    const t = only(swayModel(hairSway({ mass: 0.001, stiffness: 1e6 })));
    expect(t.kind).toBe("unstable");
    expect(t.why).toBe("spring step map radius 277825.78 over 1 at 1/60 s");
  });

  it("prints as many decimals as it takes to show the radius over 1", () => {
    const t = only(swayModel(hairSway({ stiffness: 14500, damping: 0 })));
    expect(t.why).toBe("spring step map radius 1.18 over 1 at 1/60 s");
  });

  it("reads an undamped spring on its boundary as unstable though its output stays small", () => {
    // dt²k/m = 4: radius exactly 1, but a double eigenvalue −1, so the state
    // grows linearly — at this scale too slowly to leave the range or trip
    // the guard in either window.
    const t = only(
      swayModel(
        hairSway({
          stiffness: 14400,
          damping: 0,
          output: { parameter: SWAY_X.id, scale: 0.001 },
        }),
      ),
    );
    expect(t.kind).toBe("unstable");
    expect(t.why).toBe("spring on its undamped boundary, dt²k/m 4.00");
    expectNear(Math.abs(t.step.peak), 0.6, 0.1);
  });

  it("reads a guard reset as unstable though the sink saw only rest", () => {
    // Every product overflows, so emit hands the sink the resting 0 instead:
    // by its values alone the rig would read frozen.
    const t = only(
      swayModel(
        hairSway({
          input: { parameter: ANGLE_X.id, weight: Number.MAX_VALUE },
        }),
      ),
    );
    expect(t.kind).toBe("unstable");
    expect(t.why).toMatch(/^finiteness guard reset it \d+ times in the step$/);
    expect(t.step.peak).toBe(0);
  });

  it("reads an output held past its max for the step as pinned", () => {
    const t = only(
      swayModel(hairSway({ output: { parameter: SWAY_X.id, scale: 1000 } })),
    );
    expect(t.kind).toBe("unstable");
    expect(t.why).toBe(
      "pinned at ParamHairSwayX max 20 for 299 frames of the step",
    );
  });

  it("reads the idle sway pinning an output against its near end as unstable", () => {
    const t = only(swayModel(hairSway(), { output: { ...SWAY_X, min: -0.1 } }));
    expect(t.kind).toBe("unstable");
    expectNear(t.step.peak, 7.02, 0.05);
    const pin =
      /^pinned at ParamHairSwayX min -0\.1 for (\d+) frames of the idle$/.exec(
        t.why ?? "",
      );
    expect(Number(pin?.[1])).toBeGreaterThanOrEqual(60);
  });

  it("does not read an output swinging between its two bounds as pinned", () => {
    // Saturates one end then the other within two frames, never holding either.
    const t = only(
      swayModel(
        hairSway({
          input: { parameter: LEVER.id, weight: 1 },
          stiffness: 14000,
          damping: 0,
        }),
        { input: LEVER, output: { ...SWAY_X, min: -0.01, max: 0.01 } },
      ),
    );
    expect(t.why ?? "").not.toMatch(/pinned/);
    expect(t.step.peak).not.toBe(0);
  });

  it("does not read a bounded transient flipping bounds every frame as pinned", () => {
    // Just under the undamped boundary: the swing grows for a while yet
    // stays bounded, past one bound for a single frame at a time.
    const t = only(
      swayModel(
        hairSway({
          input: { parameter: LEVER.id, weight: 1 },
          stiffness: 14399.64,
          damping: 0,
        }),
        {
          input: LEVER,
          output: { ...SWAY_X, min: -5.01, max: 5.01, default: -5 },
        },
      ),
    );
    expect(t.why ?? "").not.toMatch(/pinned/);
  });

  it("measures the idle's move at its interior values, not only its extremes", () => {
    // The warp peaks at ±0.3 and is back at rest by ±0.5; the idle's sway
    // (peak about 0.6) ends past that, so its extremes land exactly at rest
    // while the sway passes through the peak.
    const by = (d: number) => QUAD.map((_, i) => (i % 2 === 0 ? d : 0));
    const stops: [number, number][] = [
      [-20, 0],
      [-0.5, 0],
      [-0.3, -0.3],
      [0, 0],
      [0.3, 0.3],
      [0.5, 0],
      [20, 0],
    ];
    const warp: IkiWarp = {
      parameter: SWAY_X.id,
      keyforms: stops.map(([value, dx]) => ({ value, offsets: by(dx) })),
    };
    const t = only(
      model({
        parameters: [ANGLE_X, SWAY_X],
        parts: [quad("hair", { warps: [warp] })],
        physics: [hairSway()],
      }),
    );
    expect(t.idle.displacementPx).toBeGreaterThan(5);
  });

  it("lists the offenders unstable first, a runaway that drives nothing among them", () => {
    const still: IkiParameter = { ...SWAY_X, id: "ParamStill" };
    const wild: IkiParameter = { ...SWAY_X, id: "ParamWild" };
    const report = checkPhysics(
      model({
        parameters: [ANGLE_X, SWAY_X, still, wild],
        parts: [quad("hair", { warps: [shift(SWAY_X, 0.3)] })],
        physics: [
          hairSway(),
          hairSway({ id: "still", output: { parameter: still.id, scale: 0 } }),
          hairSway({ id: "wild", output: { parameter: wild.id, scale: 1000 } }),
        ],
      }),
    );
    expect(report.targets.map((t) => [t.rig.id, t.kind])).toEqual([
      ["hairSway", "ok"],
      ["still", "frozen"],
      ["wild", "unstable"],
    ]);
    expect(report.offenders.map((t) => t.rig.id)).toEqual(["wild", "still"]);
    const wildTarget = report.offenders[0];
    expect(wildTarget.drives).toEqual([]);
    expect(wildTarget.why).toBe(
      "pinned at ParamWild max 20 for 299 frames of the step",
    );
  });
});

describe("checkPhysics — springs with several inputs", () => {
  /** hairSway lagging the head turn and following the lever. */
  const mixed = (): IkiPhysics => {
    const { input: _single, ...base } = hairSway();
    return {
      ...base,
      inputs: [
        { parameter: ANGLE_X.id, weight: 1, mode: "lag" },
        { parameter: LEVER.id, weight: 0.25, mode: "follow" },
      ],
    };
  };
  const mixedModel = ({
    inputs = [ANGLE_X, LEVER],
    output = SWAY_X,
  }: { inputs?: IkiParameter[]; output?: IkiParameter } = {}): IkiModel =>
    model({
      parameters: [...inputs, output],
      deformers: [HEAD],
      parts: [quad("hair", { deformer: "head", warps: [shift(output, 0.3)] })],
      physics: [mixed()],
    });

  it("steps each input alone and reports the lag run, which moves the parts most", () => {
    const t = only(mixedModel());
    expect(t.kind).toBe("ok");
    expect(t.input).toEqual(["ParamAngleX", "ParamLever"]);
    expect(t.step.values).toEqual({ ParamAngleX: 30 });
    // −scale·weight, less one sub-step, then back to rest.
    expectNear(t.step.peak, -5, 0.3);
    expect(Math.abs(t.step.final)).toBeLessThan(0.05);
    expectNear(t.step.displacementPx, 1.5 * Math.abs(t.step.peak), 1e-3);
  });

  it("reads a pin in the follow input's run as unstable, naming that run", () => {
    // The lever's held share settles at 1.25, past a max of 1; the lag run
    // only overshoots it briefly on its way back to rest.
    const t = only(mixedModel({ output: { ...SWAY_X, max: 1 } }));
    expect(t.kind).toBe("unstable");
    expect(t.why).toMatch(
      /^pinned at ParamHairSwayX max 1 for \d+ frames of the step ParamLever=30$/,
    );
    // The step reported is the run that is not unstable.
    expect(t.step.values).toEqual({ ParamAngleX: 30 });
  });

  it("reads a spring none of whose inputs has a range as frozen, naming them", () => {
    const flat = { min: 0, max: 0 };
    const t = only(
      mixedModel({
        inputs: [
          { ...ANGLE_X, ...flat },
          { ...LEVER, ...flat },
        ],
      }),
    );
    expect(t.kind).toBe("frozen");
    expect(t.why).toBe("ParamAngleX, ParamLever have no range");
    expect(t.input).toEqual(["ParamAngleX", "ParamLever"]);
    expect(t.step.values).toEqual({});
  });
});

// --- chains -------------------------------------------------------------------

const LOCK_0: IkiParameter = {
  id: "ParamLock0",
  min: -60,
  max: 60,
  default: 0,
};
const LOCK_1: IkiParameter = { ...LOCK_0, id: "ParamLock1" };

/** Turned by ParamAngleX, a degree per unit, as hair-chain-motion.test.ts's. */
const HEAD_DEFORMER: IkiDeformer = {
  kind: "matrix",
  id: "headDeformer",
  pivot: { x: 0, y: 0 },
  bindings: [{ parameter: ANGLE_X.id, channel: "rotate", from: -30, to: 30 }],
};

// hair-chain-motion.test.ts's warp grid, its rows top first as the validator
// requires: its keyforms rotate every control point about the origin
// (CCW-positive, y-up).
const WARP_POINTS = [1, 0, -1].flatMap((y) =>
  [-1, 0, 1].flatMap((x) => [x, y]),
);
function rotatedOffsets(degrees: number): number[] {
  const r = (degrees * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return WARP_POINTS.map((v, i) => {
    const x = WARP_POINTS[i - (i % 2)];
    const y = WARP_POINTS[i - (i % 2) + 1];
    return (i % 2 === 0 ? c * x - s * y : s * x + c * y) - v;
  });
}

/**
 * hair-chain-motion.test.ts's lockL, its root hung straight down so rest is
 * its equilibrium. `segments` override its segments' fields, in order, and
 * a shorter array keeps only that many segments.
 */
function lockL(
  segments: Partial<IkiPhysicsChainSegment>[] = [{}, {}],
  more: Partial<IkiPhysicsChain> = {},
): IkiPhysicsChain {
  const defaults: IkiPhysicsChainSegment[] = [
    {
      output: { parameter: LOCK_0.id, scale: 1 },
      restAngle: -90,
      mass: 1,
      stiffness: 8,
      damping: 5,
    },
    {
      output: { parameter: LOCK_1.id, scale: 1 },
      mass: 1,
      stiffness: 5,
      damping: 4,
    },
  ];
  return {
    id: "lockL",
    anchorDeformer: HEAD_DEFORMER.id,
    gravity: { angle: -90, strength: 50 },
    segments: segments.map((s, i) => ({ ...defaults[i], ...s })),
    ...more,
  };
}

/**
 * A chain's model: each segment's deformer hung from the one above it (the
 * first from the anchor), turned by its output a degree per unit, with a
 * 10 × 40 strand under it.
 */
function chainModel(
  chain: IkiPhysicsChain,
  {
    outputs = [LOCK_0, LOCK_1],
    inputs = [ANGLE_X],
    anchors = [HEAD_DEFORMER],
  }: {
    outputs?: IkiParameter[];
    inputs?: IkiParameter[];
    anchors?: IkiDeformer[];
  } = {},
): IkiModel {
  const used = outputs.slice(0, chain.segments.length);
  return model({
    parameters: [...inputs, ...used],
    deformers: [
      ...anchors,
      ...used.map(
        (out, i): IkiDeformer => ({
          kind: "matrix",
          id: `seg${i}`,
          parent: i === 0 ? chain.anchorDeformer : `seg${i - 1}`,
          pivot: { x: 0, y: -40 * i },
          bindings: [
            {
              parameter: out.id,
              channel: "rotate",
              from: out.min,
              to: out.max,
            },
          ],
        }),
      ),
    ],
    parts: used.map((_, i) =>
      quad(`strand${i}`, {
        width: 10,
        height: 40,
        transform: { x: 0, y: -20 - 40 * i },
        deformer: `seg${i}`,
      }),
    ),
    physicsChains: [chain],
  });
}

describe("checkPhysics — chains", () => {
  it("steps the parameter that turns the anchor and reads both segments ok", () => {
    const report = checkPhysics(chainModel(lockL()));
    expect(report.targets.map((t) => [t.rig, t.output, t.kind])).toEqual([
      [{ kind: "chain", id: "lockL", segment: 0 }, "ParamLock0", "ok"],
      [{ kind: "chain", id: "lockL", segment: 1 }, "ParamLock1", "ok"],
    ]);
    report.targets.forEach((t, i) => {
      expect(t.input).toEqual(["ParamAngleX"]);
      expect(t.step.values).toEqual({ ParamAngleX: 30 });
      expect(t.drives).toEqual([{ kind: "deformer", id: `seg${i}` }]);
      expect(t.step.displacementPx).toBeGreaterThan(1);
    });
  });

  it("steps two inputs that turn the anchor opposite ways each alone", () => {
    const opposed: IkiDeformer = {
      ...HEAD_DEFORMER,
      bindings: [
        ...HEAD_DEFORMER.bindings!,
        { parameter: ANGLE_Y.id, channel: "rotate", from: 30, to: -30 },
      ],
    };
    const report = checkPhysics(
      chainModel(lockL(), { inputs: [ANGLE_X, ANGLE_Y], anchors: [opposed] }),
    );
    for (const t of report.targets) {
      expect(t.kind).toBe("ok");
      expect(t.input).toEqual(["ParamAngleX", "ParamAngleY"]);
      expect([{ ParamAngleX: 30 }, { ParamAngleY: 30 }]).toContainEqual(
        t.step.values,
      );
    }
  });

  it("reads a pin in one input's run as unstable, naming that run", () => {
    const opposed: IkiDeformer = {
      ...HEAD_DEFORMER,
      bindings: [
        ...HEAD_DEFORMER.bindings!,
        { parameter: ANGLE_Y.id, channel: "rotate", from: 30, to: -30 },
      ],
    };
    // ParamAngleX's turn swings the root segment negative, ParamAngleY's
    // positive, where its range has room.
    const t = checkPhysics(
      chainModel(lockL(), {
        outputs: [{ ...LOCK_0, min: -0.1 }, LOCK_1],
        inputs: [ANGLE_X, ANGLE_Y],
        anchors: [opposed],
      }),
    ).targets[0];
    expect(t.kind).toBe("unstable");
    expect(t.why).toMatch(
      /^pinned at ParamLock0 min -0\.1 for \d+ frames of the step ParamAngleX=30$/,
    );
    // The step reported is the run that is not unstable.
    expect(t.step.values).toEqual({ ParamAngleY: 30 });
    expect(t.step.peak).toBeGreaterThan(0);
  });

  it("finds an input that turns the anchor at one end only, through a warp parent", () => {
    // bodyWarp rotates its grid −30° at ParamAngleX −30 and stays flat at 0
    // and +30, so only the min end turns the anchor riding it.
    const flat = WARP_POINTS.map(() => 0);
    const bodyWarp: IkiDeformer = {
      kind: "warp",
      id: "bodyWarp",
      grid: { cols: 2, rows: 2, points: WARP_POINTS },
      warps: [
        {
          parameter: ANGLE_X.id,
          keyforms: [
            { value: -30, offsets: rotatedOffsets(-30) },
            { value: 0, offsets: flat },
            { value: 30, offsets: flat },
          ],
        },
      ],
    };
    const anchor: IkiDeformer = {
      kind: "matrix",
      id: "anchorUnderWarp",
      parent: "bodyWarp",
      pivot: { x: 0, y: 0 },
    };
    const report = checkPhysics(
      chainModel(lockL([{}, {}], { anchorDeformer: anchor.id }), {
        anchors: [bodyWarp, anchor],
      }),
    );
    for (const t of report.targets) {
      expect(t.input).toEqual(["ParamAngleX"]);
      expect(t.step.values).toEqual({ ParamAngleX: -30 });
      expect(t.kind).toBe("ok");
    }
  });

  it("reads a chain whose anchor nothing turns as frozen, naming the anchor", () => {
    const still: IkiDeformer = {
      kind: "matrix",
      id: "still",
      pivot: { x: 0, y: 0 },
    };
    const report = checkPhysics(
      chainModel(lockL([{}, {}], { anchorDeformer: still.id }), {
        anchors: [still],
      }),
    );
    for (const t of report.targets) {
      expect(t.kind).toBe("frozen");
      expect(t.input).toEqual([]);
      expect(t.step.values).toEqual({});
      expect(t.why).toBe("nothing turns anchor still");
    }
  });

  it("reads a segment the guard resets as unstable", () => {
    const t = checkPhysics(
      chainModel(lockL([{ mass: 1e-6, stiffness: 1e6 }, {}])),
    ).targets[0];
    expect(t.kind).toBe("unstable");
    expect(t.why).toMatch(
      /^finiteness guard reset it \d+ times? in the step ParamAngleX=30$/,
    );
  });

  // Deferred, so deliberately untested: an undamped segment (stiffness just
  // over dt²k/m = 4) flips sign every frame with growing magnitude, which
  // trips neither the guard nor a pin on one bound.

  it("reads a bounded transient whose tip outgrows its first half as ok", () => {
    const report = checkPhysics(
      chainModel(
        lockL(
          // No root rest angle and gravity at 0°: the hung configuration
          // turned 90°, so rest is still its equilibrium.
          [
            {
              output: { parameter: LOCK_0.id, scale: 0.1 },
              restAngle: undefined,
              stiffness: 9,
              damping: 0.25,
            },
            {
              output: { parameter: LOCK_1.id, scale: 0.1 },
              stiffness: 13,
              damping: 0.25,
            },
          ],
          { gravity: { angle: 0, strength: 14 } },
        ),
        {
          outputs: [
            { ...LOCK_0, min: -20, max: 20 },
            { ...LOCK_1, min: -20, max: 20 },
          ],
        },
      ),
    );
    expect(report.targets.map((t) => t.kind)).toEqual(["ok", "ok"]);
    // The tip swings 4.04 at most in the window's first half, then 6.29.
    const tip = report.targets[1].step;
    expectNear(Math.abs(tip.peak), 6.29, 0.05);
    expect(tip.at).toBeGreaterThan(2.5);
  });

  it("reads a chain that falls off an unstable rest and settles as ok", () => {
    // Gravity at 180°, pulling harder than the stiffness of 9 restores,
    // expands it about rest at first; it peaks and settles inside ±20.
    const t = only(
      chainModel(
        lockL(
          [
            {
              output: { parameter: LOCK_0.id, scale: 0.1 },
              restAngle: undefined,
              stiffness: 9,
              damping: 0.25,
            },
          ],
          { gravity: { angle: 180, strength: 14 } },
        ),
        { outputs: [{ ...LOCK_0, min: -20, max: 20 }] },
      ),
    );
    expect(t.kind).toBe("ok");
    expectNear(t.step.peak, 13.2, 0.1);
    expectNear(t.step.final, 8.2, 0.3);
  });
});
