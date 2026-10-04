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
  | "body";

export interface RoleSpec {
  role: string;
  family: Family;
  required?: true;
}

/** Back to front. `@ikijs/mcp`'s composer draws in the same order. */
export const ROLE_TABLE: readonly RoleSpec[] = [
  { role: "hair_back", family: "hair_back" },
  { role: "body", family: "body" },
  { role: "face", family: "face", required: true },
  { role: "blush_L", family: "face" },
  { role: "blush_R", family: "face" },
  { role: "nose", family: "nose" },
  { role: "mouth", family: "mouth", required: true },
  { role: "mouth_open", family: "mouth" },
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

/**
 * Map file names to roles. Throws on an unknown role, a role named twice, or
 * a required role (`face`, `eye_L`, `eye_R`, `mouth`) missing.
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
  return out;
}
