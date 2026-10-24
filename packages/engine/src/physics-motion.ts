import {
  type IkiParameter,
  type IkiPhysics,
  physicsInputs,
} from "@ikijs/format";
import { FIXED_DT_S, FixedStepClock } from "./frame-clock";
import { clamp } from "./math";

// --- Small pure helpers ------------------------------------------------------

/**
 * Map a parameter value to [-1, 1] around its engine-effective default. Portable
 * across param ranges: the wider side (rest→max vs min→rest) sets the unit, so
 * ±1 lands at the farther extreme. Returns 0 for a zero-width range.
 *
 * The rest center is `clamp(default, min, max)` to match ParameterStore, which
 * clamps an out-of-range default — so the spring rests where the model actually
 * renders, not at a raw out-of-range default.
 */
function signedNormalized(
  value: number,
  param: { min: number; max: number; default: number },
): number {
  const rest = clamp(param.default, param.min, param.max);
  const den = Math.max(Math.abs(param.max - rest), Math.abs(rest - param.min));
  if (den === 0) return 0;
  return clamp((value - rest) / den, -1, 1);
}

// --- Public API --------------------------------------------------------------

interface RigState {
  x: number; // spring position (lagging, normalized-ish units)
  v: number; // spring velocity
  lag: number; // Σ wᵢ·nᵢ over the lag inputs, as the last finite frame read it
}

/** One input of a rig, resolved once so the frame loop never branches on shape. */
interface RigInput {
  parameter: string;
  weight: number;
  lag: boolean;
}

/**
 * Host-agnostic 1D spring-mass-damper secondary-motion driver — the physics
 * peer of {@link IdleMotion}. For each rig it reads every input parameter,
 * signed-normalizes it around its default × `weight`, sums those into one spring
 * target `T`, integrates a lagging spring position `x` with semi-implicit
 * (symplectic) Euler on a fixed 1/60s sub-step accumulator, and writes
 * `outputDefault + (x − L) * scale` onto the output parameter, `L` being the
 * lag inputs' share of `T` — so the output lags and overshoots the inputs
 * (hair/accessory sway).
 *
 * By superposition a follow input's held value stays in the output (the spring
 * settles at `T`), while a lag input's held value settles out, returning the
 * output to rest: it swings only while that input moves. A rig seeded with a
 * lag input already displaced emits rest, without a kick. Inputs are not
 * smoothed, so a one-frame step on a lag input snaps the output by
 * `−scale·weight·Δn` before the spring catches up — deferred until a captured
 * snap calls for a rate limit.
 *
 * Usage:
 *   const physics = new PhysicsMotion(
 *     model.physics ?? [],
 *     model.parameters,
 *     (id) => currentValue(id),
 *     player.setParameter.bind(player),
 *   );
 *   // inside your rAF loop, right AFTER idle.update(now):
 *   physics.update(performance.now());
 *
 * The host schedules updates; this class has no timers, rAF, DOM, or Date.now.
 * Writes go through the sink, exactly like IdleMotion; the player renders the
 * updated params on its own render loop (drivers and rendering are decoupled).
 */
export class PhysicsMotion {
  /** The output parameter of every rig, in rig order — what `emit` writes. */
  readonly drivenParameterIds: readonly string[];
  /**
   * Per rig: how many times the finiteness guard reset its state or `emit`
   * replaced its non-finite product. Up to two per frame, so guard activations,
   * not repaired frames. A diagnostic; emitted values are unchanged.
   */
  readonly resets: readonly number[];
  private readonly resetCounts: number[];
  private readonly rigs: readonly IkiPhysics[];
  private readonly inputs: readonly (readonly RigInput[])[];
  private readonly read: (id: string) => number;
  private readonly sink: (id: string, value: number) => void;
  private readonly params: Map<string, IkiParameter>;

  // Integrator state, owned here — never stored in a ParameterStore.
  private readonly state: RigState[];
  private readonly clock = new FixedStepClock();

  constructor(
    rigs: IkiPhysics[],
    params: IkiParameter[],
    read: (id: string) => number,
    sink: (id: string, value: number) => void,
  ) {
    this.rigs = rigs;
    this.inputs = rigs.map((rig) =>
      physicsInputs(rig).map(({ parameter, weight, mode }) => ({
        parameter,
        weight,
        lag: mode === "lag",
      })),
    );
    this.read = read;
    this.sink = sink;
    this.params = new Map(params.map((p) => [p.id, p]));
    this.state = rigs.map(() => ({ x: 0, v: 0, lag: 0 }));
    this.drivenParameterIds = rigs.map((rig) => rig.output.parameter);
    this.resetCounts = rigs.map(() => 0);
    this.resets = this.resetCounts;
  }

  /**
   * Advance every rig to the given wall-clock timestamp (milliseconds).
   *
   * First call: seed each spring to rest AT its current target (so a model
   * loaded with a nonzero input does not kick: a lag input emits rest, a follow
   * input its value), emit that output, and return without integrating —
   * mirroring IdleMotion's first-frame behavior.
   *
   * A non-finite `nowMs` after that is a dropped frame: every rig re-emits its
   * last output from its stored state without reading its inputs.
   *
   * Subsequent calls: {@link FixedStepClock} folds the clamped frame delta into
   * its accumulator and returns how many {@link FIXED_DT_S} sub-steps are due;
   * the spring advances that many semi-implicit Euler steps, then each rig emits
   * its output once. The clock's dt clamp and sub-step cap plus the symplectic
   * integrator are what keep it stable across hitches.
   */
  update(nowMs: number): void {
    if (this.clock.isSeedFrame) {
      this.clock.advance(nowMs);
      for (let i = 0; i < this.rigs.length; i++) {
        const st = this.state[i];
        const { target, lag } = this.targetFor(i);
        st.x = target;
        st.v = 0;
        st.lag = lag;
        this.emit(i, st);
      }
      return;
    }

    // A dropped frame (the clock rejects it as well). Re-emit from the stored
    // `L` rather than read the inputs, or a lag rig's output would move on it.
    if (!Number.isFinite(nowMs)) {
      for (let i = 0; i < this.rigs.length; i++) this.emit(i, this.state[i]);
      return;
    }

    const steps = this.clock.advance(nowMs);

    // update() is synchronous, so the inputs cannot change mid-loop — read each
    // rig's target ONCE per frame and reuse it across the sub-steps.
    const targets = this.rigs.map((_, i) => this.targetFor(i));

    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < this.rigs.length; i++) {
        this.step(this.rigs[i], this.state[i], targets[i].target);
      }
    }

    // Always emit (even when zero sub-steps ran) so the sink stays in sync.
    for (let i = 0; i < this.rigs.length; i++) {
      const st = this.state[i];
      // The fixed 1/60s sub-step can diverge for an extreme-but-parse-valid rig
      // (tiny mass / huge stiffness push ω·dt past the explicit-integrator
      // stability limit). If state goes non-finite, snap back to rest at the
      // current target: the store DROPS a non-finite write, so an un-reset rig
      // would emit NaN every frame and silently freeze the part at its last
      // good pose instead of visibly diverging.
      const { target, lag } = targets[i];
      if (!Number.isFinite(st.x) || !Number.isFinite(st.v)) {
        st.x = Number.isFinite(target) ? target : 0;
        st.v = 0;
        this.resetCounts[i]++;
      }
      st.lag = lag;
      this.emit(i, st);
    }
  }

  /**
   * Rig `index`'s spring target `T` = Σ signed-normalized input value × weight,
   * and `L`, the lag inputs' share of it. Reads each input once.
   */
  private targetFor(index: number): { target: number; lag: number } {
    let target = 0;
    let lag = 0;
    for (const input of this.inputs[index]) {
      const param = this.params.get(input.parameter);
      const value = this.read(input.parameter);
      const share = (param ? signedNormalized(value, param) : 0) * input.weight;
      target += share;
      if (input.lag) lag += share;
    }
    return { target, lag };
  }

  /** One semi-implicit (symplectic) Euler sub-step of FIXED_DT_S seconds. */
  private step(rig: IkiPhysics, st: RigState, target: number): void {
    const accel =
      (rig.stiffness * (target - st.x) - rig.damping * st.v) / rig.mass;
    st.v += accel * FIXED_DT_S;
    st.x += st.v * FIXED_DT_S;
  }

  /** Write outputDefault + (x − L) * scale onto the output param via the sink. */
  private emit(index: number, st: RigState): void {
    const rig = this.rigs[index];
    const outParam = this.params.get(rig.output.parameter);
    // clamp to match ParameterStore's engine-effective default (see signedNormalized).
    const outDefault = outParam
      ? clamp(outParam.default, outParam.min, outParam.max)
      : 0;
    const value = outDefault + (st.x - st.lag) * rig.output.scale;
    // Final guard: even a finite-but-enormous `x` could overflow the product to
    // ±Infinity. Emit the rest pose rather than hand a non-finite value to the
    // sink, which would drop the write and leave the output stuck where it was.
    const finite = Number.isFinite(value);
    if (!finite) this.resetCounts[index]++;
    this.sink(rig.output.parameter, finite ? value : outDefault);
  }
}
