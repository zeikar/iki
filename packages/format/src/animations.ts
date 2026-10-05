// Expression and motion-clip types of the `.iki` format: named parameter poses and
// grouped keyframed clips a host plays. Referenced by `IkiModel` in types.ts.

/**
 * The motion group that loops. Its clips replace the procedural head sway and
 * gaze; blink and breath stay procedural, so its curves may not animate
 * `EyeOpenLeft`, `EyeOpenRight` or `Breath`. Every other group plays one-shot.
 */
export const IDLE_MOTION_GROUP = "Idle";

/**
 * Seconds an absent `fadeIn` or `fadeOut` stands for: on an
 * {@link IkiExpression} as is, on an {@link IkiMotionClip} capped at the clip's
 * `duration`. An explicit `0` is instant. A player reads absence through this
 * one constant, so every host fades a model the same way.
 */
export const DEFAULT_FADE_SECONDS = 0.4;

/**
 * How an {@link IkiExpressionParameter} combines with the frame's base value.
 * `"add"` adds `value`, `"multiply"` multiplies by it, `"overwrite"` replaces
 * the base with it.
 */
export type IkiExpressionBlend = "add" | "multiply" | "overwrite";

/** One parameter an {@link IkiExpression} drives. */
export interface IkiExpressionParameter {
  /** A declared parameter id; at most once per expression. */
  parameter: string;
  /** Finite. */
  value: number;
  /**
   * Absent means `"add"`. Applies to the frame's base value; the fade weight `w`
   * moves the result from where the fade started (the base, or the replaced
   * expression's output) to `blended`. `ParamMouthOpenY` is allowed; frame
   * order decides it, so a host's later write (lip-sync) wins.
   */
  blend?: IkiExpressionBlend;
}

/** A named, held parameter pose (e.g. a smile) that a host plays by `id`. */
export interface IkiExpression {
  /** Non-empty; unique across the model's expressions. */
  id: string;
  /** Contains a non-whitespace character. The semantic layer a host's picker
   *  (e.g. an LLM) chooses by. */
  description: string;
  /** Seconds, finite and `>= 0`; `0` is instant. Absent means
   *  {@link DEFAULT_FADE_SECONDS}. Starts from the current pose: the base, or
   *  the replaced expression's current output when this play replaces one. */
  fadeIn?: number;
  /** Seconds, finite and `>= 0`; `0` is instant. Absent means
   *  {@link DEFAULT_FADE_SECONDS}. Applies only when the expression is
   *  stopped, back to the base; an expression replacing it fades in over its
   *  own `fadeIn` instead. */
  fadeOut?: number;
  /** Non-empty. */
  parameters: IkiExpressionParameter[];
}

/**
 * How an {@link IkiMotionCurve} moves between its keys. `"linear"` is a straight
 * line from key to key. `"smooth"` is a monotone cubic through the keys: it
 * never overshoots (each segment stays between its two keys' values), and its
 * slope is zero at a local peak or dip and at the first and last key, so it
 * eases out of and into the holds either side.
 */
export type IkiMotionInterpolation = "linear" | "smooth";

/**
 * One animated parameter of an {@link IkiMotionClip}. Before the first key the
 * value holds at the first key's value; after the last key it holds at the
 * last key's value.
 */
export interface IkiMotionCurve {
  /** A declared parameter id; at most once per clip. */
  parameter: string;
  /** Non-empty `[t, value]` pairs. `t` is seconds, strictly increasing and
   *  inside `[0, duration]`. */
  keys: [number, number][];
  /** Absent means `"smooth"`. */
  interpolation?: IkiMotionInterpolation;
}

/** One clip in a motion group; a host addresses it as (group, index). */
export interface IkiMotionClip {
  /** Contains a non-whitespace character. The semantic layer a host's picker
   *  (e.g. an LLM) chooses by. */
  description: string;
  /** Seconds, `> 0`. */
  duration: number;
  /** Seconds, `>= 0` and `<= duration`; `0` is instant. Absent means
   *  {@link DEFAULT_FADE_SECONDS}, capped at `duration`. Starts from the
   *  current pose: the base, or the replaced clip's last output when this
   *  play replaces a running clip. */
  fadeIn?: number;
  /** Seconds, `>= 0` and `<= duration`; `0` is instant. Absent means
   *  {@link DEFAULT_FADE_SECONDS}, capped at `duration`. May overlap `fadeIn`
   *  (`fadeIn + fadeOut > duration` is valid); the clip then peaks below full
   *  weight. */
  fadeOut?: number;
  /** Non-empty. */
  curves: IkiMotionCurve[];
}
