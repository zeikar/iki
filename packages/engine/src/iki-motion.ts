import type { IkiModel } from "@ikijs/format";
import { HairChainMotion } from "./hair-chain-motion";
import { IdleMotion } from "./idle-motion";
import { PhysicsMotion } from "./physics-motion";

/**
 * Bundles the three motion drivers — {@link IdleMotion}, {@link PhysicsMotion},
 * {@link HairChainMotion} — into the one loop every host otherwise hand-builds:
 * construct all three from the model, step them in the order physics and
 * chains depend on, and know what they wrote.
 *
 * Usage:
 *   const motion = new IkiMotion(
 *     model,
 *     (id) => player.getParameter(id),
 *     (id, value) => player.setParameter(id, value),
 *   );
 *   // inside your rAF loop:
 *   motion.update(performance.now());
 *
 * The host schedules; this class has no timers, rAF, DOM, or Date.now.
 *
 * Stopping is the host's too: stop calling update(). The drivers leave the
 * pose where it was — a host that wants it back writes its own resting values
 * to `drivenParameterIds`.
 */
export class IkiMotion {
  /**
   * Idle ids, then rig outputs, then chain-segment outputs, deduplicated and
   * insertion-ordered. May name ids the model lacks (the player silently
   * drops writes to unknown ids) — intersect with the model's parameters if
   * you mirror into your own store.
   */
  readonly drivenParameterIds: readonly string[];
  private readonly idle: IdleMotion;
  private readonly physics: PhysicsMotion;
  private readonly chains: HairChainMotion;

  constructor(
    model: IkiModel,
    read: (id: string) => number,
    sink: (id: string, value: number) => void,
  ) {
    const rigs = model.physics ?? [];
    const chains = model.physicsChains ?? [];
    this.idle = new IdleMotion(sink);
    this.physics = new PhysicsMotion(rigs, model.parameters, read, sink);
    this.chains = new HairChainMotion(
      chains,
      model.parameters,
      model.deformers ?? [],
      read,
      sink,
    );
    this.drivenParameterIds = [
      ...new Set([
        ...this.idle.drivenParameterIds,
        ...this.physics.drivenParameterIds,
        ...this.chains.drivenParameterIds,
      ]),
    ];
  }

  /**
   * Advance idle, then physics, then chains to the same wall-clock timestamp
   * (milliseconds). Order is load-bearing: `PhysicsMotion` reads its input
   * parameters (typically `ParamAngleX/Z`) through `read`, and the head sway
   * idle wrote THIS frame is what the springs must lag behind; `HairChainMotion`
   * then resolves its anchor deformer's world rotation from that same
   * just-written pose (which may include a physics output). One timestamp for
   * all three keeps their dt in lockstep.
   */
  update(nowMs: number): void {
    this.idle.update(nowMs);
    this.physics.update(nowMs);
    this.chains.update(nowMs);
  }
}
