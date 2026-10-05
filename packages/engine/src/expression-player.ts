import type { IkiExpression, IkiExpressionBlend } from "@ikijs/format";
import { lerp } from "./math";

/** One expression's place in the player and the fade it is in. */
interface Entry {
  expression: IkiExpression;
  /** The weight when the current fade began. */
  from: number;
  /** Where the current fade heads: 1 while active, 0 once released. */
  target: number;
  /** Seconds since the current fade began. */
  elapsed: number;
}

/**
 * The entry's weight: linear from `from` to `target` over the fade's declared
 * seconds, so a fade takes its full time however far the previous one got.
 * Fading in (active) takes `fadeIn`, fading out (released) takes `fadeOut`;
 * a zero fade is at its target at once.
 */
function weight(entry: Entry): number {
  const { expression, from, target, elapsed } = entry;
  const fade = (target === 1 ? expression.fadeIn : expression.fadeOut) ?? 0;
  // At or past the fade's end (always, for a zero fade) the weight is the
  // target itself: no division by a zero fade, no overshoot, and a release
  // lands on exactly 0, where it is pruned.
  if (elapsed >= fade) return target;
  return lerp(from, target, elapsed / fade);
}

/** Restart the entry's fade toward `target` from the weight it has now. */
function fadeToward(entry: Entry, target: number): void {
  entry.from = weight(entry);
  entry.target = target;
  entry.elapsed = 0;
}

/** The parameter's value with the expression fully applied over `base`. */
function blended(
  base: number,
  value: number,
  blend: IkiExpressionBlend = "add",
): number {
  switch (blend) {
    case "add":
      return base + value;
    case "multiply":
      return base * value;
    case "overwrite":
      return value;
  }
}

/**
 * Plays a model's expressions into a per-update frame map. Internal to
 * {@link IkiMotion}, which owns the frame: the base rule below only holds
 * inside that frame, so this is not exported from the package entry.
 *
 * One expression is active at a time. {@link play} makes one active and
 * releases the one before it; {@link stop} releases the active one. A released
 * expression fades out alongside the new one and is dropped once its weight
 * reaches 0. Each expression is held at most once: playing one that is still
 * fading out brings that same entry back, so an `add` never stacks on itself.
 *
 * IkiMotion steps it once per update; this class has no timers, rAF, DOM, or
 * Date.now.
 */
export class ExpressionPlayer {
  /** Every expression parameter, deduplicated, insertion-ordered. */
  readonly parameterIds: readonly string[];
  private readonly expressions: Map<string, IkiExpression>;

  private active: Entry | undefined = undefined;
  /** Released entries, oldest first: the order they compose in. */
  private released: Entry[] = [];

  constructor(expressions: IkiExpression[] | undefined) {
    const list = expressions ?? [];
    this.expressions = new Map(list.map((e) => [e.id, e]));
    this.parameterIds = [
      ...new Set(list.flatMap((e) => e.parameters.map((p) => p.parameter))),
    ];
  }

  /**
   * Make expression `id` active, fading it in and releasing the one active
   * before it. Returns false, and changes nothing, for an expression id the
   * model does not declare; playing the active expression again changes
   * nothing and returns true.
   */
  play(id: string): boolean {
    const expression = this.expressions.get(id);
    if (!expression) return false;
    if (this.active?.expression === expression) return true;

    // An expression still fading out comes back from the weight it has rather
    // than as a second copy from 0, which would stack on the first.
    const i = this.released.findIndex((e) => e.expression === expression);
    let entry: Entry;
    if (i >= 0) {
      [entry] = this.released.splice(i, 1);
      fadeToward(entry, 1);
    } else {
      entry = { expression, from: 0, target: 1, elapsed: 0 };
    }
    this.stop();
    this.active = entry;
    return true;
  }

  /** Release the active expression, if any, fading it out. */
  stop(): void {
    if (!this.active) return;
    fadeToward(this.active, 0);
    this.released.push(this.active);
    this.active = undefined;
  }

  /**
   * Advance `dtS` seconds and write every held expression into `frame`:
   * released ones oldest first, then the active one, each over what the ones
   * before it wrote.
   *
   * `frame` holds what earlier stages wrote this update. A parameter id's base
   * is its frame value, else `rest(id)` — the parameter's resting value,
   * `clamp(default, min, max)`. The base is never the store's current value,
   * so an `add` cannot accumulate across frames.
   */
  apply(
    dtS: number,
    frame: Map<string, number>,
    rest: (id: string) => number,
  ): void {
    const entries = this.active
      ? [...this.released, this.active]
      : this.released;
    // What earlier stages wrote this update, else rest. Each entry writes back
    // into the frame, so the next entry's base is this one's result and the
    // entries chain in order.
    const base = (id: string): number => frame.get(id) ?? rest(id);
    for (const entry of entries) entry.elapsed += dtS;
    for (const entry of entries) {
      const w = weight(entry);
      for (const { parameter, value, blend } of entry.expression.parameters) {
        const b = base(parameter);
        frame.set(parameter, lerp(b, blended(b, value, blend), w));
      }
    }
    // A release that reached 0 has just written its parameters at base (a
    // lerp by 0 is exact). Dropping it now makes that its last write, so a
    // parameter nothing else writes rests at its default instead of being
    // held.
    this.released = this.released.filter((e) => weight(e) > 0);
  }
}
