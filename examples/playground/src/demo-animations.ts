import {
  StandardParameter as P,
  type IkiExpression,
  type IkiExpressionParameter,
  type IkiMotionClip,
} from "@ikijs/format";

// A stand-in set of expressions and motion clips for the built-in hero, which
// declares none: the playground spreads it onto hero.iki at load (fetchHero in
// main.ts) so the play buttons have something to show. It is not in hero.iki.
// Every entry drives only parameters hero.iki declares; the vector sample lacks
// the brows and AngleZ, so this is for the hero alone. Every magnitude was
// picked by eye on the hero, so tune them here. No entry sets a fade, so each
// plays with the format's DEFAULT_FADE_SECONDS, and its curves are smooth.

/** Both brows up (+) or down (−), in BrowY units (hero: ±27 px at ±1). */
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

const expressions: IkiExpression[] = [
  {
    id: "smile",
    description: "A warm, closed-mouth smile with the brows lifted a little.",
    parameters: [
      { parameter: P.MouthForm, value: 0.8, blend: "add" },
      ...browsY(0.2),
    ],
  },
  {
    id: "laugh",
    description: "A big laugh: eyes squeezed shut, mouth open in a wide smile.",
    parameters: [
      { parameter: P.EyeOpenLeft, value: 0, blend: "multiply" },
      { parameter: P.EyeOpenRight, value: 0, blend: "multiply" },
      { parameter: P.MouthForm, value: 1, blend: "add" },
      { parameter: P.MouthOpen, value: 0.6, blend: "overwrite" },
    ],
  },
  {
    id: "angry",
    description: "Angry: brows lowered and drawn down at the middle, a frown.",
    parameters: [
      ...browsY(-0.4),
      ...browsTilt(0.6),
      { parameter: P.MouthForm, value: -0.7, blend: "add" },
    ],
  },
  {
    id: "sad",
    description: "Sad: brows raised at the middle, the mouth turned down.",
    parameters: [
      ...browsY(0.25),
      ...browsTilt(-0.6),
      { parameter: P.MouthForm, value: -0.6, blend: "add" },
    ],
  },
  {
    id: "surprised",
    description: "Surprised: brows shot up, mouth dropped open.",
    parameters: [
      ...browsY(0.6),
      { parameter: P.MouthOpen, value: 0.7, blend: "overwrite" },
    ],
  },
];

// Head-angle clips. AngleY −30 looks down and +30 up (the auto-rig's
// profile), so a nod dips negative; AngleZ + tilts the top of the head toward
// the viewer's right. No Idle group: the playground's idle stays procedural.
const motions: Record<string, IkiMotionClip[]> = {
  Nod: [
    {
      description:
        "One nod yes: the head dips, comes back up past level, settles.",
      duration: 1,
      curves: [
        {
          parameter: P.AngleY,
          keys: [
            [0, 0],
            [0.3, -14],
            [0.6, 3],
            [0.8, -1],
            [1, 0],
          ],
        },
      ],
    },
  ],
  Shake: [
    {
      description: "A head shake no: side to side twice, dying away.",
      duration: 1.2,
      curves: [
        {
          parameter: P.AngleX,
          keys: [
            [0, 0],
            [0.2, -14],
            [0.45, 14],
            [0.7, -12],
            [0.95, 8],
            [1.2, 0],
          ],
        },
      ],
    },
  ],
  Tilt: [
    {
      description:
        "A curious head tilt: the head leans over, holds, comes back.",
      duration: 1.4,
      curves: [
        {
          parameter: P.AngleZ,
          keys: [
            [0, 0],
            [0.35, 15],
            [1, 15],
            [1.4, 0],
          ],
        },
      ],
    },
  ],
};

export const heroDemoAnimations = { expressions, motions };
