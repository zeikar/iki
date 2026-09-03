import { clamp } from "./math";

/** Per-frame dt ceiling: a backgrounded tab or a long GC pause must not snap state. */
export const MAX_DT_MS = 100;
/** Fixed integration sub-step, in SECONDS. */
export const FIXED_DT_S = 1 / 60;
/** Catch-up cap per frame (spiral-of-death guard). */
export const MAX_SUBSTEPS = 6;

/**
 * Fixed-timestep accumulator shared by the physics drivers, so a stability fix
 * lands in one place instead of one of two near-identical copies.
 *
 * A driver calls {@link advance} once per frame and runs its integration body
 * that many times. Leftover time carries to the next frame, which is what keeps
 * the simulation frame-rate independent; the dt clamp and the sub-step cap keep
 * a hitch from either snapping the rig or spiralling into catch-up work.
 */
export class FixedStepClock {
  private prevNowMs: number | undefined = undefined;
  private accumulatorS = 0;

  /**
   * True until the first {@link advance}. Drivers seed their rest pose on that
   * frame and integrate nothing, so a model loaded mid-motion does not kick.
   */
  get isSeedFrame(): boolean {
    return this.prevNowMs === undefined;
  }

  /**
   * Fold `nowMs` into the accumulator and return how many {@link FIXED_DT_S}
   * sub-steps to run this frame. On the seed frame it only records the
   * timestamp and returns 0. A non-monotonic `nowMs` floors to 0 — no rewind.
   */
  advance(nowMs: number): number {
    if (this.prevNowMs === undefined) {
      this.prevNowMs = nowMs;
      return 0;
    }
    const dtMs = clamp(nowMs - this.prevNowMs, 0, MAX_DT_MS);
    this.prevNowMs = nowMs;
    this.accumulatorS += dtMs / 1000; // boundary ms->s conversion

    let steps = 0;
    while (this.accumulatorS >= FIXED_DT_S && steps < MAX_SUBSTEPS) {
      this.accumulatorS -= FIXED_DT_S;
      steps++;
    }
    return steps;
  }
}
