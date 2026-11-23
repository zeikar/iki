import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  IkiDeformer,
  IkiModel,
  IkiMotionClip,
  IkiPhysics,
  IkiPhysicsChain,
} from "@ikijs/format";
import { IDLE_MOTION_GROUP, StandardParameter } from "@ikijs/format";
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
  // Breath defaults to 1 here ON PURPOSE (the standard model uses 0.5): the
  // order test below needs idle's resting write (0) to differ from the
  // default, or physics-first and idle-first both emit 0 and cannot be told
  // apart.
  { id: StandardParameter.Breath, min: 0, max: 1, default: 1 },
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
    expect(writes.slice(0, 11)).toEqual(expectedOrder);
    expect(writes.slice(11, 22)).toEqual(expectedOrder);

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

    // Idle writes Breath = 0 first, so the spring seeds at target
    // signedNormalized(0) = (0 − 1) / 1 = −1 and emits 0 + −1 × 10. Physics-first
    // would read the default 1, seed at 0 and emit 0 — this fails for the right
    // reason if order flips.
    motion.update(1000);

    expect(live.get(RIG_OUT)).toBeCloseTo(-10);
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

  describe("gaze target", () => {
    // Degrees the head turns and nods per unit of gaze — NOT imported from impl.
    const HEAD_FOLLOW_DEG = 10;
    const FRAME_MS = 16;

    // IkiMotion's idle draws from Math.random. A constant one gives two
    // instances the same draws, so a difference between them is the target.
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** Run `m` for 10 s, setting `target` (if any) before the first update. */
    function run(
      m: IkiModel,
      target?: [number, number],
    ): Map<string, number[]> {
      const { sink, emissions } = makeSink();
      const motion = new IkiMotion(m, () => 0, sink);
      if (target) motion.setGazeTarget(...target);
      for (let t = 0; t <= 10000; t += FRAME_MS) motion.update(t);
      return emissions;
    }

    it("reaches the sink as the eyes and the head", () => {
      vi.spyOn(Math, "random").mockReturnValue(0.37);
      const a = run(model(), [1, 0.5]);
      const b = run(model(), [-1, -0.5]);
      const last = (m: Map<string, number[]>, id: string) => m.get(id)!.at(-1)!;
      expect(last(a, StandardParameter.EyeballX)).toBeCloseTo(1, 5);
      expect(last(a, StandardParameter.EyeballY)).toBeCloseTo(0.5, 5);
      expect(
        last(a, StandardParameter.AngleX) - last(b, StandardParameter.AngleX),
      ).toBeCloseTo(2 * HEAD_FOLLOW_DEG, 3);
      expect(
        last(a, StandardParameter.AngleY) - last(b, StandardParameter.AngleY),
      ).toBeCloseTo(HEAD_FOLLOW_DEG, 3);
    });

    describe("under a declared Idle group", () => {
      /** Idle holds AngleX at 5; `eyes`, when given, holds EyeballX there too. */
      function idleModel(
        eyes?: number,
        parameters: IkiModel["parameters"] = PARAMS,
      ): IkiModel {
        return model({
          parameters,
          motions: {
            [IDLE_MOTION_GROUP]: [
              {
                description: "hold the turn",
                duration: 1,
                fadeIn: 0,
                fadeOut: 0,
                curves: [
                  { parameter: StandardParameter.AngleX, keys: [[0, 5]] },
                  ...(eyes === undefined
                    ? []
                    : [
                        {
                          parameter: StandardParameter.EyeballX,
                          keys: [[0, eyes]] as [number, number][],
                        },
                      ]),
                ],
              },
            ],
            Look: [
              {
                description: "look aside",
                duration: 20,
                fadeIn: 0,
                fadeOut: 0,
                curves: [
                  { parameter: StandardParameter.EyeballX, keys: [[0, -0.3]] },
                ],
              },
            ],
          },
        });
      }

      /**
       * An IkiMotion over a store, as a host wires it. `run(ms)` steps that
       * long in frames and returns each id's writes during it.
       */
      function hosted(m: IkiModel) {
        const store = new Map(m.parameters.map((p) => [p.id, p.default]));
        let emissions = new Map<string, number[]>();
        const motion = new IkiMotion(
          m,
          (id) => store.get(id) ?? 0,
          (id, value) => {
            store.set(id, value);
            if (!emissions.has(id)) emissions.set(id, []);
            emissions.get(id)!.push(value);
          },
        );
        let now = 0;
        const run = (ms: number): Map<string, number[]> => {
          emissions = new Map();
          for (const end = now + ms; now < end; now += FRAME_MS) {
            motion.update(now);
          }
          return emissions;
        };
        return { motion, store, run };
      }

      it("moves the eyes to the target and leaves the head the Idle clip's", () => {
        vi.spyOn(Math, "random").mockReturnValue(0.37);
        const targeted = hosted(idleModel());
        targeted.motion.setGazeTarget(1, 0.5);
        const a = targeted.run(10000);
        const b = hosted(idleModel()).run(10000);

        expect(targeted.store.get(StandardParameter.EyeballX)).toBeCloseTo(
          1,
          5,
        );
        expect(targeted.store.get(StandardParameter.EyeballY)).toBeCloseTo(
          0.5,
          5,
        );
        // The eyes start where they rest and travel, no jump to the target.
        expect(a.get(StandardParameter.EyeballX)![0]).toBe(0);
        expect(a.get(StandardParameter.EyeballX)![1]).toBeLessThan(0.5);
        // No head follow: the head is the Idle clip's either way.
        expect(a.get(StandardParameter.AngleX)).toEqual(
          b.get(StandardParameter.AngleX),
        );
        expect(a.has(StandardParameter.AngleY)).toBe(false);
        // Without a target nothing writes the eyes, as before.
        expect(b.has(StandardParameter.EyeballX)).toBe(false);
        expect(b.has(StandardParameter.EyeballY)).toBe(false);
        // Every write is a published one.
        for (const id of a.keys()) {
          expect(targeted.motion.drivenParameterIds).toContain(id);
        }
      });

      it("clearGazeTarget hands the eyes back to their declared defaults, then stops writing them", () => {
        const offRest = PARAMS.map((p) =>
          p.id === StandardParameter.EyeballX ? { ...p, default: 0.2 } : p,
        );
        const { motion, store, run } = hosted(idleModel(undefined, offRest));
        motion.setGazeTarget(-1, 1);
        run(2000);
        expect(store.get(StandardParameter.EyeballX)).toBeCloseTo(-1, 3);

        motion.clearGazeTarget();
        const back = run(3000);
        const xs = back.get(StandardParameter.EyeballX)!;
        // Sprung back, not snapped: the first frame is still near the target.
        expect(xs[0]).toBeLessThan(-0.5);
        // Exactly at rest, not a hair off it, and then left alone.
        expect(xs.at(-1)).toBe(0.2);
        expect(back.get(StandardParameter.EyeballY)!.at(-1)).toBe(0);
        expect(store.get(StandardParameter.EyeballX)).toBe(0.2);
        expect(store.get(StandardParameter.EyeballY)).toBe(0);
        expect(run(1000).has(StandardParameter.EyeballX)).toBe(false);

        // A new target after the hand-back works as the first did.
        motion.setGazeTarget(0.5, 0);
        run(2000);
        expect(store.get(StandardParameter.EyeballX)).toBeCloseTo(0.5, 3);
      });

      it("a target wins over an Idle eye curve while set; the curve plays untouched without one", () => {
        const { motion, store, run } = hosted(idleModel(0.4));
        run(1000);
        expect(store.get(StandardParameter.EyeballX)).toBe(0.4);

        motion.setGazeTarget(-0.6, 0);
        run(2000);
        expect(store.get(StandardParameter.EyeballX)).toBeCloseTo(-0.6, 3);

        motion.clearGazeTarget();
        run(3000);
        expect(store.get(StandardParameter.EyeballX)).toBe(0.4);
      });

      it("a one-shot on the eyes composes over the target", () => {
        const { motion, store, run } = hosted(idleModel());
        motion.setGazeTarget(1, 0);
        run(2000);
        motion.playMotion("Look", 0);
        run(500);
        expect(store.get(StandardParameter.EyeballX)).toBeCloseTo(-0.3, 9);
      });

      it("ignores a non-finite pair, as without an Idle group", () => {
        const { motion, store, run } = hosted(idleModel());
        motion.setGazeTarget(1, 0.5);
        motion.setGazeTarget(Number.NaN, 0);
        run(2000);
        expect(store.get(StandardParameter.EyeballX)).toBeCloseTo(1, 3);
      });

      /** The largest change between two consecutive writes. */
      const largestStep = (xs: number[]): number =>
        Math.max(...xs.slice(1).map((x, i) => Math.abs(x - xs[i])));

      it("a held target stays put over an Idle eye curve that jumps at each clip seam", () => {
        const look = (x: number): IkiMotionClip => ({
          description: "hold the eyes",
          duration: 1,
          fadeIn: 0,
          fadeOut: 0,
          curves: [{ parameter: StandardParameter.EyeballX, keys: [[0, x]] }],
        });
        const { motion, run } = hosted(
          model({
            motions: {
              [IDLE_MOTION_GROUP]: [look(0.5), look(-0.5)],
            },
          }),
        );
        motion.setGazeTarget(0, 0);
        run(1000);
        // Four seams, each a 1.0 jump in the curve under the eyes.
        const held = run(4000).get(StandardParameter.EyeballX)!;
        expect(Math.max(...held.map(Math.abs))).toBeLessThan(1e-3);
      });

      it("clearing mid-spring turns the eyes back from where they are", () => {
        const { motion, store, run } = hosted(idleModel());
        motion.setGazeTarget(1, 0);
        const out = run(64).get(StandardParameter.EyeballX)!;
        expect(out.at(-1)!).toBeGreaterThan(0.1);
        expect(out.at(-1)!).toBeLessThan(0.9);

        motion.clearGazeTarget();
        const back = run(3000).get(StandardParameter.EyeballX)!;
        expect(largestStep([...out, ...back])).toBeLessThan(0.15);
        expect(back.at(-1)).toBe(0);
        expect(store.get(StandardParameter.EyeballX)).toBe(0);
      });

      it("a target set again during the release springs on from where the eyes are", () => {
        const { motion, store, run } = hosted(idleModel(0.4));
        motion.setGazeTarget(1, 0);
        const out = run(2000).get(StandardParameter.EyeballX)!;
        motion.clearGazeTarget();
        const releasing = run(64).get(StandardParameter.EyeballX)!;
        expect(releasing.at(-1)!).toBeGreaterThan(0.45);
        expect(releasing.at(-1)!).toBeLessThan(0.95);

        motion.setGazeTarget(-1, 0);
        const again = run(2000).get(StandardParameter.EyeballX)!;
        expect(largestStep([...out, ...releasing, ...again])).toBeLessThan(
          0.25,
        );
        expect(store.get(StandardParameter.EyeballX)).toBeCloseTo(-1, 3);
      });

      it("a target set and cleared before any update writes nothing", () => {
        vi.spyOn(Math, "random").mockReturnValue(0.37);
        const touched = hosted(idleModel());
        touched.motion.setGazeTarget(1, 0.5);
        touched.motion.clearGazeTarget();
        const a = touched.run(2000);
        expect(a.has(StandardParameter.EyeballX)).toBe(false);
        expect(a.has(StandardParameter.EyeballY)).toBe(false);
        expect(a).toEqual(hosted(idleModel()).run(2000));
      });
    });
  });
});
