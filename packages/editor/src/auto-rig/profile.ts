/**
 * The Live2D default-rig profile the auto-rig reproduces: how far each region
 * of a head moves at the extremes of each head parameter, measured on the
 * Cubism sample models (Haru, Hiyori, Mao, Natori — medians; see
 * `packages/editor/AUTO-RIG.md` for the method). Lengths are in the
 * profile's head unit `hh` (≈ eye row to chin, see `HH_PER_EYE_TO_CHIN`);
 * every curve is linear in its parameter, so one keyform per extreme carries
 * it exactly.
 *
 * The turn is read through parallax, not a reshaped face: the face plate
 * TRANSLATES (its width changes by 1–4 %), the features in front of it lead
 * it, the hair over it rides with it, the back hair behind it and the neck
 * under it stay where they are.
 */

/** hh per (eye row → chin tip) at rest. The profile's own factor is 1.0446
 *  with the eye row at the iris centroid; the rig reads the eye row off the
 *  iris crops' centres, which sit a few pixels higher on a drawn iris, and
 *  this factor puts the hero at the profile's own 264.5 render px. */
export const HH_PER_EYE_TO_CHIN = 1.017;

/** AngleX ±30, hh along the turn ("far" = the side the face turns toward). */
export const TURN = {
  /** The face plate's translation (its cheek edges, 0.118 / 0.126). */
  face: 0.118,
  /** The chin tip's lead over the plate (it moves 0.194). */
  chinLead: 0.076,
  /** The plate's width at full turn: eye and cheek rows, then the jaw. */
  widthUpper: 0.985,
  widthJaw: 0.96,
  eyeFar: 0.192,
  eyeNear: 0.23,
  /** Each eye's width at full turn, about its own centre. */
  eyeFarScale: 0.85,
  eyeNearScale: 1.085,
  browFar: 0.213,
  browNear: 0.243,
  nose: 0.301,
  mouth: 0.213,
  mouthWidth: 0.975,
  /** The mouth's far corner rises (its near end drops) by this much. */
  mouthTiltDeg: 4.4,
  /** The front hair (bangs and side locks) rides the face at this share of
   *  its translation (bangs 1.18×, side locks at the eye row ≈ 1.0×). */
  hairFollow: 1.1,
  /** The head's outline at the eye row holds (−0.014 / −0.004 hh): where the
   *  front hair draws it, its outer edge follows the face this much on a row
   *  where no back hair paints behind that edge. Where back hair does, the
   *  edge rides further, as far as that back hair stays behind it through
   *  the turn and the nod, up to the face's follow there (`hairFollow`;
   *  over the far eye's rows, as far as that eye's outer corner goes). On
   *  the cap (the rows above the eyes) it follows less where the turn would
   *  otherwise carry it further outside its back hair than the nod alone
   *  does. */
  outlineFollow: 0,
  /** The back hair's slight counter-motion. */
  hairBack: -0.027,
  /** The ears lag the plate: the far one's outer edge moves this share of
   *  its slide, the near one this at its widest reach, its root riding the
   *  head (the samples' parallax ratios, 0.44 and 0.87). */
  earFar: 0.44,
  earNear: 0.87,
  /** The far ear's width at full turn, about its outer edge (the samples'
   *  median: Haru 0.81 / 0.91, Hiyori 0.90 / 0.85, Mao 0.77 / 0.79; none
   *  fades). */
  earFarScale: 0.83,
} as const;

/** AngleY: screen displacement, hh, + = DOWN (as measured), at +30 (looking
 *  up) and −30 (looking down). */
export const NOD = {
  faceTop: { up: -0.081, down: 0.178 },
  chin: { up: -0.0875, down: 0.109 },
  eye: { up: -0.167, down: 0.202 },
  /** Eye height at the extreme, about the eye's centre. */
  eyeHeight: { up: 0.994, down: 0.96 },
  brow: { up: -0.167, down: 0.223 },
  nose: { up: -0.207, down: 0.193 },
  mouth: { up: -0.172, down: 0.177 },
  hairFront: { up: -0.11, down: 0.189 },
  /** The front hair's cap top. The samples' cap top moves 1.215× their face's
   *  centroid looking down (Mao 1.236, Haru 1.626, Hiyori 1.194, Natori
   *  0.730) and 0.415× looking up (0.385, 0.430, 0.400, 0.487); each ratio
   *  times the plate's own nod halfway between its top and the chin (0.1435
   *  down, 0.084 up). Looking down, the rig slides it only as far as the
   *  back hair covers the crown behind it. */
  hairFrontTop: { up: -0.035, down: 0.174 },
  hairBack: { up: -0.011, down: 0.025 },
} as const;

/** AngleZ ±30 rolls the head this many degrees (the eye line turns 9.9°),
 *  about the chin — the top of the neck. */
export const ROLL_DEG = 10;

/** Everything else, at each parameter's extreme. */
export const AMPLITUDE = {
  /** Iris travel, in iris widths (X 0.045 hh, Y 0.031 hh on the samples). */
  gazeX: 0.17,
  gazeY: 0.11,
  /** How far the upper lid comes down, over the eye's height (Haru 0.30,
   *  Mao 0.58, Hiyori 0.67). */
  blink: 0.58,
  /** A single mouth drawing opens to this height over its rest width. */
  mouthOpenHeight: 0.77,
  /** The mouth widens this much open. */
  mouthOpenWidth: 1.15,
  /** Brow raise / lower, hh. */
  brow: 0.089,
  /** Breath lifts the shoulders and the head, hh. */
  breathBody: 0.025,
  breathHead: 0.016,
  /** Hair tip travel at full sway (±20), hh (the keyform ranges at ±1 have a
   *  median of 0.05–0.06 hh). */
  sway: 0.06,
  /** The neck under the face reaches this far above the jaw, hh — what the
   *  chin uncovers as it slides off it. */
  hiddenNeck: 0.3,
} as const;

/**
 * Per-character tuning, starting from the profile: only the quantities the
 * Live2D samples themselves disagree on by more than their own median
 * (style, not construction). `turn`, `featureLead` and `sway` multiply the
 * profile (1 = as measured); `hairFollow`, `outlineFollow` and `blink`
 * replace its value.
 */
export interface RigStyle {
  /** The whole turn — plate, features and hair (the samples' face slides
   *  0.05–0.25 hh). Ignored when a `turnTargets.eyeShift` is given, which
   *  fits it instead. */
  turn?: number;
  /** How far the features lead the plate (the nose leads it 2.2–4.4×). */
  featureLead?: number;
  /** The front hair's share of the face's turn (the samples' 1.0–1.37;
   *  profile 1.1). */
  hairFollow?: number;
  /** Its outer edge's share, where the front hair draws the head's outline
   *  and no back hair paints behind that edge (profile 0: the outline holds;
   *  `hairFollow` rides it whole). Where back hair does, the edge rides
   *  further, as far as that back hair stays behind it through the turn and
   *  the nod, up to the front hair's follow there (`hairFollow`; over the
   *  far eye's rows, as far as that eye's outer corner goes). On the cap
   *  (the rows above the eyes) the edge follows less where the turn would
   *  otherwise carry it further outside its back hair than the nod alone
   *  does. */
  outlineFollow?: number;
  /** How far the upper lid comes down, over the eye's height (0.30–0.67). */
  blink?: number;
  /** Hair sway amplitude (0.02–0.36 hh at the extremes). */
  sway?: number;
}

/** Every knob `RigStyle` has: a caller's style names only these. */
export const STYLE_KNOBS: readonly (keyof RigStyle)[] = [
  "turn",
  "featureLead",
  "hairFollow",
  "outlineFollow",
  "blink",
  "sway",
];

export interface ResolvedStyle {
  turn: number;
  featureLead: number;
  hairFollow: number;
  outlineFollow: number;
  blink: number;
  sway: number;
}

/** Style knobs resolved against the profile; `check` names a bad one. */
export function resolveStyle(
  style: RigStyle | undefined,
  check: (key: string, v: unknown, lo: number, hi: number) => number,
): ResolvedStyle {
  const s = style ?? {};
  const get = (key: keyof RigStyle, def: number, lo: number, hi: number) =>
    s[key] === undefined ? def : check(`style.${key}`, s[key], lo, hi);
  return {
    turn: get("turn", 1, 0, 3),
    featureLead: get("featureLead", 1, 0, 3),
    hairFollow: get("hairFollow", TURN.hairFollow, 0, 2),
    outlineFollow: get("outlineFollow", TURN.outlineFollow, 0, 2),
    blink: get("blink", AMPLITUDE.blink, 0.1, 1),
    sway: get("sway", 1, 0, 5),
  };
}
