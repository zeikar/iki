import type { IkiParameter, IkiPhysics } from "@ikijs/format";
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
}

/**
 * Host-agnostic 1D spring-mass-damper secondary-motion driver — the physics
 * peer of {@link IdleMotion}. For each rig it reads the input parameter,
 * signed-normalizes it around the input's default × `weight` to form a spring
 * target, integrates a lagging spring position with semi-implicit (symplectic)
 * Euler on a fixed 1/60s sub-step accumulator, and writes
 * `outputDefault + x * scale` onto the output parameter — so the output lags
 * and overshoots the input (hair/accessory sway).
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
  private readonly rigs: readonly IkiPhysics[];
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
    this.read = read;
    this.sink = sink;
    this.params = new Map(params.map((p) => [p.id, p]));
    this.state = rigs.map(() => ({ x: 0, v: 0 }));
  }

  /**
   * Advance every rig to the given wall-clock timestamp (milliseconds).
   *
   * First call: seed each spring to rest AT its current target (so a model
   * loaded with a nonzero input does not kick), emit the resting output, and
   * return without integrating — mirroring IdleMotion's first-frame behavior.
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
        st.x = this.targetFor(this.rigs[i]);
        st.v = 0;
        this.emit(this.rigs[i], st);
      }
      return;
    }

    const steps = this.clock.advance(nowMs);

    // update() is synchronous, so the input cannot change mid-loop — read each
    // rig's target ONCE per frame and reuse it across the sub-steps.
    const targets = this.rigs.map((rig) => this.targetFor(rig));

    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < this.rigs.length; i++) {
        this.step(this.rigs[i], this.state[i], targets[i]);
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
      if (!Number.isFinite(st.x) || !Number.isFinite(st.v)) {
        st.x = Number.isFinite(targets[i]) ? targets[i] : 0;
        st.v = 0;
      }
      this.emit(this.rigs[i], st);
    }
  }

  /** Spring target = signed-normalized input value × weight. */
  private targetFor(rig: IkiPhysics): number {
    const param = this.params.get(rig.input.parameter);
    const value = this.read(rig.input.parameter);
    const norm = param ? signedNormalized(value, param) : 0;
    return norm * rig.input.weight;
  }

  /** One semi-implicit (symplectic) Euler sub-step of FIXED_DT_S seconds. */
  private step(rig: IkiPhysics, st: RigState, target: number): void {
    const accel =
      (rig.stiffness * (target - st.x) - rig.damping * st.v) / rig.mass;
    st.v += accel * FIXED_DT_S;
    st.x += st.v * FIXED_DT_S;
  }

  /** Write outputDefault + x * scale onto the output param via the sink. */
  private emit(rig: IkiPhysics, st: RigState): void {
    const outParam = this.params.get(rig.output.parameter);
    // clamp to match ParameterStore's engine-effective default (see signedNormalized).
    const outDefault = outParam
      ? clamp(outParam.default, outParam.min, outParam.max)
      : 0;
    const value = outDefault + st.x * rig.output.scale;
    // Final guard: even a finite-but-enormous `x` could overflow the product to
    // ±Infinity. Emit the rest pose rather than hand a non-finite value to the
    // sink, which would drop the write and leave the output stuck where it was.
    this.sink(
      rig.output.parameter,
      Number.isFinite(value) ? value : outDefault,
    );
  }
}
