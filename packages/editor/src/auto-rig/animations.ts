/**
 * The expressions and motions an auto-rigged model declares, each with a
 * description a host (an LLM, say) picks it by.
 *
 * The expressions' and head motions' values are our own, picked by eye on Bob
 * and the long-haired character (2026-10) from soft, medium and strong
 * candidates; the Wave's were picked by eye on street. A term's
 * blend follows its parameter: EyeOpen multiplies, so the procedural blink
 * keeps running under it (at 0 the eyes stay shut); MouthOpenY overwrites,
 * and a host's lip-sync, written after the expression, wins; everything else
 * adds onto a parameter that rests at 0, clamped to its range. Among the
 * head motions only Shake sets a fade; they and the expressions play with the
 * format's `DEFAULT_FADE_SECONDS`, capped at half a clip, and none of their
 * curves sets an interpolation, so each is smooth. The Wave sets its fades to
 * its switch's ramp and keys that switch linear.
 */

import {
  StandardParameter as P,
  type IkiExpression,
  type IkiExpressionParameter,
  type IkiMotionClip,
} from "@ikijs/format";

/** Both brows up (+) or down (−), in BrowY units. */
function browsY(y: number): IkiExpressionParameter[] {
  return [
    { parameter: P.BrowLeftY, value: y, blend: "add" },
    { parameter: P.BrowRightY, value: y, blend: "add" },
  ];
}

/**
 * Both brows tilted as a mirror pair: + drops the inner ends (angry), − lifts
 * them (sad). Brow angles are raw per side and CCW-positive on screen, and the
 * character's left brow sits at +x, so its inner end is its screen-left end,
 * which a CCW turn drops; the right brow's inner end is its screen-right end,
 * which a CCW turn lifts. A mirror pair therefore takes opposite signs.
 */
function browsTilt(innerDown: number): IkiExpressionParameter[] {
  return [
    { parameter: P.BrowLeftAngle, value: innerDown, blend: "add" },
    { parameter: P.BrowRightAngle, value: -innerDown, blend: "add" },
  ];
}

function cheek(value: number): IkiExpressionParameter {
  return { parameter: P.Cheek, value, blend: "add" };
}

const BROWS = [P.BrowLeftY, P.BrowRightY, P.BrowLeftAngle, P.BrowRightAngle];

interface DefaultExpression extends IkiExpression {
  /** The parameters its look rests on: a model that declares none of them
   *  could not show what the description promises, so it goes without. */
  needs?: string[];
}

// A model declares the brows, the gaze and Cheek only with the layers they
// move, so `defaultExpressions` filters these terms, and leaves out an entry
// whose look rests on a missing part: shy on the blush, angry and sad on the
// brows. Every entry keeps a term on EyeOpen, MouthOpenY or MouthForm, which
// the rig always declares, so a kept one is never emptied (`parseIkiModel`
// would reject one that was).
const EXPRESSIONS: DefaultExpression[] = [
  {
    id: "smile",
    description:
      "Smiling and pleased: warm, friendly, content. For greetings, thanks, agreement and gentle happiness.",
    parameters: [
      { parameter: P.MouthForm, value: 1, blend: "add" },
      ...browsY(0.25),
      cheek(0.4),
    ],
  },
  {
    id: "laugh",
    description:
      "Laughing, eyes shut and mouth open: delighted, amused. For jokes, playfulness and big joy.",
    parameters: [
      { parameter: P.EyeOpenLeft, value: 0, blend: "multiply" },
      { parameter: P.EyeOpenRight, value: 0, blend: "multiply" },
      { parameter: P.MouthForm, value: 1, blend: "add" },
      { parameter: P.MouthOpen, value: 0.8, blend: "overwrite" },
      ...browsY(0.4),
      cheek(0.65),
    ],
  },
  {
    id: "angry",
    description:
      "Angry or annoyed, frowning. For irritation, frustration, indignation or scolding.",
    needs: BROWS,
    parameters: [
      ...browsY(-0.5),
      ...browsTilt(0.8),
      { parameter: P.MouthForm, value: -0.9, blend: "add" },
    ],
  },
  {
    id: "sad",
    description:
      "Sad or disappointed, downcast. For sorrow, regret, apology or sympathy.",
    needs: BROWS,
    parameters: [
      ...browsY(0.35),
      ...browsTilt(-0.8),
      { parameter: P.MouthForm, value: -0.8, blend: "add" },
    ],
  },
  {
    id: "surprised",
    description:
      "Surprised, mouth dropped open: startled, amazed. For shock, sudden news or disbelief.",
    parameters: [
      ...browsY(0.8),
      { parameter: P.MouthOpen, value: 0.9, blend: "overwrite" },
    ],
  },
  {
    id: "shy",
    description:
      "Shy or embarrassed: bashful, flustered. For being praised, teased or caught off guard.",
    needs: [P.Cheek],
    parameters: [
      cheek(1),
      // Gaze down.
      { parameter: P.EyeballY, value: -0.65, blend: "add" },
      { parameter: P.MouthForm, value: 0.4, blend: "add" },
      ...browsTilt(-0.25),
    ],
  },
];

/** The default expressions a model with the `declared` parameters can show,
 *  each keeping only its terms on them, in table order. */
export function defaultExpressions(
  declared: ReadonlySet<string>,
): IkiExpression[] {
  return EXPRESSIONS.filter(
    (e) => e.needs === undefined || e.needs.some((id) => declared.has(id)),
  ).map(({ needs: _needs, ...e }) => ({
    ...e,
    parameters: e.parameters.filter((t) => declared.has(t.parameter)),
  }));
}

/**
 * The head motions, one clip per group: a host plays (`Nod`, 0). AngleX,
 * AngleY and AngleZ are always declared, so these need no filter. AngleY −30
 * looks down and +30 up, so a nod dips negative; AngleZ + tilts the top of
 * the head toward the viewer's right. No `Idle` group, so the procedural idle
 * stays whole.
 */
const HEAD_MOTIONS: Record<string, IkiMotionClip[]> = {
  Nod: [
    {
      description: "Nods yes: agreement, acknowledgement, understanding.",
      duration: 1,
      curves: [
        {
          parameter: P.AngleY,
          keys: [
            [0, 0],
            [0.3, -18],
            [0.6, 4],
            [0.8, -1],
            [1, 0],
          ],
        },
      ],
    },
  ],
  Shake: [
    {
      description: "Shakes the head no: disagreement, refusal, disbelief.",
      duration: 1.2,
      // The first swing peaks at 0.2 s, which the default fade would still
      // be damping.
      fadeIn: 0.15,
      curves: [
        {
          parameter: P.AngleX,
          keys: [
            [0, 0],
            [0.2, -18],
            [0.45, 18],
            [0.7, -16],
            [0.95, 10],
            [1.2, 0],
          ],
        },
      ],
    },
  ],
  Tilt: [
    {
      description:
        "Tilts the head to one side and back: curiosity, puzzlement, a question.",
      duration: 1.4,
      curves: [
        {
          parameter: P.AngleZ,
          keys: [
            [0, 0],
            [0.35, 20],
            [1, 20],
            [1.4, 0],
          ],
        },
      ],
    },
  ],
};

/**
 * The Wave: the right hand raised, rocked three times, lowered. Declared only
 * with the pose forearm's three parameters, because the validator rejects a
 * curve on an undeclared parameter and a bust has none of them (`defaultMotions`).
 * The switch is `linear` and ramps over the clip's first and last 0.15 s; the
 * clip's `fadeIn` / `fadeOut` equal that ramp, because a clip's fade blends
 * every curve, the switch included, and the absent fade (0.4 s) would stretch
 * the crossfade. Every curve is keyed 0 at both ends, so the clip starts and
 * ends at rest. The values are our own, picked by eye on street.
 */
const WAVE: Record<string, IkiMotionClip[]> = {
  Wave: [
    {
      description:
        "Waves hello with the right hand: greeting, goodbye, getting attention.",
      duration: 2.2,
      fadeIn: 0.15,
      fadeOut: 0.15,
      curves: [
        {
          parameter: P.ArmPoseRight,
          interpolation: "linear",
          keys: [
            [0, 0],
            [0.15, 1],
            [2.05, 1],
            [2.2, 0],
          ],
        },
        {
          parameter: P.ArmRight,
          keys: [
            [0, 0],
            [0.4, 10],
            [1.8, 10],
            [2.2, 0],
          ],
        },
        {
          parameter: P.ArmPoseAngleRight,
          keys: [
            [0, 0],
            [0.5, 0],
            [0.7, 12],
            [1.0, -12],
            [1.3, 12],
            [1.7, 0],
            [2.2, 0],
          ],
        },
      ],
    },
  ],
};

/** The motions a model with the `declared` parameters can play: the head's
 *  always, and the Wave when the right arm, its pose switch and its pose
 *  angle are all declared. */
export function defaultMotions(
  declared: ReadonlySet<string>,
): Record<string, IkiMotionClip[]> {
  const waves = [P.ArmRight, P.ArmPoseRight, P.ArmPoseAngleRight].every((id) =>
    declared.has(id),
  );
  return waves ? { ...HEAD_MOTIONS, ...WAVE } : HEAD_MOTIONS;
}
