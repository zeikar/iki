import type {
  IkiDeformer,
  IkiParameter,
  IkiPhysicsChain,
  IkiPhysicsChainSegment,
} from "@iki/format";
import type { Affine } from "./affine";
import { resolveDeformerWorlds } from "./deform";
import { ParameterStore } from "./parameter-store";

// --- Module-internal timing/integration constants (controlled dup of physics-motion.ts) ---
// Each driver is self-contained; do NOT import from physics-motion.ts.

const MAX_DT_MS = 100; // clamp per-frame dt so a backgrounded tab can't snap state
const FIXED_DT_S = 1 / 60; // fixed integration sub-step, in SECONDS
const MAX_SUBSTEPS = 6; // catch-up cap per frame (spiral-of-death guard)

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

// --- Small pure helpers (controlled dup of physics-motion.ts) ----------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// --- Per-chain / per-segment state -------------------------------------------

/** Integrator state for one segment. angle = θ displacement in RADIANS. */
interface SegmentState {
  angle: number; // θ_i in radians (displacement from rest)
  angularVelocity: number; // ω_i in radians/s
}

/** All precomputed per-chain data (rest angles already in radians). */
interface ChainData {
  chain: IkiPhysicsChain;
  restAnglesRad: number[]; // restAngle_j in radians; 0 when omitted
  state: SegmentState[]; // preallocated, length = segments.length
}

// --- Public API --------------------------------------------------------------

/**
 * Host-agnostic multi-segment angular-pendulum-chain secondary-motion driver.
 * Peer of {@link PhysicsMotion} and {@link IdleMotion}.
 *
 * Each chain anchors to a matrix deformer in the model hierarchy. The driver
 * self-computes the anchor's world rotation via `resolveDeformerWorlds` (a
 * private `ParameterStore` is filled from `read` ONCE per frame) and integrates
 * a per-segment angular pendulum with semi-implicit Euler on a fixed 1/60s
 * sub-step accumulator. Each segment's angular displacement θ (in radians
 * internally) is emitted in DEGREES on its output parameter, so `rotate = 0`
 * when the chain is at its authored rest pose.
 *
 * Usage:
 *   const chains = new HairChainMotion(
 *     model.physicsChains ?? [],
 *     model.parameters,
 *     model.deformers ?? [],
 *     (id) => currentValue(id),
 *     player.setParameter.bind(player),
 *   );
 *   // inside your rAF loop, right AFTER physics.update(now):
 *   chains.update(performance.now());
 *
 * The host schedules updates; this class has no timers, rAF, DOM, or Date.now.
 */
export class HairChainMotion {
  private readonly chainData: ChainData[];
  private readonly params: Map<string, IkiParameter>;
  private readonly deformers: IkiDeformer[];
  private readonly store: ParameterStore;
  private readonly read: (id: string) => number;
  private readonly sink: (id: string, value: number) => void;

  private prevNowMs: number | undefined = undefined;
  private accumulatorS = 0;

  constructor(
    chains: IkiPhysicsChain[],
    params: IkiParameter[],
    deformers: IkiDeformer[],
    read: (id: string) => number,
    sink: (id: string, value: number) => void,
  ) {
    this.params = new Map(params.map((p) => [p.id, p]));
    this.deformers = deformers;
    // Private ParameterStore reused every frame for anchor-world resolution.
    this.store = new ParameterStore(params);
    this.read = read;
    this.sink = sink;

    // Precompute rest angles in radians; preallocate segment state (no per-substep alloc).
    this.chainData = chains.map((chain) => ({
      chain,
      restAnglesRad: chain.segments.map((seg) =>
        seg.restAngle !== undefined ? seg.restAngle * DEG2RAD : 0,
      ),
      state: chain.segments.map(() => ({ angle: 0, angularVelocity: 0 })),
    }));
  }

  /**
   * Advance every chain to the given wall-clock timestamp (milliseconds).
   *
   * First call: seed every segment to θ=0/ω=0 (rest), emit the rest output
   * (outDefault + 0), and return without integrating — mirrors PhysicsMotion's
   * first-frame behavior so a model loaded in motion does not kick.
   *
   * Subsequent calls: dt = clamp(nowMs - prevNowMs, 0, MAX_DT_MS) → seconds into
   * accumulator. The per-frame world snapshot (anchor world angles) is taken ONCE
   * per update() — NOT per chain — so all chains share a consistent frame snapshot.
   * Fixed FIXED_DT_S sub-steps are run root→tip, capped at MAX_SUBSTEPS; leftover
   * time is carried to the next frame. Segments emit after substeps (even on zero
   * substeps) with a non-finite guard.
   */
  update(nowMs: number): void {
    if (this.prevNowMs === undefined) {
      // FIRST FRAME: seed rest, emit outDefault for every segment, NO integration.
      this.prevNowMs = nowMs;
      for (const cd of this.chainData) {
        for (let i = 0; i < cd.chain.segments.length; i++) {
          cd.state[i].angle = 0;
          cd.state[i].angularVelocity = 0;
          this.emitSegment(cd.chain.segments[i], cd.state[i]);
        }
      }
      return;
    }

    const rawDt = nowMs - this.prevNowMs;
    const dtMs = clamp(rawDt, 0, MAX_DT_MS);
    this.prevNowMs = nowMs;
    this.accumulatorS += dtMs / 1000;

    // Take the per-frame world snapshot ONCE per update() — NOT per chain.
    // Fill the private store from read, then resolve all deformer world matrices.
    for (const param of this.params.values()) {
      this.store.set(param.id, this.read(param.id));
    }
    const worldMap = resolveDeformerWorlds(this.deformers, this.store);

    // Read each chain's anchor world angle ONCE per frame (consistent across substeps,
    // like physics-motion.ts:122 `targets`).
    const anchorAnglesRad = this.chainData.map((cd) =>
      this.anchorWorldAngleRad(worldMap, cd.chain.anchorDeformer),
    );

    let steps = 0;
    while (this.accumulatorS >= FIXED_DT_S && steps < MAX_SUBSTEPS) {
      for (let c = 0; c < this.chainData.length; c++) {
        this.stepChain(this.chainData[c], anchorAnglesRad[c]);
      }
      this.accumulatorS -= FIXED_DT_S;
      steps++;
    }

    // Emit always (even on zero substeps) so the sink stays in sync.
    for (const cd of this.chainData) {
      for (let i = 0; i < cd.chain.segments.length; i++) {
        const st = cd.state[i];
        // FINITENESS GUARD (mirror physics-motion.ts:141): a pathological rig
        // (tiny mass / huge stiffness) can push the fixed-substep integrator
        // past its explicit-stability limit. Snap the segment back to rest so
        // a validated model can never poison the sink with NaN/Infinity.
        if (
          !Number.isFinite(st.angle) ||
          !Number.isFinite(st.angularVelocity)
        ) {
          st.angle = 0;
          st.angularVelocity = 0;
        }
        this.emitSegment(cd.chain.segments[i], st);
      }
    }
  }

  /**
   * Extract world rotation (radians) from the anchor's Affine tuple.
   * Affine = [a,b,c,d,e,f]; rotation column = (a,b) → atan2(b,a).
   *
   * If the anchor id is absent from the map, THROWS an internal Error — the
   * format validator guarantees the anchor exists, so absence is an invariant
   * break (mirrors resolveDeformerWorlds' throw on an unresolved parent,
   * deform.ts:141).
   */
  private anchorWorldAngleRad(
    worldMap: Map<string, Affine>,
    anchorId: string,
  ): number {
    const world = worldMap.get(anchorId);
    if (!world) {
      throw new Error(
        `HairChainMotion: anchor deformer "${anchorId}" not found in resolved world map — model not validated?`,
      );
    }
    // Affine [a,b,c,d,e,f]: the first column (a,b) is the x-axis direction
    // after rotation, so atan2(b,a) gives the world rotation angle in radians.
    return Math.atan2(world[1], world[0]);
  }

  /**
   * One fixed sub-step of FIXED_DT_S seconds for all segments in a chain.
   *
   * Segments are integrated ROOT→TIP so each segment can read its upstream
   * neighbor's current-substep state when computing the world angle Φ_i.
   * (The chain is causal root-to-tip; reversing the order would use stale θ
   * values from the previous substep for Φ_i computation.)
   *
   * Per-segment semi-implicit (symplectic) Euler:
   *   Φ_i = anchorWorldAngleRad + Σ_{j≤i}(restAngle_j + θ_j)
   *   α_i = (−stiffness_i·θ_i − strength·sin(Φ_i − gravityAngle_rad) − damping_i·ω_i) / mass_i
   *   ω_i += α_i · FIXED_DT_S   (velocity updated FIRST = semi-implicit)
   *   θ_i += ω_i · FIXED_DT_S   (position updated from NEW velocity)
   *
   * The spring term is −stiffness·θ (restoring θ→0); restAngle does NOT appear
   * in the spring term, only in Φ_i for the gravity torque.
   */
  private stepChain(cd: ChainData, anchorAngleRad: number): void {
    const { chain, restAnglesRad, state } = cd;
    const gravityAngleRad = chain.gravity.angle * DEG2RAD;
    const strength = chain.gravity.strength;

    // Accumulate world angle root→tip as we go.
    let worldAngleAccumRad = anchorAngleRad;

    for (let i = 0; i < chain.segments.length; i++) {
      const seg: IkiPhysicsChainSegment = chain.segments[i];
      const st = state[i];

      // World angle of this segment: anchor + sum of all segments 0..i.
      worldAngleAccumRad += restAnglesRad[i] + st.angle;
      const phi = worldAngleAccumRad;

      const alpha =
        (-seg.stiffness * st.angle -
          strength * Math.sin(phi - gravityAngleRad) -
          seg.damping * st.angularVelocity) /
        seg.mass;

      // Semi-implicit Euler: update velocity first, then position with new velocity.
      st.angularVelocity += alpha * FIXED_DT_S;
      st.angle += st.angularVelocity * FIXED_DT_S;
    }
  }

  /** Emit outDefault + (θ_i · RAD2DEG) · scale for one segment. */
  private emitSegment(seg: IkiPhysicsChainSegment, st: SegmentState): void {
    const outParam = this.params.get(seg.output.parameter);
    const outDefault = outParam
      ? clamp(outParam.default, outParam.min, outParam.max)
      : 0;
    const value = outDefault + st.angle * RAD2DEG * seg.output.scale;
    // Final guard: even a finite-but-enormous θ could overflow to ±Infinity.
    this.sink(
      seg.output.parameter,
      Number.isFinite(value) ? value : outDefault,
    );
  }
}
