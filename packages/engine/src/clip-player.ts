import {
  IDLE_MOTION_GROUP,
  type IkiMotionClip,
  type IkiMotionCurve,
  type IkiParameter,
} from "@ikijs/format";
import { clamp, lerp } from "./math";

// --- Small pure helpers ------------------------------------------------------

/**
 * A curve's value at `t` seconds: linear between the keys either side of `t`,
 * holding the first key's value before it and the last key's value after it.
 * Exported for the tests; not part of the package entry.
 */
export function sampleCurve(keys: IkiMotionCurve["keys"], t: number): number {
  const first = keys[0];
  if (t <= first[0]) return first[1];
  const last = keys[keys.length - 1];
  if (t >= last[0]) return last[1];
  // first[0] < t < last[0], so the scan stops on a key after `t`; `<=` puts a
  // `t` exactly on a key at the start of its segment, where the lerp is exact.
  let i = 1;
  while (keys[i][0] <= t) i++;
  const [t0, v0] = keys[i - 1];
  const [t1, v1] = keys[i];
  return lerp(v0, v1, (t - t0) / (t1 - t0));
}

/**
 * The clip's fade-in and fade-out weights at `t` seconds into it, each clamped
 * to `[0, 1]`. A zero (or absent) fade gives 1 — no fade on that side.
 * Exported for the tests; not part of the package entry.
 */
export function fadeWeights(
  clip: IkiMotionClip,
  t: number,
): { wIn: number; wOut: number } {
  const fadeIn = clip.fadeIn ?? 0;
  const fadeOut = clip.fadeOut ?? 0;
  return {
    wIn: fadeIn > 0 ? clamp(t / fadeIn, 0, 1) : 1,
    wOut: fadeOut > 0 ? clamp((clip.duration - t) / fadeOut, 0, 1) : 1,
  };
}

// --- Clip player -------------------------------------------------------------

/** The one-shot slot: one playing clip, no queue. */
interface Slot {
  clip: IkiMotionClip;
  /** Seconds since the clip started. */
  t: number;
  /** The pose the clip fades in from: the replaced clip's last output. */
  from: Map<string, number>;
  /**
   * What the slot wrote on its last apply, clamped to each parameter's range;
   * `from` until the first apply, since that is still what is on screen.
   */
  last: Map<string, number>;
}

/**
 * Plays a model's motion clips into a per-update frame map. Internal to
 * {@link IkiMotion}, which owns the frame: the base rule below only holds
 * inside that frame, so this is not exported from the package entry.
 *
 * Two layers, written in this order on every {@link apply}:
 * - the Idle loop, when the model declares {@link IDLE_MOTION_GROUP}: its clips
 *   back-to-back at full weight, wrapping from the last to the first;
 * - the one-shot slot over it, started by {@link play}. A clip blends between
 *   the frame's base value and its own curves with its fade-in and fade-out;
 *   a new `play` replaces the running clip and fades in from its last output.
 *
 * IkiMotion steps it once per update; this class has no timers, rAF, DOM, or
 * Date.now.
 */
export class ClipPlayer {
  /** True when the model declares the {@link IDLE_MOTION_GROUP} group. */
  readonly hasIdleLoop: boolean;
  /** Every curve parameter across all groups, deduplicated, insertion-ordered. */
  readonly parameterIds: readonly string[];
  private readonly motions: Record<string, IkiMotionClip[]>;
  private readonly params: Map<string, IkiParameter>;

  private readonly idleClips: readonly IkiMotionClip[];
  private readonly idleLength: number;
  private idleIndex = 0;
  /** Seconds into the current Idle clip. */
  private idleTime = 0;

  private slot: Slot | undefined = undefined;

  constructor(
    motions: Record<string, IkiMotionClip[]> | undefined,
    parameters: IkiParameter[],
  ) {
    this.motions = motions ?? {};
    this.params = new Map(parameters.map((p) => [p.id, p]));
    // Own-property checks throughout: a group named after an Object.prototype
    // member ("toString") is not declared.
    this.hasIdleLoop = Object.hasOwn(this.motions, IDLE_MOTION_GROUP);
    this.idleClips = this.hasIdleLoop ? this.motions[IDLE_MOTION_GROUP] : [];
    this.idleLength = this.idleClips.reduce((sum, c) => sum + c.duration, 0);
    this.parameterIds = [
      ...new Set(
        Object.values(this.motions).flatMap((clips) =>
          clips.flatMap((c) => c.curves.map((curve) => curve.parameter)),
        ),
      ),
    ];
  }

  /**
   * Start clip `index` of `group` at once, replacing any running one-shot.
   * Returns false, and changes nothing, for a group the model does not declare
   * or an index that is not an integer in range. Any group plays one-shot,
   * Idle included.
   */
  play(group: string, index: number): boolean {
    if (!Object.hasOwn(this.motions, group)) return false;
    const clips = this.motions[group];
    if (!Number.isInteger(index) || index < 0 || index >= clips.length) {
      return false;
    }
    // The new clip fades in from what the old one last put on screen. Until
    // the new one's first apply the screen still shows `from`, so that is its
    // last output too: a second play before the next apply inherits the same
    // pose instead of dropping the ids the first one never got to write.
    const from = this.slot?.last ?? new Map<string, number>();
    this.slot = { clip: clips[index], t: 0, from, last: from };
    return true;
  }

  /**
   * Advance `dtS` seconds and write into `frame`: the Idle loop layer, then
   * the one-shot slot over it.
   *
   * `frame` holds what earlier stages wrote this update. An id's base is its
   * frame value, else `rest(id)` — the parameter's resting value,
   * `clamp(default, min, max)`. The base is never the store's current value,
   * so a clip cannot accumulate across frames.
   */
  apply(
    dtS: number,
    frame: Map<string, number>,
    rest: (id: string) => number,
  ): void {
    if (this.hasIdleLoop) this.applyIdle(dtS, frame);
    if (this.slot) this.applySlot(this.slot, dtS, frame, rest);
  }

  /**
   * The Idle clips play as one continuous loop, so their fades are ignored:
   * fading each clip at its seams would dip the pose toward rest on every
   * clip boundary.
   */
  private applyIdle(dtS: number, frame: Map<string, number>): void {
    const clips = this.idleClips;
    let clip = clips[this.idleIndex];
    this.idleTime += dtS;
    if (this.idleTime >= clip.duration) {
      // A frame can cross many clips shorter than a frame. Whole passes of the
      // group land back at this same clip, so dropping them first leaves at
      // most one pass to walk, whatever dt is. The cap on the walk guards
      // float rounding: summing the durations one by one need not match the
      // precomputed total exactly.
      this.idleTime %= this.idleLength;
      for (
        let step = 0;
        step < clips.length && this.idleTime >= clip.duration;
        step++
      ) {
        this.idleTime -= clip.duration;
        this.idleIndex = (this.idleIndex + 1) % clips.length;
        clip = clips[this.idleIndex];
      }
    }
    for (const curve of clip.curves) {
      frame.set(curve.parameter, sampleCurve(curve.keys, this.idleTime));
    }
  }

  private applySlot(
    slot: Slot,
    dtS: number,
    frame: Map<string, number>,
    rest: (id: string) => number,
  ): void {
    const { clip, from } = slot;
    // What earlier stages (and the Idle layer) wrote this update, else rest.
    const base = (id: string): number => frame.get(id) ?? rest(id);
    slot.t += dtS;

    if (slot.t >= clip.duration) {
      // One last write at base for every id the slot drove, then the slot is
      // gone: a parameter nothing else writes settles at its default instead
      // of holding the clip's final value.
      const ids = new Set(clip.curves.map((curve) => curve.parameter));
      for (const id of from.keys()) ids.add(id);
      for (const id of ids) frame.set(id, base(id));
      this.slot = undefined;
      return;
    }

    // Fade-in moves from the old pose to the new sample; fade-out pulls the
    // result to base. With an empty `from` this is lerp(base, s, wIn * wOut).
    const { wIn, wOut } = fadeWeights(clip, slot.t);
    const last = new Map<string, number>();
    const write = (id: string, sample: number | undefined): void => {
      const b = base(id);
      const f = from.get(id) ?? b;
      const value = lerp(b, lerp(f, sample ?? b, wIn), wOut);
      frame.set(id, value);
      last.set(id, this.displayed(id, value));
    };
    for (const curve of clip.curves) {
      write(curve.parameter, sampleCurve(curve.keys, slot.t));
    }
    for (const id of from.keys()) if (!last.has(id)) write(id, undefined);
    slot.last = last;

    // From here on every value equals the no-`from` value, to rounding, and an
    // id only `from` held was just written at base, to rounding: drop them so
    // they are not written again.
    if (wIn >= 1) from.clear();
  }

  /**
   * The clip stage's output for an id, clamped to the parameter's range as
   * the store clamps every write. A replacing clip fades in from this, not
   * the raw value — a curve past the max would otherwise sit still on screen
   * until the fade got back inside the range.
   */
  private displayed(id: string, value: number): number {
    const param = this.params.get(id);
    return param ? clamp(value, param.min, param.max) : value;
  }
}
