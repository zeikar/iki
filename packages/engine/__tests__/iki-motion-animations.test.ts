import { describe, expect, it, vi } from "vitest";
import type {
  IkiDeformer,
  IkiExpression,
  IkiModel,
  IkiMotionClip,
  IkiPhysics,
  IkiPhysicsChain,
} from "@ikijs/format";
import { IDLE_MOTION_GROUP, StandardParameter } from "@ikijs/format";
import { IdleMotion, IkiMotion, ParameterStore } from "@ikijs/engine";
import { MAX_DT_MS } from "../src/frame-clock";

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
  { id: StandardParameter.MouthOpen, min: 0, max: 1, default: 0 },
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

/** A one-curve clip rising linearly from `from` at 0 s to `to` at `duration`. */
function ramp(
  parameter: string,
  from: number,
  to: number,
  duration: number,
): IkiMotionClip {
  return {
    description: "test ramp",
    duration,
    curves: [
      {
        parameter,
        keys: [
          [0, from],
          [duration, to],
        ],
      },
    ],
  };
}

function expression(
  id: string,
  parameters: IkiExpression["parameters"],
  fades: Pick<IkiExpression, "fadeIn" | "fadeOut"> = {},
): IkiExpression {
  return { id, description: "test expression", ...fades, parameters };
}

const SMILE: IkiExpression = expression("smile", [
  { parameter: StandardParameter.EyeOpenLeft, value: 0.5, blend: "multiply" },
  { parameter: StandardParameter.BrowLeftY, value: 0.3 },
]);

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

/** An Idle group on AngleX, a one-shot "Nod" on AngleY, SMILE, a rig, a chain. */
function animatedModel(): IkiModel {
  return model({
    deformers: [HEAD_DEFORMER],
    physics: [RIG],
    physicsChains: [CHAIN],
    expressions: [SMILE],
    motions: {
      [IDLE_MOTION_GROUP]: [clip(StandardParameter.AngleX, 10)],
      Nod: [clip(StandardParameter.AngleY, 5)],
    },
  });
}

/**
 * Ramps on all three layers, so a value says how far each has advanced: the
 * Idle loop on AngleX (10 per s), the one-shot "Look" on AngleY (3, then 10
 * per s), and "rise" adding 1 to BrowLY over a 1 s fade-in. With the Idle
 * group the procedural head is dropped, so nothing else writes those ids.
 */
function timedModel(): IkiModel {
  return model({
    deformers: [HEAD_DEFORMER],
    physics: [RIG],
    physicsChains: [CHAIN],
    expressions: [
      expression(
        "rise",
        [{ parameter: StandardParameter.BrowLeftY, value: 1 }],
        { fadeIn: 1 },
      ),
    ],
    motions: {
      [IDLE_MOTION_GROUP]: [ramp(StandardParameter.AngleX, 0, 20, 2)],
      Look: [ramp(StandardParameter.AngleY, 3, 13, 1)],
    },
  });
}

// --- Test harness -------------------------------------------------------------

type Write = [id: string, value: number];

/**
 * An IkiMotion over a ParameterStore, as a host wires it to the player: `read`
 * reads the store and the sink writes it. The sink also records each write in
 * order; `step(now)` runs one update and returns that update's writes.
 */
function harness(m: IkiModel): {
  motion: IkiMotion;
  store: ParameterStore;
  step: (nowMs: number) => Write[];
} {
  const store = new ParameterStore(m.parameters);
  let writes: Write[] = [];
  const motion = new IkiMotion(
    m,
    (id) => store.get(id),
    (id, value) => {
      writes.push([id, value]);
      store.set(id, value);
    },
  );
  const step = (nowMs: number): Write[] => {
    writes = [];
    motion.update(nowMs);
    return writes;
  };
  return { motion, store, step };
}

const idsOf = (writes: Write[]): string[] => writes.map(([id]) => id);

/** The one value `id` was written with; fails unless it was written once. */
function only(writes: Write[], id: string): number {
  const values = writes.filter(([w]) => w === id).map(([, v]) => v);
  expect(values, id).toHaveLength(1);
  return values[0];
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

describe("IkiMotion frame order", () => {
  it("writes blink and breath, the clips, the expression, then the rig and the chain, each id once", () => {
    const { motion, step } = harness(animatedModel());
    motion.playMotion("Nod", 0);
    motion.playExpression("smile");

    for (const now of [1000, 1016, 1032]) {
      const written = idsOf(step(now));
      expect(written).toEqual([
        // The smile's EyeOpenLeft is flushed in idle's slot, not after the clips.
        StandardParameter.EyeOpenLeft,
        StandardParameter.EyeOpenRight,
        StandardParameter.Breath,
        StandardParameter.AngleX,
        StandardParameter.AngleY,
        StandardParameter.BrowLeftY,
        RIG_OUT,
        SEG0_OUT,
      ]);
      for (const id of written) expect(motion.drivenParameterIds).toContain(id);
    }
  });

  it("composes the expression over the clip: a held 10 plus 5 is 15", () => {
    const { motion, store, step } = harness(
      model({
        expressions: [
          expression("lean", [
            { parameter: StandardParameter.AngleZ, value: 5 },
          ]),
        ],
        motions: { Tilt: [clip(StandardParameter.AngleZ, 10)] },
      }),
    );
    motion.playMotion("Tilt", 0);
    motion.playExpression("lean");

    for (const now of [1000, 1016, 1032]) {
      step(now);
      // Expression first, then the clip at full weight, would leave 10.
      expect(store.get(StandardParameter.AngleZ)).toBeCloseTo(15, 9);
    }
  });

  it("physics reads the head the Idle clip wrote in the same update", () => {
    const { store, step } = harness(
      model({
        physics: [RIG],
        motions: {
          [IDLE_MOTION_GROUP]: [clip(StandardParameter.AngleX, 20)],
        },
      }),
    );

    // The clip writes AngleX = 20 first, so the spring seeds at target
    // signedNormalized(20) = 20/30 and emits 0 + (20/30) × 10. Physics before
    // the clip would read the resting 0 and emit 0.
    step(1000);

    expect(store.get(RIG_OUT)).toBeCloseTo((20 / 30) * 10);
  });

  it("an add does not accumulate, and a released parameter rests at its default and is no longer written", () => {
    const { motion, store, step } = harness(
      model({
        expressions: [
          expression(
            "raise",
            [{ parameter: StandardParameter.BrowLeftY, value: 0.3 }],
            { fadeOut: 0.25 },
          ),
        ],
      }),
    );
    const rest = 0; // BrowLY's default; nothing else writes it.
    motion.playExpression("raise");

    let now = 1000;
    for (let i = 0; i < 600; i++, now += 16) {
      step(now);
      expect(store.get(StandardParameter.BrowLeftY)).toBe(rest + 0.3);
    }

    motion.stopExpression();
    const released: number[] = [];
    for (let i = 0; i < 100; i++, now += 16) {
      for (const [id, value] of step(now)) {
        if (id === StandardParameter.BrowLeftY) released.push(value);
      }
    }
    // The 0.25 s release spans 16 frames of 16 ms; its last write is the base.
    expect(released).toHaveLength(16);
    expect(released.at(-1)).toBe(rest);
    expect(store.get(StandardParameter.BrowLeftY)).toBe(rest);
  });

  it("an expression composes with the blink: multiply keeps it, overwrite replaces it", () => {
    // IkiMotion builds IdleMotion without an rng, so pin Math.random: the
    // first blink lands 1.5 s in and the next ones follow on a fixed beat.
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const eyes = [
        StandardParameter.EyeOpenLeft,
        StandardParameter.EyeOpenRight,
      ];
      const m = model({
        expressions: [
          expression(
            "half",
            eyes.map((parameter) => ({
              parameter,
              value: 0.5,
              blend: "multiply" as const,
            })),
          ),
          expression(
            "held",
            eyes.map((parameter) => ({
              parameter,
              value: 0.5,
              blend: "overwrite" as const,
            })),
          ),
        ],
      });
      // 10 s of 16 ms frames; every frame writes both eyes.
      const eyeWrites = (id: string): number[] => {
        const { motion, step } = harness(m);
        motion.playExpression(id);
        const values: number[] = [];
        for (let now = 1000; now <= 11000; now += 16) {
          for (const [w, value] of step(now)) {
            if ((eyes as string[]).includes(w)) values.push(value);
          }
        }
        expect(values).toHaveLength(2 * 626);
        return values;
      };

      const halved = eyeWrites("half");
      for (const v of halved) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(0.5);
      }
      expect(Math.min(...halved)).toBeLessThan(0.5); // a blink happened

      for (const v of eyeWrites("held")) expect(v).toBe(0.5);
    } finally {
      random.mockRestore();
    }
  });

  it("the host's lip-sync, written after update(), wins over an expression on MouthOpen", () => {
    const { motion, store, step } = harness(
      model({
        expressions: [
          expression("open", [
            {
              parameter: StandardParameter.MouthOpen,
              value: 1,
              blend: "overwrite",
            },
          ]),
        ],
      }),
    );
    motion.playExpression("open");

    for (let i = 0; i < 60; i++) {
      const mouth = (i % 5) * 0.2;
      // Every update writes the expression's mouth, so a host value written
      // before update() is overwritten...
      store.set(StandardParameter.MouthOpen, mouth);
      const writes = step(1000 + i * 16);
      expect(only(writes, StandardParameter.MouthOpen)).toBe(1);
      expect(store.get(StandardParameter.MouthOpen)).toBe(1);
      // ...and one written after it is what the frame renders.
      store.set(StandardParameter.MouthOpen, mouth);
      expect(store.get(StandardParameter.MouthOpen)).toBe(mouth);
    }
  });
});

describe("IkiMotion Idle replacement", () => {
  it("with an Idle group, AngleX is the clip's sample and no procedural head or gaze is written", () => {
    const { step } = harness(
      model({
        motions: {
          [IDLE_MOTION_GROUP]: [ramp(StandardParameter.AngleX, 0, 20, 2)],
        },
      }),
    );

    const written = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const writes = step(1000 + i * 16);
      for (const id of idsOf(writes)) written.add(id);
      // The ramp rises 10 per second; the loop is 16 ms further each frame.
      expect(only(writes, StandardParameter.AngleX)).toBeCloseTo(
        10 * i * 0.016,
        9,
      );
    }
    // EyeballX/Y, and the AngleY/Z the clip lacks, are never written.
    expect(written).toEqual(
      new Set([
        StandardParameter.EyeOpenLeft,
        StandardParameter.EyeOpenRight,
        StandardParameter.Breath,
        StandardParameter.AngleX,
      ]),
    );
  });

  it("without an Idle group, idle writes all eight procedural ids every update", () => {
    // A declared group that is not Idle replaces nothing.
    const { step } = harness(
      model({ motions: { Nod: [clip(StandardParameter.AngleY, 5)] } }),
    );
    const idleIds = new IdleMotion(() => {}).drivenParameterIds;
    expect(idleIds).toHaveLength(8);

    for (const now of [1000, 1016, 1032]) {
      expect(idsOf(step(now))).toEqual(idleIds);
    }
  });

  it("a non-finite timestamp writes nothing from idle or the players and does not advance them", () => {
    const dropped = harness(timedModel());
    const control = harness(timedModel());
    for (const { motion } of [dropped, control]) {
      motion.playMotion("Look", 0);
      motion.playExpression("rise");
    }
    for (const now of [1000, 1016]) {
      dropped.step(now);
      control.step(now);
    }

    // Only physics and the chain re-emit their outputs.
    expect(idsOf(dropped.step(NaN))).toEqual([RIG_OUT, SEG0_OUT]);

    const a = dropped.step(1032);
    const b = control.step(1032);
    for (const id of [
      StandardParameter.AngleX,
      StandardParameter.AngleY,
      StandardParameter.BrowLeftY,
    ]) {
      expect(only(a, id)).toBe(only(b, id));
    }
  });
});

describe("IkiMotion player clock", () => {
  /** Play "Look" and "rise", then step through `times`; the last update's writes. */
  function playThrough(times: number[]): Write[] {
    const { motion, step } = harness(timedModel());
    motion.playMotion("Look", 0);
    motion.playExpression("rise");
    let writes: Write[] = [];
    for (const now of times) writes = step(now);
    return writes;
  }

  /** The three layers at `s` seconds in: Idle, one-shot, expression. */
  function expectAdvancedBy(writes: Write[], s: number): void {
    expect(only(writes, StandardParameter.AngleX)).toBeCloseTo(10 * s, 9);
    expect(only(writes, StandardParameter.AngleY)).toBeCloseTo(3 + 10 * s, 9);
    expect(only(writes, StandardParameter.BrowLeftY)).toBeCloseTo(s, 9);
  }

  it("dt is 0 on the first update: a clip played before it is sampled at t = 0", () => {
    // A late first timestamp is not a gap from anything.
    expectAdvancedBy(playThrough([5000]), 0);
  });

  it("a long gap advances the clips and expressions by at most MAX_DT_MS", () => {
    // Unclamped, 10 s would end the 1 s one-shot and finish the fade-in.
    expectAdvancedBy(playThrough([1000, 11000]), MAX_DT_MS / 1000);
  });

  it("a non-finite frame does not move the clock: the next one measures from the last finite one", () => {
    expectAdvancedBy(playThrough([1000, NaN, 1050]), 0.05);
  });
});
