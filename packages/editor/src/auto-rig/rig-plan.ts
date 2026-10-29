/**
 * The rig plan: per-character tuning the auto-rig starts from the profile
 * with, validated against one catalog. `RIG_PLAN_FIELDS` is the ONE source of
 * the fields' defaults, ranges, recommended spans, steps and poses —
 * `AUTO-RIG.md`, the MCP tool and the plugin point here.
 */

import { PROFILE_VALUES, deriveProfile, type Profile } from "./profile";
import {
  FORE_PRODUCT_MAX,
  checkedKeys,
  checkedNumber,
  type ResolvedTargets,
  type TurnFit,
} from "./solve";

/** Per-character tuning from the profile's defaults, validated against
 *  `RIG_PLAN_FIELDS`; a field not set is the profile's. */
export interface RigPlan {
  turn?: {
    /** The whole turn — plate, features and hair. */
    amount?: number;
    /** How far the features lead the plate. */
    featureLead?: number;
    /** How far the eyes foreshorten as the head turns (turn only). */
    eyeForeshorten?: number;
    /** How far the nose leads the plate (turn only — the nod keeps the
     *  profile's nose depth). */
    noseLead?: number;
  };
  hair?: {
    /** The front hair's share of the face's turn. */
    follow?: number;
    /** Its outer edge's share, where the front hair draws the head's outline
     *  and no back hair paints behind that edge (0: the outline holds;
     *  `follow` rides it whole). Where back hair does, the edge rides
     *  further, as far as that back hair stays behind it through the turn and
     *  the nod, up to the front hair's follow there (over the far eye's rows,
     *  as far as that eye's outer corner goes). On the cap (the rows above
     *  the eyes) the edge follows less where the turn would otherwise carry
     *  it further outside its back hair than the nod alone does. */
    outlineFollow?: number;
    /** Hair sway amplitude. */
    sway?: number;
  };
  eyes?: {
    /** How far the upper lid comes down, over the eye's height. */
    blink?: number;
  };
}

/** A rig plan a caller passed that is malformed: a non-object, an unknown
 *  group or key, a non-number or a value out of its range. Its message
 *  starts with the field's path (`rigPlan.turn.amount …`). */
export class RigPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RigPlanError";
  }
}

export interface RigPlanField {
  /** `group.key`, as a plan names it. */
  path: string;
  group: string;
  key: string;
  /** `multiplier`: a multiple of the profile's value (1 = the profile).
   *  `absolute`: replaces the profile's value. */
  kind: "multiplier" | "absolute";
  unit: string;
  default: number;
  /** What the rig accepts. */
  range: [number, number];
  /** Where a character's tuning stays: the span that still reads well. */
  recommended: [number, number];
  /** One step is a visible change on the turn renders. */
  step: number;
  /** Parameter settings where the field shows, as `render_poses` takes them. */
  poses: Record<string, number>[];
  /** The report reading that shows the field's effect, or null. */
  cue: string | null;
  /** The `turnTargets` cue that fits the field when given, or null. */
  fitBy: string | null;
  /** Whether the numbers are planner choices not yet picked by an A/B. */
  provisional: boolean;
  /** The removed `style` knob this field replaced, or null. */
  migratedFrom: string | null;
  what: string;
}

const PROFILE = deriveProfile(PROFILE_VALUES);

const TURN_POSES = [
  { ParamAngleX: -30 },
  { ParamAngleX: 30 },
  { ParamAngleX: 15 },
];

export const RIG_PLAN_FIELDS: readonly RigPlanField[] = [
  {
    path: "turn.amount",
    group: "turn",
    key: "amount",
    kind: "multiplier",
    unit: "× the profile's turn",
    default: 1,
    range: [0, 3],
    recommended: [0.7, 1.3],
    step: 0.1,
    poses: TURN_POSES,
    cue: "turn.achieved.eyeShift",
    fitBy: "turnTargets.eyeShift",
    provisional: false,
    migratedFrom: "turn",
    what: "the whole head turn — plate, features, hair and the eyes' foreshortening",
  },
  {
    path: "turn.featureLead",
    group: "turn",
    key: "featureLead",
    kind: "multiplier",
    unit: "× the profile's feature lead",
    default: 1,
    range: [0, 3],
    recommended: [0.6, 1.4],
    step: 0.1,
    poses: TURN_POSES,
    cue: "turn.depths.eye",
    fitBy: null,
    provisional: false,
    migratedFrom: "featureLead",
    what: "how far the features lead the face plate",
  },
  {
    path: "turn.eyeForeshorten",
    group: "turn",
    key: "eyeForeshorten",
    kind: "multiplier",
    unit: "× the profile's eye foreshortening per turn",
    default: 1,
    range: [0, 2],
    recommended: [0.5, 1.5],
    step: 0.25,
    poses: TURN_POSES,
    cue: "turn.achieved.farEyeRatio",
    fitBy: "turnTargets.farEyeRatio",
    provisional: true,
    migratedFrom: null,
    what: "how much the far eye narrows (and the near one widens) as the head turns; amount × eyeForeshorten must stay ≤ 4",
  },
  {
    path: "turn.noseLead",
    group: "turn",
    key: "noseLead",
    kind: "multiplier",
    unit: "× the profile's nose lead over the plate",
    default: 1,
    range: [0, 3],
    recommended: [0.5, 1.5],
    step: 0.25,
    poses: TURN_POSES,
    cue: "turn.depths.nose",
    fitBy: "turnTargets.noseShift",
    provisional: true,
    migratedFrom: null,
    what: "how far the nose leads the face plate on the turn — turn only, the nod keeps the profile's nose depth",
  },
  {
    path: "hair.follow",
    group: "hair",
    key: "follow",
    kind: "absolute",
    unit: "share of the face's turn",
    default: PROFILE.TURN.hairFollow,
    range: [0, 2],
    recommended: [1, 1.2],
    step: 0.1,
    poses: TURN_POSES,
    cue: "turn.achieved.silhouetteRatio",
    fitBy: null,
    provisional: false,
    migratedFrom: "hairFollow",
    what: "the front hair's share of the face's turn",
  },
  {
    path: "hair.outlineFollow",
    group: "hair",
    key: "outlineFollow",
    kind: "absolute",
    unit: "share of the face's turn",
    default: PROFILE.TURN.outlineFollow,
    range: [0, 2],
    recommended: [0, 0],
    step: 0.1,
    poses: TURN_POSES,
    cue: null,
    fitBy: null,
    provisional: false,
    migratedFrom: "outlineFollow",
    what: "the front hair's outer edge's share where it draws the head's outline (0: the outline holds, though where back hair paints behind it, it may ride further, as far as that back hair reaches; at hair.follow the side locks ride whole)",
  },
  {
    path: "hair.sway",
    group: "hair",
    key: "sway",
    kind: "multiplier",
    unit: "× the profile's sway",
    default: 1,
    range: [0, 5],
    recommended: [0.5, 1.5],
    step: 0.25,
    poses: [{ ParamHairSwayX: 20 }, { ParamHairBackSway: 20 }],
    cue: "PHYSICS idle displacement",
    fitBy: null,
    provisional: false,
    migratedFrom: "sway",
    what: "the hair sway amplitude",
  },
  {
    path: "eyes.blink",
    group: "eyes",
    key: "blink",
    kind: "absolute",
    unit: "fraction of the eye's height",
    default: PROFILE.AMPLITUDE.blink,
    range: [0.1, 1],
    recommended: [0.5, 0.7],
    step: 0.05,
    poses: [{ ParamEyeLOpen: 0 }, { ParamEyeROpen: 0 }],
    cue: null,
    fitBy: null,
    provisional: false,
    migratedFrom: "blink",
    what: "how far the upper lid comes down, over the eye's height",
  },
];

export interface ResolvedRigPlan {
  turn: {
    amount: number;
    featureLead: number;
    eyeForeshorten: number;
    noseLead: number;
  };
  hair: { follow: number; outlineFollow: number; sway: number };
  eyes: { blink: number };
  /** The profile, derived once per rig. Its `TURN` reaches `buildTurn` and
   *  its `AMPLITUDE` reaches `buildPart` through here; `fields.ts`,
   *  `drivers.ts`, `body.ts`, `face-mesh.ts` and `types.ts` still read the
   *  module profile (`TURN.earFar`/`earNear`/`mouthTiltDeg`, every `NOD.*`,
   *  `AMPLITUDE.hiddenNeck`, `ROLL_DEG`, `BODY`). */
  profile: Profile;
}

const GROUPS = [...new Set(RIG_PLAN_FIELDS.map((f) => f.group))];
const keysOf = (group: string) =>
  RIG_PLAN_FIELDS.filter((f) => f.group === group).map((f) => f.key);

const span = ([lo, hi]: [number, number]) =>
  lo === hi ? `${lo}` : `${lo}–${hi}`;

/** The plan resolved against the catalog: an absent or empty plan is the
 *  catalog's defaults; anything malformed throws `RigPlanError`. The product
 *  rule `amount × eyeForeshorten ≤ 4` is checked on the plan's structure
 *  before any target is read, so it also refuses a plan whose `amount` an
 *  `eyeShift` target would then override. */
export function resolveRigPlan(plan: unknown): ResolvedRigPlan {
  checkedKeys("rigPlan", plan, GROUPS, RigPlanError);
  const given = (plan ?? {}) as Record<string, unknown>;
  const out: Record<string, Record<string, number>> = {};
  for (const group of GROUPS) {
    checkedKeys(`rigPlan.${group}`, given[group], keysOf(group), RigPlanError);
    const g = (given[group] ?? {}) as Record<string, unknown>;
    out[group] = {};
    for (const f of RIG_PLAN_FIELDS.filter((x) => x.group === group)) {
      const v = g[f.key];
      out[group][f.key] =
        v === undefined
          ? f.default
          : checkedNumber(
              `rigPlan.${f.path}`,
              v,
              f.range[0],
              f.range[1],
              false,
              RigPlanError,
              ` (recommended ${span(f.recommended)})`,
            );
    }
  }
  const { amount, eyeForeshorten } = out.turn;
  if (amount * eyeForeshorten > FORE_PRODUCT_MAX) {
    throw new RigPlanError(
      `rigPlan.turn.eyeForeshorten ${eyeForeshorten} with turn.amount ${amount}: amount × eyeForeshorten must stay ≤ ${FORE_PRODUCT_MAX} (the fit's foreshortening bound)`,
    );
  }
  return {
    ...out,
    profile: deriveProfile(PROFILE_VALUES),
  } as unknown as ResolvedRigPlan;
}

/** The message for a caller still passing the removed `style` input: the
 *  field map, built from the catalog. */
export function styleRemovedMessage(where: string): string {
  const map = RIG_PLAN_FIELDS.filter((f) => f.migratedFrom !== null)
    .map((f) => `style.${f.migratedFrom} is rigPlan.${f.path}`)
    .join(", ");
  return `${where} was removed: pass rigPlan — ${map}`;
}

/** What the rig built with, next to what was asked. */
export interface RigPlanReport {
  /** The plan as passed (`{}` for none). */
  requested: RigPlan;
  /** Every catalog path → the value the rig built with. */
  effective: Record<string, number>;
  /** Plan-owned fields the art's room cut, with the value they stopped at. */
  clamped: { field: string; bound: number }[];
  /** Fields a given `turnTargets` cue fitted instead: path → cue. */
  overriddenBy: Record<string, string>;
}

export function rigPlanReport(
  requested: RigPlan,
  plan: ResolvedRigPlan,
  targets: ResolvedTargets,
  fit: TurnFit,
): RigPlanReport {
  const effective: Record<string, number> = {};
  for (const f of RIG_PLAN_FIELDS) {
    effective[f.path] = (
      plan as unknown as Record<string, Record<string, number>>
    )[f.group][f.key];
  }
  const { params } = fit;
  effective["turn.amount"] = params.turn;
  // The fit and the room clamp rescale `fore` to keep the eyes' own
  // narrowing, so the final `fore` is not the field's value: it is the
  // requested one unless farEyeRatio fitted it.
  if (targets.given.has("farEyeRatio")) {
    const start = targets.given.has("eyeShift") ? 1 : plan.turn.amount;
    if (start !== 0) {
      effective["turn.eyeForeshorten"] = (params.fore * params.turn) / start;
    }
  }
  if (params.nose === undefined) {
    effective["turn.noseLead"] = params.noseLead ?? 1;
  } else {
    const { TURN } = plan.profile;
    const lead =
      params.turn * params.lead * fit.model.frame.hh * (TURN.nose - TURN.face);
    if (lead !== 0) {
      effective["turn.noseLead"] = (params.nose - fit.model.face) / lead;
    }
  }
  const clamped: RigPlanReport["clamped"] = [];
  const overriddenBy: Record<string, string> = {};
  const owned = [
    ["eyeShift", "turn.amount"],
    ["farEyeRatio", "turn.eyeForeshorten"],
    ["noseShift", "turn.noseLead"],
  ] as const;
  for (const [cue, path] of owned) {
    if (targets.given.has(cue)) {
      overriddenBy[path] = `turnTargets.${cue}`;
    } else if ((fit.clamped as string[]).includes(cue)) {
      clamped.push({ field: path, bound: effective[path] });
    }
  }
  return { requested, effective, clamped, overriddenBy };
}
