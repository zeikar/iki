/**
 * The roles a layer set may carry, in draw order (back to front), and the
 * file-name → role parse every host runs before measuring.
 */

/** Which turn family a role rides: each family is baked on its own grid. */
export type Family =
  | "face"
  | "eye_L"
  | "eye_R"
  | "brow_L"
  | "brow_R"
  | "nose"
  | "mouth"
  | "hair_front"
  | "hair_back"
  | "body"
  | "arm"
  | "forearm_pose";

export interface RoleSpec {
  role: string;
  family: Family;
  required?: true;
  /** The part ids the role's layer becomes, back to front; absent, the
   *  role's own id. */
  parts?: readonly string[];
}

/** The lip set's roles, back to front (`mouth.ts`). */
export const LIP_ROLES = ["mouth_inner", "lip_lower", "lip_upper"] as const;
export type LipRole = (typeof LIP_ROLES)[number];

export const isLipRole = (role: string): role is LipRole =>
  (LIP_ROLES as readonly string[]).includes(role);

/** The lip set's optional inside parts, back to front: cut from the interior
 *  and clipped to `mouth_inner` (`mouth.ts`). */
export const LIP_INSIDE_ROLES = ["mouth_tongue", "mouth_teeth"] as const;
export type LipInsideRole = (typeof LIP_INSIDE_ROLES)[number];

export const isLipInsideRole = (role: string): role is LipInsideRole =>
  (LIP_INSIDE_ROLES as readonly string[]).includes(role);

/** Back to front. `@ikijs/mcp`'s composer draws in the same order. */
export const ROLE_TABLE: readonly RoleSpec[] = [
  { role: "hair_back", family: "hair_back" },
  { role: "body", family: "body" },
  { role: "arm_L", family: "arm", parts: ["elbow_L", "arm_L", "forearm_L"] },
  { role: "arm_R", family: "arm", parts: ["elbow_R", "arm_R", "forearm_R"] },
  { role: "face", family: "face", required: true },
  { role: "blush_L", family: "face" },
  { role: "blush_R", family: "face" },
  { role: "nose", family: "nose" },
  { role: "mouth", family: "mouth" },
  { role: "mouth_open", family: "mouth" },
  // The lip set, back to front: the interior, the tongue and the teeth clipped
  // to it, the lower lip's skin, the upper lip and its line over both. It
  // folds open instead of crossfading (`mouth.ts`), so it stands in for
  // `mouth`, never beside it.
  { role: "mouth_inner", family: "mouth" },
  { role: "mouth_tongue", family: "mouth" },
  { role: "mouth_teeth", family: "mouth" },
  { role: "lip_lower", family: "mouth" },
  { role: "lip_upper", family: "mouth" },
  { role: "eye_L", family: "eye_L", required: true },
  { role: "eye_R", family: "eye_R", required: true },
  { role: "iris_L", family: "eye_L" },
  { role: "iris_R", family: "eye_R" },
  { role: "pupil_L", family: "eye_L" },
  { role: "pupil_R", family: "eye_R" },
  { role: "highlight_L", family: "eye_L" },
  { role: "highlight_R", family: "eye_R" },
  { role: "lash_lower_L", family: "eye_L" },
  { role: "lash_lower_R", family: "eye_R" },
  { role: "lash_L", family: "eye_L" },
  { role: "lash_R", family: "eye_R" },
  { role: "brow_L", family: "brow_L" },
  { role: "brow_R", family: "brow_R" },
  { role: "hair_front", family: "hair_front" },
  // Drawn above the face and the hair: a raised hand passes them.
  { role: "forearm_pose_L", family: "forearm_pose" },
  { role: "forearm_pose_R", family: "forearm_pose" },
];

export const REQUIRED_ROLES: readonly string[] = ROLE_TABLE.filter(
  (r) => r.required,
).map((r) => r.role);

const SPEC_BY_ROLE = new Map(ROLE_TABLE.map((r, i) => [r.role, { ...r, i }]));

export function roleSpec(role: string): RoleSpec & { i: number } {
  const spec = SPEC_BY_ROLE.get(role);
  if (spec === undefined) throw new Error(`auto-rig: unknown role "${role}"`);
  return spec;
}

/** The part ids a `role`'s layer becomes, back to front: every one of them
 *  takes its texture from the layer's crop. Throws on an unknown role. */
export function partIdsOfRole(role: string): readonly string[] {
  return roleSpec(role).parts ?? [role];
}

const ROLE_BY_PART = new Map(
  ROLE_TABLE.flatMap((r) => (r.parts ?? []).map((p) => [p, r.role] as const)),
);

/** The role whose layer a part comes from; an id no role lists as a part is
 *  its own role. */
export function roleOfPart(partId: string): string {
  return ROLE_BY_PART.get(partId) ?? partId;
}

/** Spelling variants seen on real layer sets, after the case and separator
 *  normalisation below. */
const ALIASES: Record<string, string> = {
  eyebrow_L: "brow_L",
  eyebrow_R: "brow_R",
  eye_white_L: "eye_L",
  eye_white_R: "eye_R",
};

/** The role a file name names: without its extension, lower-cased, hyphens
 *  and spaces as underscores, a trailing `_l` / `_r` side upper-cased, then
 *  the aliases ("Eye-L.png" → "eye_L", "eyebrow_R.png" → "brow_R"). A PSD
 *  layer name (no extension) names its role the same way. */
function roleOf(fileName: string): string {
  const role = fileName
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[-\s]+/g, "_")
    .replace(/_([lr])$/, (_, s: string) => `_${s.toUpperCase()}`);
  return ALIASES[role] ?? role;
}

/** An arm hangs from the body's shoulder (`arms.ts`): throws on an arm role
 *  among `roles` without a `body`. */
export function checkArmsHaveBody(roles: Iterable<string>): void {
  const has = new Set(roles);
  if (has.has("body")) return;
  const arm = ROLE_TABLE.find((r) => r.family === "arm" && has.has(r.role));
  if (arm !== undefined) {
    throw new Error(
      `auto-rig: ${arm.role} needs a body layer (an arm hangs from the body's shoulder)`,
    );
  }
}

/** The mouth is `mouth` (with an optional `mouth_open`) or the whole lip set
 *  (`mouth.ts`): throws on neither, on part of the set, on both, or on an
 *  inside part without the whole set. */
export function checkMouth(roles: Iterable<string>): void {
  const has = new Set(roles);
  const present = LIP_ROLES.filter((r) => has.has(r));
  const inside = LIP_INSIDE_ROLES.filter((r) => has.has(r));
  if (inside.length > 0 && present.length === 0) {
    throw new Error(
      `auto-rig: ${inside[0]} needs the lip set ${LIP_ROLES.join(", ")} (it is cut from the interior and clipped to it)`,
    );
  }
  if (present.length === 0) {
    if (!has.has("mouth")) {
      throw new Error(
        `auto-rig: missing required role mouth (or the lip set ${LIP_ROLES.join(", ")})`,
      );
    }
    return;
  }
  if (present.length < LIP_ROLES.length) {
    throw new Error(
      `auto-rig: the lip set is partial: missing ${LIP_ROLES.filter((r) => !has.has(r)).join(", ")}`,
    );
  }
  const mixed = ["mouth", "mouth_open"].filter((r) => has.has(r));
  if (mixed.length > 0) {
    throw new Error(
      `auto-rig: the lip set cannot be mixed with ${mixed.join(", ")} (the lip set replaces the mouth drawings; use one or the other)`,
    );
  }
}

/** A pose forearm hangs from its arm's elbow (`forearm-pose.ts`): throws on a
 *  pose forearm role among `roles` without its arm. */
export function checkPosesHaveArms(roles: Iterable<string>): void {
  const has = new Set(roles);
  for (const side of ["L", "R"]) {
    if (has.has(`forearm_pose_${side}`) && !has.has(`arm_${side}`)) {
      throw new Error(
        `auto-rig: forearm_pose_${side} needs an arm_${side} layer (a pose forearm hangs from its arm's elbow)`,
      );
    }
  }
}

/**
 * Map file names to roles. Throws on an unknown role, a role named twice, a
 * required role (`face`, `eye_L`, `eye_R`) missing, no mouth (`mouth`, or the
 * lip set) or a partial or mixed one, a lip set's inside part without the set,
 * an arm without a body, or a pose forearm without its arm.
 */
export function parseLayerRoles(
  fileNames: string[],
): { role: string; fileName: string }[] {
  const seen = new Map<string, string>();
  const out: { role: string; fileName: string }[] = [];
  for (const fileName of fileNames) {
    const role = roleOf(fileName);
    if (!SPEC_BY_ROLE.has(role)) {
      throw new Error(
        `auto-rig: "${fileName}" names no known role (expected one of ${ROLE_TABLE.map((r) => r.role).join(", ")})`,
      );
    }
    const prior = seen.get(role);
    if (prior !== undefined) {
      throw new Error(
        `auto-rig: role "${role}" is named twice ("${prior}" and "${fileName}")`,
      );
    }
    seen.set(role, fileName);
    out.push({ role, fileName });
  }
  const missing = REQUIRED_ROLES.filter((r) => !seen.has(r));
  if (missing.length > 0) {
    throw new Error(
      `auto-rig: missing required role${missing.length > 1 ? "s" : ""} ${missing.join(", ")}`,
    );
  }
  checkMouth(seen.keys());
  checkArmsHaveBody(seen.keys());
  checkPosesHaveArms(seen.keys());
  return out;
}
