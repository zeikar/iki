/**
 * How far each region of a head moves at the extremes of each head
 * parameter. The rules are a 2D rig's usual ones. A turn is parallax, not a
 * reshaped face: the face plate translates, the features in front of it lead
 * it by their depth (the nose most), the chin leads it too, the front hair
 * rides the face, the back hair drifts a little the other way, and the torso,
 * which the head hangs from, follows it only a little (`body.ts`). A nod is
 * the same parallax vertically; a roll turns the head about the chin. Every
 * curve is linear in its parameter, so one keyform per extreme carries it
 * exactly.
 *
 * The magnitudes are our own values, `PROFILE_VALUES`, picked by eye on our
 * own characters (`packages/editor/AUTO-RIG.md`); what the rig reads —
 * `TURN`, `NOD`, `ROLL_DEG`, `AMPLITUDE` and `BODY` — is derived from them.
 * Lengths are in the head unit `hh`, the eye row → chin tip at rest.
 */

/** The values the profile is derived from, each at its parameter's extreme
 *  (±30 for the head angles). */
export interface ProfileValues {
  /** AngleX: the face plate translates this far, hh. */
  slide: number;
  /** AngleX: a feature on the face — an eye, a brow, the mouth, the chin
   *  tip — leads the plate by this, hh. */
  lead: number;
  /** AngleX: the nose leads the plate this many times `lead`. */
  noseDepth: number;
  /** AngleX: the front hair rides the face at this share of its slide. */
  hairFollow: number;
  /** AngleX: the far eye and the far ear narrow to 1 − fore of their width,
   *  the near eye widens to 1 + fore / 2; each eye's and brow's lead scales
   *  with its eye's width. */
  fore: number;
  /** The back hair takes this share of the plate's motion: against it on the
   *  turn, with it on the nod. */
  backShare: number;
  /** AngleX: the far ear's outer edge moves this share of the plate's slide
   *  (the near ear rides the head). */
  earFar: number;
  /** AngleY −30 (looking down): the plate's top drops this far, hh. */
  nodDown: number;
  /** AngleY +30 (looking up): the plate rises this far, whole, hh. */
  nodUp: number;
  /** AngleY: a feature on the face leads the plate's nod at mid-face by this
   *  either way, hh; the nose `noseDepth` times it. */
  nodLead: number;
  /** AngleY −30: the chin drops this share of the plate's top. */
  chinShare: number;
  /** AngleZ ±30 rolls the head this many degrees about the chin. */
  rollDeg: number;
  /** The iris travels this many iris widths sideways, half as far up and
   *  down. */
  gaze: number;
  /** How far the upper lid comes down, over the eye's height. */
  blink: number;
  /** A single mouth drawing opens to this height over its rest width. */
  mouthOpen: number;
  /** The mouth widens to this much of its width open. */
  mouthWiden: number;
  /** A brow raises and lowers this far, hh. */
  brow: number;
  /** A breath lifts the shoulders this far, hh, and the head two thirds of
   *  it. */
  breath: number;
  /** A hair tip travels this far at full sway (±20), hh. */
  sway: number;
  /** At Cheek 0 the blush shows at this opacity; at Cheek 1, as drawn. */
  blushRest: number;
  // The six body values are provisional: our own, to be picked by eye on
  // Bob's full body (full-body slice 3), never a sample's. Each moves the
  // body warp's weight-1 band (`body.ts`), fading to nothing at the hips.
  /** BodyAngleX ±10: the upper body slides this far, hh. Provisional. */
  bodySlide: number;
  /** BodyAngleX ±10: the upper body narrows by this share of its width,
   *  about the body's centre, either way. Provisional. */
  bodyNarrow: number;
  /** BodyAngleY +10: the upper body rises this far, hh; −10 bows it as far.
   *  Provisional. */
  bodyBow: number;
  /** BodyAngleZ ±10 rolls the upper body this many degrees about the hips.
   *  Provisional. */
  bodyRoll: number;
  /** AngleX ±30: the body follows the head's turn at this share of
   *  BodyAngleX ±10. Provisional. */
  bodyFollowX: number;
  /** AngleZ ±30: the body follows the head's tilt at this share of
   *  `bodyRoll`. Provisional. */
  bodyFollowZ: number;
}

/** The values: round numbers picked by eye on our own characters (Bob and
 *  the long-haired one), each against its neighbours on a coarse grid in a
 *  blind A/B judged by a fresh agent and by us (2026-10); `AUTO-RIG.md` has
 *  the record. */
export const PROFILE_VALUES: ProfileValues = {
  slide: 0.12,
  lead: 0.1,
  noseDepth: 2,
  hairFollow: 1,
  fore: 0.2,
  backShare: 0.1,
  earFar: 0.5,
  nodDown: 0.18,
  nodUp: 0.1,
  nodLead: 0.06,
  chinShare: 0.75,
  rollDeg: 14,
  gaze: 0.2,
  blink: 0.6,
  mouthOpen: 0.8,
  mouthWiden: 1.2,
  brow: 0.15,
  breath: 0.03,
  sway: 0.08,
  blushRest: 0.4,
  // Provisional (see `ProfileValues`): not yet picked by eye.
  bodySlide: 0.1,
  bodyNarrow: 0.05,
  bodyBow: 0.06,
  bodyRoll: 4,
  bodyFollowX: 0.3,
  bodyFollowZ: 0.3,
};

/** What the rig reads, derived from `v`. */
export function deriveProfile(v: ProfileValues) {
  const farLead = v.lead * (1 - v.fore / 2);
  const nearLead = v.lead * (1 + v.fore / 2);
  /** AngleX ±30, hh along the turn ("far" = the side the face turns toward). */
  const turn = {
    /** The face plate's translation. */
    face: v.slide,
    /** The chin tip's lead over the plate. */
    chinLead: v.lead,
    /** The plate's width at full turn: eye and cheek rows, then the jaw. The
     *  plate translates; it does not narrow. */
    widthUpper: 1,
    widthJaw: 1,
    eyeFar: v.slide + farLead,
    eyeNear: v.slide + nearLead,
    /** Each eye's width at full turn, about its own centre. */
    eyeFarScale: 1 - v.fore,
    eyeNearScale: 1 + v.fore / 2,
    browFar: v.slide + farLead,
    browNear: v.slide + nearLead,
    nose: v.slide + v.noseDepth * v.lead,
    mouth: v.slide + v.lead,
    mouthWidth: 1,
    /** The mouth's far corner rises (its near end drops) by this much: it
     *  stays level. */
    mouthTiltDeg: 0,
    /** The front hair (bangs and side locks) rides the face at this share of
     *  its translation. */
    hairFollow: v.hairFollow,
    /** The head's outline at the eye row holds: where the front hair draws
     *  it, its outer edge follows the face this much on a row where no back
     *  hair paints behind that edge. Where back hair does, the edge rides
     *  further, as far as that back hair stays behind it through the turn and
     *  the nod, up to the face's follow there (`hairFollow`; over the far
     *  eye's rows, as far as that eye's outer corner goes). On the cap (the
     *  rows above the eyes) it follows less where the turn would otherwise
     *  carry it further outside its back hair than the nod alone does. */
    outlineFollow: 0,
    /** The back hair's slight counter-motion. */
    hairBack: -v.backShare * v.slide,
    /** The ears lag the plate: the far one's outer edge moves this share of
     *  its slide; the near one rides the head. */
    earFar: v.earFar,
    earNear: 1,
    /** The far ear's width at full turn, about its outer edge, where the head
     *  leaves it room; less where it does not. */
    earFarScale: 1 - v.fore,
  };
  // The plate's nod halfway between its top and the chin, looking down.
  const mid = (v.nodDown * (1 + v.chinShare)) / 2;
  const feature = (depth: number) => ({
    up: -(v.nodUp + depth * v.nodLead),
    down: mid + depth * v.nodLead,
  });
  /** AngleY: screen displacement, hh, + = DOWN, at +30 (looking up) and −30
   *  (looking down). */
  const nod = {
    faceTop: { up: -v.nodUp, down: v.nodDown },
    chin: { up: -v.nodUp, down: v.chinShare * v.nodDown },
    eye: feature(1),
    /** Eye height at the extreme, about the eye's centre: it holds. */
    eyeHeight: { up: 1, down: 1 },
    brow: feature(1),
    nose: feature(v.noseDepth),
    mouth: feature(1),
    hairFront: { up: -v.hairFollow * v.nodUp, down: v.hairFollow * v.nodDown },
    /** The front hair's cap top: half the plate's rise looking up; looking
     *  down the plate's top, which the rig slides only as far as the back
     *  hair covers the crown behind it. */
    hairFrontTop: { up: -v.nodUp / 2, down: v.nodDown },
    hairBack: { up: -v.backShare * v.nodUp, down: v.backShare * v.nodDown },
  };
  /** Everything else, at each parameter's extreme. */
  const amplitude = {
    /** Iris travel, in iris widths. */
    gazeX: v.gaze,
    gazeY: v.gaze / 2,
    /** How far the upper lid comes down, over the eye's height. */
    blink: v.blink,
    /** A single mouth drawing opens to this height over its rest width. */
    mouthOpenHeight: v.mouthOpen,
    /** The mouth widens this much open. */
    mouthOpenWidth: v.mouthWiden,
    /** Brow raise / lower, hh. */
    brow: v.brow,
    /** Breath lifts the shoulders and the head, hh. */
    breathBody: v.breath,
    breathHead: (v.breath * 2) / 3,
    /** Hair tip travel at full sway (±20), hh. */
    sway: v.sway,
    /** The blush's opacity at Cheek 0; at Cheek 1 it is as drawn. */
    blushRest: v.blushRest,
    /** The neck under the face reaches this far above the jaw, hh — what the
     *  chin uncovers as it slides off it: half again the chin's full-turn
     *  slide, to the next 0.05. */
    hiddenNeck: Math.ceil(30 * (v.slide + v.lead) - 1e-9) / 20,
  };
  /** The body warp's motions (`body.ts`), each at its parameter's extreme:
   *  BodyAngleX/Y/Z ±10, the follow at AngleX/AngleZ ±30. */
  const body = {
    /** BodyAngleX: the upper body's slide, hh. */
    slide: v.bodySlide,
    /** BodyAngleX: how much narrower the upper body gets, either way. */
    narrow: v.bodyNarrow,
    /** BodyAngleY: the upper body's rise (+) or bow (−), hh. */
    bow: v.bodyBow,
    /** BodyAngleZ: the upper body's roll about the hips, degrees. */
    rollDeg: v.bodyRoll,
    /** AngleX: the body's follow, as a share of BodyAngleX's motion. */
    followX: v.bodyFollowX,
    /** AngleZ: the body's follow, as a share of its roll. */
    followZ: v.bodyFollowZ,
    /** The roll the follow gives the body at AngleZ ±30, degrees: β, the
     *  share of `ROLL_DEG` the head's own roll leaves to the body. */
    followRoll: v.bodyFollowZ * v.bodyRoll,
  };
  return {
    TURN: turn,
    NOD: nod,
    ROLL_DEG: v.rollDeg,
    AMPLITUDE: amplitude,
    BODY: body,
  };
}

export const { TURN, NOD, ROLL_DEG, AMPLITUDE, BODY } =
  deriveProfile(PROFILE_VALUES);

/**
 * Per-character tuning, starting from the profile. `turn`, `featureLead` and
 * `sway` multiply the profile (1 = the profile); `hairFollow`,
 * `outlineFollow` and `blink` replace its value. `AUTO-RIG.md` lists the
 * ranges that read well.
 */
export interface RigStyle {
  /** The whole turn — plate, features and hair. Ignored when a
   *  `turnTargets.eyeShift` is given, which fits it instead. */
  turn?: number;
  /** How far the features lead the plate. */
  featureLead?: number;
  /** The front hair's share of the face's turn. */
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
  /** How far the upper lid comes down, over the eye's height. */
  blink?: number;
  /** Hair sway amplitude. */
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
