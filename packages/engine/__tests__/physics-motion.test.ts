import { describe, expect, it } from "vitest";
import type { IkiParameter, IkiPhysics } from "@iki/format";
import { PhysicsMotion } from "@iki/engine";

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

  it("is a no-op with an empty rig list", () => {
    const emissions = drive([], PARAMS, () => 30, timestamps(1000, 3, 16));
    expect(emissions.size).toBe(0);
  });
});
