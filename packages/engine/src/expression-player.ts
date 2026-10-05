import {
  DEFAULT_FADE_SECONDS,
  type IkiExpression,
  type IkiExpressionParameter,
  type IkiParameter,
} from "@ikijs/format";
import { clamp, lerp, smoothstep } from "./math";

/**
 * A parameter's value as a line in its base: `scale · base + offset`. Every
 * blend is one (add c is 1·base + c, multiply c is c·base, overwrite c is
 * 0·base + c) and so is leaving a parameter alone (1·base); a lerp between two
 * lines is a line too. So whatever mix of expressions is on screen, however
 * many were cut off mid-fade, is one line per parameter, and it still follows
 * the live base: a multiply on EyeOpen keeps the blink.
 */
interface Line {
  scale: number;
  offset: number;
}

/** The line of a parameter an expression leaves alone: the base itself. */
const BASE: Line = { scale: 1, offset: 0 };

function lineOf({ value, blend = "add" }: IkiExpressionParameter): Line {
  switch (blend) {
    case "add":
      return { scale: 1, offset: value };
    case "multiply":
      return { scale: value, offset: 0 };
    case "overwrite":
      return { scale: 0, offset: value };
  }
}

/** The line's value over `base`. */
function at({ scale, offset }: Line, base: number): number {
  return scale * base + offset;
}

/**
 * {@link lerp}, but exactly `b` at `t = 1` (lerp is exact only at 0): a
 * finished fade lands on its target, and an id it lets go of on base itself.
 */
function mix(a: number, b: number, t: number): number {
  return t === 1 ? b : lerp(a, b, t);
}

/** What the player can fade to: an expression, or the base itself. */
interface Pose {
  /** Undefined for {@link RELEASE}. */
  expression: IkiExpression | undefined;
  /** The parameters it drives, by id. */
  lines: ReadonlyMap<string, Line>;
}

/** The pose a stop fades to: it drives nothing, so every id goes to base. */
const RELEASE: Pose = { expression: undefined, lines: new Map() };

/**
 * The fade in progress: toward `pose`, from the pose on screen when it began.
 */
interface Fade {
  pose: Pose;
  /** How long it lasts, in seconds. */
  seconds: number;
  /** Seconds since it began. */
  elapsed: number;
}

/**
 * The fade's weight, eased along {@link smoothstep} from 0 to 1 over its
 * seconds; at or past its end exactly 1. A zero fade is at 1 the moment it
 * begins, with no division by zero: an expression with a zero `fadeIn` is
 * fully on as soon as it is played, so a stop before the next apply fades it
 * out from full.
 */
function weight({ seconds, elapsed }: Fade): number {
  return elapsed >= seconds ? 1 : smoothstep(elapsed / seconds);
}

/** An id the player writes on every apply. */
interface Held {
  id: string;
  /**
   * Its last write minus the unclamped mix of the same ends at the same
   * weight: 0 unless an end was past the parameter's range. A fold adds it
   * back (see {@link ExpressionPlayer.begin}).
   */
  shift: number;
}

/**
 * Plays a model's expressions into a per-update frame map. Internal to
 * {@link IkiMotion}, which owns the frame: the base rule below only holds
 * inside that frame, so this is not exported from the package entry.
 *
 * One fade runs at a time, from the pose on screen when it began to its
 * target. {@link play} fades an expression in over its `fadeIn`; {@link stop}
 * fades back to base over the playing expression's `fadeOut`. Either one
 * interrupting a fade starts from where that fade got to, as a replacing
 * motion clip does, so the screen never jumps or dips toward base; unlike a
 * clip's, that starting pose keeps following the live base (see {@link Line}).
 * Each target is taken over the base, never over what is on screen, so an
 * `add` never stacks on itself however often it is replayed.
 *
 * IkiMotion steps it once per update; this class has no timers, rAF, DOM, or
 * Date.now.
 */
export class ExpressionPlayer {
  /** Every expression parameter, deduplicated, insertion-ordered. */
  readonly parameterIds: readonly string[];
  private readonly poses: Map<string, Pose & { expression: IkiExpression }>;
  private readonly params: Map<string, IkiParameter>;

  /** Undefined while nothing is held. */
  private fade: Fade | undefined = undefined;
  /**
   * The pose on screen when {@link fade} began, a line per id; empty once the
   * fade has finished, since the screen is then its target alone.
   */
  private from = new Map<string, Line>();
  /** Every id `from` or the fade drives: what each apply writes. */
  private held: Held[] = [];

  constructor(
    expressions: IkiExpression[] | undefined,
    parameters: IkiParameter[],
  ) {
    const list = expressions ?? [];
    this.params = new Map(parameters.map((p) => [p.id, p]));
    this.poses = new Map(
      list.map((expression) => [
        expression.id,
        {
          expression,
          lines: new Map(
            expression.parameters.map((p) => [p.parameter, lineOf(p)]),
          ),
        },
      ]),
    );
    this.parameterIds = [
      ...new Set(list.flatMap((e) => e.parameters.map((p) => p.parameter))),
    ];
  }

  /**
   * Fade expression `id` in over its `fadeIn`, from what is on screen: the
   * base, or the output of the expression it replaces, or of a stop still
   * fading out. Returns false, and changes nothing, for an expression id the
   * model does not declare; playing the expression already fading in or held
   * changes nothing and returns true.
   */
  play(id: string): boolean {
    const pose = this.poses.get(id);
    if (!pose) return false;
    if (this.fade?.pose === pose) return true;
    this.begin(pose, pose.expression.fadeIn ?? DEFAULT_FADE_SECONDS);
    return true;
  }

  /**
   * Fade back to base over the playing expression's `fadeOut`, from what is
   * on screen. Does nothing when nothing is playing or a stop is already
   * fading out.
   */
  stop(): void {
    const playing = this.fade?.pose.expression;
    if (!playing) return;
    this.begin(RELEASE, playing.fadeOut ?? DEFAULT_FADE_SECONDS);
  }

  /**
   * Freeze what is on screen into {@link from}, at the weight the current
   * fade has reached, and start a fade from it toward `pose`. Folding keeps
   * this to one `from` and one fade however fast the plays come.
   *
   * The lines mix unclamped, but {@link apply} clamps each end before it
   * mixes, so the two part where an end was past the parameter's range.
   * Adding each id's {@link Held.shift} to the folded offset closes that
   * gap at the base of the last apply: the new fade starts on what was shown
   * there, and the folded scale still follows the live base from it.
   */
  private begin(pose: Pose, seconds: number): void {
    if (this.fade) {
      const { lines } = this.fade.pose;
      const w = weight(this.fade);
      const from = new Map<string, Line>();
      for (const { id, shift } of this.held) {
        const a = this.from.get(id) ?? BASE;
        const b = lines.get(id) ?? BASE;
        from.set(id, {
          scale: mix(a.scale, b.scale, w),
          offset: mix(a.offset, b.offset, w) + shift,
        });
      }
      this.from = from;
    }
    this.fade = { pose, seconds, elapsed: 0 };
    this.held = [...new Set([...this.from.keys(), ...pose.lines.keys()])].map(
      (id) => ({ id, shift: 0 }),
    );
  }

  /**
   * Advance `dtS` seconds and write every held id into `frame`: the pose on
   * screen when the fade began, lerped toward the fade's target by its
   * weight, each end clamped to the parameter's range. An id the target does
   * not drive goes to base.
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
    // IkiMotion calls this every frame for every model; most hold nothing.
    const fade = this.fade;
    if (!fade) return;
    fade.elapsed += dtS;
    const w = weight(fade);
    const { lines } = fade.pose;
    for (const held of this.held) {
      const { id } = held;
      const base = frame.get(id) ?? rest(id);
      const start = at(this.from.get(id) ?? BASE, base);
      const end = at(lines.get(id) ?? BASE, base);
      const shown = mix(this.displayed(id, start), this.displayed(id, end), w);
      frame.set(id, shown);
      held.shift = shown - mix(start, end, w);
    }
    if (w < 1) return;
    // The fade is done and the screen is its target alone. An id only `from`
    // drove was just written at base, exactly; dropping it now makes that its
    // last write, so a parameter nothing else writes rests at its default
    // instead of being held. A finished stop drives nothing, so it goes too.
    if (!fade.pose.expression) {
      this.fade = undefined;
      this.from.clear();
      this.held = [];
    } else if (this.from.size > 0) {
      this.from.clear();
      // Kept entries carry their shift into the next fold.
      this.held = this.held.filter(({ id }) => lines.has(id));
    }
  }

  /**
   * A value as the screen shows it: clamped to the parameter's range, as the
   * store clamps every write; an id the model does not declare as is. A fade
   * mixes these, so it leaves a value held past the max from the max at once
   * instead of sitting there until the mix gets back inside the range.
   */
  private displayed(id: string, value: number): number {
    const param = this.params.get(id);
    return param ? clamp(value, param.min, param.max) : value;
  }
}
