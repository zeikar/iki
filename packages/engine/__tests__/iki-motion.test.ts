import { describe, expect, it } from "vitest";
import type {
  IkiDeformer,
  IkiModel,
  IkiPhysics,
  IkiPhysicsChain,
} from "@ikijs/format";
import { StandardParameter } from "@ikijs/format";
import { IdleMotion, IkiMotion } from "@ikijs/engine";

// --- Test harness (makeSink copied from physics-motion.test.ts) --------------

/** Build a capturing sink → Map<id, emitted values in order>. */
function makeSink(): {
  sink: (id: string, value: number) => void;
  emissions: Map<string, number[]>;
} {
  const emissions = new Map<string, number[]>();
  const sink = (id: string, value: number) => {
    if (!emissions.has(id)) emissions.set(id, []);
    emissions.get(id)!.push(value);
  };
  return { sink, emissions };
}

/** Build a capturing sink → the ids written, in write order (values discarded). */
function makeRecorder(): {
  sink: (id: string, value: number) => void;
  writes: string[];
} {
  const writes: string[] = [];
  const sink = (id: string) => {
    writes.push(id);
  };
  return { sink, writes };
}

// --- Fixture ------------------------------------------------------------------

const RIG_OUT = "ParamHairSwayX";
const SEG0_OUT = "ParamLockSeg0";
const SEG1_OUT = "ParamLockSeg1";

const PARAMS = [
  { id: StandardParameter.EyeOpenLeft, min: 0, max: 1, default: 1 },
  { id: StandardParameter.EyeOpenRight, min: 0, max: 1, default: 1 },
  // Breath defaults to 0 here ON PURPOSE (the standard model uses 0.5): the
  // order test below needs idle's resting write (0.5) to differ from the
  // default, or physics-first and idle-first both emit 0 and cannot be told
  // apart.
  { id: StandardParameter.Breath, min: 0, max: 1, default: 0 },
  { id: StandardParameter.EyeballX, min: -1, max: 1, default: 0 },
  { id: StandardParameter.EyeballY, min: -1, max: 1, default: 0 },
  { id: StandardParameter.AngleX, min: -30, max: 30, default: 0 },
  { id: StandardParameter.AngleY, min: -30, max: 30, default: 0 },
  { id: StandardParameter.AngleZ, min: -30, max: 30, default: 0 },
  { id: RIG_OUT, min: -20, max: 20, default: 0 },
  { id: SEG0_OUT, min: -60, max: 60, default: 0 },
  { id: SEG1_OUT, min: -60, max: 60, default: 0 },
];

// headDeformer: a matrix deformer with an AngleX→rotate binding (copied from
// hair-chain-motion.test.ts). At AngleX = 0 (default), anchor world angle ≈ 0.
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

function model(overrides: Partial<IkiModel> = {}): IkiModel {
  return {
    version: 1,
    name: "t",
    canvas: { width: 100, height: 100 },
    parameters: PARAMS,
    parts: [],
    ...overrides,
  };
}

function rig(input: string, output: string, scale = 10): IkiPhysics {
  return {
    id: `${input}->${output}`,
    input: { parameter: input, weight: 1 },
    output: { parameter: output, scale },
    mass: 1,
    stiffness: 80,
    damping: 10,
  };
}

function chain(outputs: string[]): IkiPhysicsChain {
  return {
    id: "chain",
    anchorDeformer: "headDeformer",
    gravity: { angle: -90, strength: 50 },
    segments: outputs.map((output) => ({
      output: { parameter: output, scale: 1 },
      mass: 1,
      stiffness: 8,
      damping: 5,
    })),
  };
}

// --- Tests ---------------------------------------------------------------

describe("IkiMotion", () => {
  it("first update emits the resting pose exactly like IdleMotion alone", () => {
    const { sink: sinkA, emissions: emissionsA } = makeSink();
    new IdleMotion(sinkA).update(1000);

    const { sink: sinkB, emissions: emissionsB } = makeSink();
    new IkiMotion(model(), () => 0, sinkB).update(1000);

    expect(emissionsB).toEqual(emissionsA);
  });

  it("with physics + chains, the new outputs also rest at their defaults", () => {
    const { sink: sinkA, emissions: emissionsA } = makeSink();
    new IdleMotion(sinkA).update(1000);

    const { sink: sinkB, emissions: emissionsB } = makeSink();
    new IkiMotion(
      model({
        deformers: [HEAD_DEFORMER],
        physics: [rig(StandardParameter.AngleX, RIG_OUT)],
        physicsChains: [chain([SEG0_OUT])],
      }),
      () => 0,
      sinkB,
    ).update(1000);

    expect(emissionsB).toEqual(
      new Map([...emissionsA, [RIG_OUT, [0]], [SEG0_OUT, [0]]]),
    );
  });

  it("writes idle, then physics outputs, then chain outputs, every update", () => {
    const riggedModel = model({
      deformers: [HEAD_DEFORMER],
      physics: [rig(StandardParameter.AngleX, RIG_OUT)],
      physicsChains: [chain([SEG0_OUT])],
    });
    const { sink, writes } = makeRecorder();
    const motion = new IkiMotion(riggedModel, () => 0, sink);

    motion.update(1000);
    motion.update(1016);

    const expectedOrder = [
      ...new IdleMotion(() => {}).drivenParameterIds,
      RIG_OUT,
      SEG0_OUT,
    ];
    expect(writes.slice(0, 10)).toEqual(expectedOrder);
    expect(writes.slice(10, 20)).toEqual(expectedOrder);

    motion.update(1032);
    // The published list is exactly what was written, not a literal.
    expect(new Set(writes)).toEqual(new Set(motion.drivenParameterIds));
  });

  it("physics reads the pose idle wrote in the same frame", () => {
    const live = new Map(PARAMS.map((p) => [p.id, p.default]));
    const testModel = model({
      physics: [rig(StandardParameter.Breath, RIG_OUT, 10)],
    });
    const motion = new IkiMotion(
      testModel,
      (id) => live.get(id) ?? 0,
      (id, value) => live.set(id, value),
    );

    // Idle writes Breath = 0.5 first, so the spring seeds at target
    // signedNormalized(0.5) = 0.5 and emits 0 + 0.5 × 10. Physics-first would
    // seed at 0 and emit 0 — this fails for the right reason if order flips.
    motion.update(1000);

    expect(live.get(RIG_OUT)).toBeCloseTo(5);
  });

  it("drivenParameterIds = idle ∪ rig outputs ∪ chain outputs, deduplicated, insertion-ordered", () => {
    const idleIds = new IdleMotion(() => {}).drivenParameterIds;

    const withRigsAndChains = new IkiMotion(
      model({
        physics: [
          rig(StandardParameter.AngleX, RIG_OUT),
          rig(StandardParameter.AngleX, StandardParameter.AngleZ),
        ],
        deformers: [HEAD_DEFORMER],
        physicsChains: [chain([SEG0_OUT, SEG1_OUT])],
      }),
      () => 0,
      () => {},
    );
    expect(withRigsAndChains.drivenParameterIds).toEqual([
      ...idleIds,
      RIG_OUT,
      SEG0_OUT,
      SEG1_OUT,
    ]);

    const plain = new IkiMotion(
      model(),
      () => 0,
      () => {},
    );
    expect(plain.drivenParameterIds).toEqual([...idleIds]);
  });

  it("a model with no physics, chains, or deformers works", () => {
    const { sink, emissions } = makeSink();
    const motion = new IkiMotion(model(), () => 0, sink);
    motion.update(1000);
    motion.update(1016);
    motion.update(1032);

    const idleIds = new IdleMotion(() => {}).drivenParameterIds;
    expect(new Set(emissions.keys())).toEqual(new Set(idleIds));
    for (const series of emissions.values()) {
      expect(series).toHaveLength(3);
    }
  });
});
