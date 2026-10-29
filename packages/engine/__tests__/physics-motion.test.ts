import { describe, expect, it } from "vitest";
import type { IkiParameter, IkiPhysics } from "@ikijs/format";
import { PhysicsMotion } from "@ikijs/engine";

// --- Test harness (makeSink + timestamps copied from idle-motion.test.ts) -----

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

/**
 * Build a timestamp array: start at `startMs`, take `count` steps of
 * `stepMs` each. First element is the "first update" anchor.
 */
function timestamps(startMs: number, count: number, stepMs: number): number[] {
  return Array.from({ length: count }, (_, i) => startMs + i * stepMs);
}

/**
 * Drive a PhysicsMotion through `ts`, reading the current input from
 * `inputValueFn(id, t)` (so a test can script an input step over time), and
 * collect all emissions. Matches the pinned constructor (rigs, params, read, sink).
 */
function drive(
  rigs: IkiPhysics[],
  params: IkiParameter[],
  inputValueFn: (id: string, t: number) => number,
  ts: number[],
): Map<string, number[]> {
  const { sink, emissions } = makeSink();
  let now = ts[0];
  const read = (id: string) => inputValueFn(id, now);
  const motion = new PhysicsMotion(rigs, params, read, sink);
  for (const t of ts) {
    now = t;
    motion.update(t);
  }
  return emissions;
}

// --- Fixture ------------------------------------------------------------------

const INPUT = "ParamAngleX";
const OUTPUT = "ParamHairSwayX";

const PARAMS: IkiParameter[] = [
  { id: INPUT, name: "Angle X", min: -30, max: 30, default: 0 },
  { id: OUTPUT, name: "Hair Sway", min: -20, max: 20, default: 0 },
];

/** Underdamped (damping 10 < critical 2·√80 ≈ 17.9) so it overshoots. */
function rig(): IkiPhysics {
  return {
    id: "hairSway",
    input: { parameter: INPUT, weight: 1 },
    output: { parameter: OUTPUT, scale: -10 },
    mass: 1,
    stiffness: 80,
    damping: 10,
  };
}

// signedNormalized(30) = 1; steady-state output = default(0) + 1 * scale(-10).
const STEADY = -10;

const last = (a: number[]) => a[a.length - 1];

// --- Tests --------------------------------------------------------------------

describe("PhysicsMotion survives a non-finite timestamp", () => {
  // A NaN accumulator would make every `NaN >= FIXED_DT_S` false forever, so a
  // single bad frame would freeze the rig with no way back.
  it("ignores the bad frame and keeps integrating afterwards", () => {
    const params: IkiParameter[] = [
      { id: "in", min: -1, max: 1, default: 0 },
      { id: "out", min: -10, max: 10, default: 0 },
    ];
    const rigs: IkiPhysics[] = [
      {
        id: "r",
        input: { parameter: "in", weight: 1 },
        output: { parameter: "out", scale: 10 },
        mass: 1,
        stiffness: 80,
        damping: 4,
      },
    ];
    const live = new Map<string, number>([
      ["in", 0],
      ["out", 0],
    ]);
    const m = new PhysicsMotion(
      rigs,
      params,
      (id) => live.get(id) ?? 0,
      (id, v) => live.set(id, v),
    );
    m.update(0);
    live.set("in", 1);
    m.update(NaN);
    m.update(500);
    m.update(1000);
    expect(Number.isFinite(live.get("out"))).toBe(true);
    expect(Math.abs(live.get("out")!)).toBeGreaterThan(0);
  });
});

describe("PhysicsMotion", () => {
  it("first update emits no jump (seeds rest at the current target)", () => {
    const emissions = drive(
      [rig()],
      PARAMS,
      () => 0, // input held at default
      timestamps(1000, 2, 16),
    );
    const out = emissions.get(OUTPUT)!;
    expect(out[0]).toBe(0); // first emission == output default, no kick
    expect(Math.abs(out[1])).toBeLessThan(1e-6); // still resting at the default
  });

  it("step input -> lags, then overshoots, then settles", () => {
    // First update at the DEFAULT (seeds rest, emits 0), then step to +30.
    const ts = timestamps(1000, 130, 16); // ~2s run
    const inputFn = (_id: string, t: number) => (t <= ts[0] ? 0 : 30);
    const out = drive([rig()], PARAMS, inputFn, ts).get(OUTPUT)!;

    // (a) lag: the first post-step sample has NOT instantly reached steady state.
    expect(Math.abs(out[1])).toBeLessThan(Math.abs(STEADY));

    // (b) overshoot: at some point the magnitude exceeds the steady-state magnitude.
    const maxMag = Math.max(...out.map(Math.abs));
    expect(maxMag).toBeGreaterThan(Math.abs(STEADY));

    // (c) settle: the tail converges back to the steady-state value.
    expect(Math.abs(last(out) - STEADY)).toBeLessThan(0.5);
  });

  it("huge dt does not explode (clamp + substep cap + symplectic Euler)", () => {
    const { sink, emissions } = makeSink();
    let now = 0;
    const read = () => (now <= 1000 ? 0 : 30);
    const motion = new PhysicsMotion([rig()], PARAMS, read, sink);
    for (const t of [1000, 1016, 61016]) {
      // anchor at default, one normal step at +30, then a 60s jump
      now = t;
      motion.update(t);
    }
    const out = emissions.get(OUTPUT)!;
    for (const v of out) {
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThan(100); // generous bound around steady state
    }
  });

  it("settles back to rest when the input returns to default", () => {
    const ts = timestamps(1000, 260, 16); // ~4s
    const mid = ts[120];
    // default -> step to +30 for ~2s -> back to default for ~2s
    const inputFn = (_id: string, t: number) =>
      t <= ts[0] ? 0 : t < mid ? 30 : 0;
    const out = drive([rig()], PARAMS, inputFn, ts).get(OUTPUT)!;
    expect(Math.abs(last(out))).toBeLessThan(0.5); // converged back to default 0
  });

  it("is deterministic across identical drivers", () => {
    const ts = timestamps(1000, 80, 16);
    const inputFn = (_id: string, t: number) => (t <= ts[0] ? 0 : 30);
    const a = drive([rig()], PARAMS, inputFn, ts).get(OUTPUT)!;
    const b = drive([rig()], PARAMS, inputFn, ts).get(OUTPUT)!;
    expect(a).toEqual(b);
  });

  it("never emits NaN/Infinity for an extreme-but-valid rig", () => {
    // Tiny mass + huge stiffness push the fixed-substep integrator past its
    // explicit-stability limit; the finiteness guard must keep the sink clean.
    const extreme: IkiPhysics = {
      id: "stiff",
      input: { parameter: INPUT, weight: 1 },
      output: { parameter: OUTPUT, scale: -10 },
      mass: 1e-9,
      stiffness: 1e12,
      damping: 0,
    };
    const ts = timestamps(1000, 40, 16);
    const inputFn = (_id: string, t: number) => (t <= ts[0] ? 0 : 30);
    const out = drive([extreme], PARAMS, inputFn, ts).get(OUTPUT)!;
    // The contract is finiteness: the sink must never receive NaN/Infinity (the
    // host's ParameterStore clamps any finite magnitude into range, but cannot
    // clamp NaN). A diverging spring may emit large-but-finite values for a
    // frame before the guard snaps it back to rest — those are clamp-safe.
    for (const v of out) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("normalizes/emits against the clamped engine-effective default", () => {
    // Out-of-range defaults: ParameterStore clamps input rest to 30, output to 20.
    const params: IkiParameter[] = [
      { id: INPUT, name: "Angle X", min: -30, max: 30, default: 99 },
      { id: OUTPUT, name: "Hair Sway", min: -20, max: 20, default: 50 },
    ];
    // Input held at its clamped rest (30) -> spring target 0 -> output rests at
    // the CLAMPED output default (20), not the raw 50.
    const out = drive([rig()], params, () => 30, timestamps(1000, 3, 16)).get(
      OUTPUT,
    )!;
    expect(out[0]).toBeCloseTo(20, 6);
  });

  it("is a no-op with an empty rig list", () => {
    const emissions = drive([], PARAMS, () => 30, timestamps(1000, 3, 16));
    expect(emissions.size).toBe(0);
  });

  it("publishes each rig's output parameter, in rig order", () => {
    const second: IkiPhysics = {
      id: "second",
      input: { parameter: INPUT, weight: 1 },
      output: { parameter: "ParamOther", scale: 5 },
      mass: 1,
      stiffness: 40,
      damping: 6,
    };
    const motion = new PhysicsMotion(
      [rig(), second],
      PARAMS,
      () => 0,
      () => {},
    );
    expect(motion.drivenParameterIds).toEqual([OUTPUT, "ParamOther"]);
  });

  it("counts no guard resets for a well-behaved rig", () => {
    const { sink } = makeSink();
    const motion = new PhysicsMotion([rig()], PARAMS, () => 30, sink);
    for (const t of timestamps(1000, 10, 16)) motion.update(t);
    expect(motion.resets).toEqual([0]);
  });

  it("counts a state reset when the integrator diverges", () => {
    const { sink } = makeSink();
    let now = 1000;
    const diverging: IkiPhysics = { ...rig(), mass: 0.001, stiffness: 1e6 };
    const motion = new PhysicsMotion(
      [diverging],
      PARAMS,
      () => (now <= 1000 ? 0 : 30),
      sink,
    );
    for (const t of timestamps(1000, 200, 16)) {
      now = t;
      motion.update(t);
    }
    expect(motion.resets[0]).toBeGreaterThan(0);
  });

  it("counts an emit fallback the sink never sees", () => {
    const { sink, emissions } = makeSink();
    let now = 1000;
    const overflowing: IkiPhysics = {
      ...rig(),
      input: { parameter: INPUT, weight: Number.MAX_VALUE },
    };
    const motion = new PhysicsMotion(
      [overflowing],
      PARAMS,
      () => (now <= 1000 ? 0 : 30),
      sink,
    );
    for (const t of timestamps(1000, 10, 16)) {
      now = t;
      motion.update(t);
    }
    expect(motion.resets[0]).toBeGreaterThan(0);
    expect(new Set(emissions.get(OUTPUT))).toEqual(new Set([0]));
  });
});

describe("PhysicsMotion follows or lags each input", () => {
  const LEVER = "ParamLever";
  const params: IkiParameter[] = [
    ...PARAMS,
    { id: LEVER, name: "Lever", min: -1, max: 1, default: 0 },
  ];

  /** rig()'s spring, driven by the given inputs. */
  function rigWith(inputs: IkiPhysics["inputs"]): IkiPhysics {
    const { input: _single, ...base } = rig();
    return { ...base, inputs };
  }

  const lagX = { parameter: INPUT, weight: 1, mode: "lag" as const };
  // ~5 s of 16 ms frames after the seed frame.
  const ts = timestamps(1000, 314, 16);

  it("swings the output on a lag input's step and settles it back to rest", () => {
    const inputFn = (_id: string, t: number) => (t <= ts[0] ? 0 : 30);
    const out = drive([rigWith([lagX])], params, inputFn, ts).get(OUTPUT)!;
    // −scale·weight = 10, less at most one sub-step's travel.
    expect(Math.abs(out[1] - 10)).toBeLessThan(0.3);
    expect(Math.abs(last(out))).toBeLessThan(0.01);
  });

  it("seeds a displaced lag input at rest and a follow input at its value", () => {
    const lagOnly = drive([rigWith([lagX])], params, () => 30, ts).get(OUTPUT)!;
    for (const v of lagOnly) expect(Math.abs(v)).toBeLessThan(1e-9);

    const lever = { parameter: LEVER, weight: 0.25 };
    const mixed = drive(
      [rigWith([lagX, lever])],
      params,
      (id) => (id === INPUT ? 30 : 1),
      ts,
    ).get(OUTPUT)!;
    // scale·weight·n for the follow lever, nothing for the held AngleX.
    for (const v of mixed) expect(Math.abs(v - -2.5)).toBeLessThan(1e-9);
  });

  it("passes a follow input's held value while a held lag input settles out", () => {
    const lever = { parameter: LEVER, weight: 0.25, mode: "follow" as const };
    const inputFn = (id: string, t: number) =>
      t <= ts[0] ? 0 : id === INPUT ? 30 : 1;
    const out = drive([rigWith([lagX, lever])], params, inputFn, ts).get(
      OUTPUT,
    )!;
    expect(Math.max(...out.map(Math.abs))).toBeGreaterThan(5); // the AngleX swing
    expect(Math.abs(last(out) - -2.5)).toBeLessThan(0.01);
  });

  it("sums two follow inputs into one target", () => {
    const inputs = [
      { parameter: INPUT, weight: 1 },
      { parameter: LEVER, weight: 0.5 },
    ];
    const inputFn = (id: string, t: number) =>
      t <= ts[0] ? 0 : id === INPUT ? 30 : 1;
    const out = drive([rigWith(inputs)], params, inputFn, ts).get(OUTPUT)!;
    expect(Math.abs(last(out) - -15)).toBeLessThan(0.01); // −10·(1·1 + 0.5·1)
  });

  it("re-emits the last output on a non-finite frame without reading inputs", () => {
    let value = 0;
    let reads = 0;
    const read = (id: string) => {
      reads++;
      return id === INPUT ? value : 0;
    };
    const { sink, emissions } = makeSink();
    const motion = new PhysicsMotion([rigWith([lagX])], params, read, sink);
    motion.update(1000);
    value = 30;
    for (const t of timestamps(1016, 10, 16)) motion.update(t);
    const out = emissions.get(OUTPUT)!;
    const before = last(out);

    value = 0;
    reads = 0;
    motion.update(NaN);
    expect(reads).toBe(0);
    expect(last(out)).toBe(before);

    motion.update(1016 + 10 * 16);
    expect(last(out)).not.toBe(before);
  });
});

describe("PhysicsMotion emits a continuous series whatever the frame clock", () => {
  // A lag rig's output is `(x − L)·scale`; `L` follows the input this frame while
  // `x` moves in whole 1/60 s sub-steps, so a frame that happened to run one
  // sub-step more or fewer jumped the output by about ΔL·scale (hair jitter).
  const lagRig = (): IkiPhysics => ({
    id: "hairSway",
    inputs: [{ parameter: INPUT, weight: 1, mode: "lag" }],
    output: { parameter: OUTPUT, scale: -10 },
    mass: 1,
    stiffness: 80,
    damping: 10,
  });
  // 25 units/s: 0 → 30 over 1.2 s, a monotonic ramp inside the parameter range.
  const ramp = (_id: string, t: number) => (25 * t) / 1000;
  // `i·1000/fps` ms timestamps: the float rounding makes the per-frame sub-step
  // count vary (0/1/2 at 60 fps, 3/4/5 at 15 fps) although the clock is even.
  const run = (fps: number, frames: number) =>
    drive(
      [lagRig()],
      PARAMS,
      ramp,
      Array.from({ length: frames }, (_, i) => (i * 1000) / fps),
    ).get(OUTPUT)!;

  // Largest second difference past the launch: a smooth series has a small one,
  // a sub-step sawtooth jumps by about ΔL·scale between neighbouring frames.
  const roughness = (a: number[], from: number) => {
    let worst = 0;
    for (let i = from; i < a.length - 1; i++) {
      worst = Math.max(worst, Math.abs(a[i + 1] - 2 * a[i] + a[i - 1]));
    }
    return worst;
  };

  it("a 60 fps clock with sub-ms timestamp noise and a 120 Hz one track the ramp smoothly", () => {
    expect(roughness(run(60, 72), 12)).toBeLessThan(0.02);
    expect(roughness(run(120, 144), 24)).toBeLessThan(0.02);
  });
});
